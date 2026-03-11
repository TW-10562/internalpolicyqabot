# 条項ベースでPDF文書を分割する処理のためのAPIモジュール
import io
import json
import os
import re
import uuid
from dataclasses import asdict, dataclass
from typing import Iterator, Optional

import fitz
import jaconv
import numpy as np
from PyPDF2 import PdfReader
from config.index import config
from core.logging import logger
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from models.schemas import ArticleBasedSplitRecordMetadataModel, UploadFileResultModel
from repositories.chroma_repository import chroma_db
from services.embedder import embed_text_batch

router = APIRouter()


@dataclass
class DocumentMetadata:
    """文書のメタデータ情報を格納するデータクラス"""

    DocumentName: str
    DocumentStandardNumber: Optional[str] = None
    ResponsibleDepartment: Optional[str] = None
    Established: Optional[str] = None
    LastRevised: Optional[str] = None


@dataclass
class Article:
    """条項の情報を格納するデータクラス"""

    ChapterNumber: Optional[int]
    ChapterName: Optional[str]
    SectionNumber: Optional[int]
    SectionName: Optional[str]
    ArticleName: str
    ArticleNumber: int
    TextContent: str

    def to_dict(self, metadata: DocumentMetadata) -> dict:
        """メタデータと条項情報を統合した辞書を返す"""
        return {**asdict(metadata), **asdict(self)}


class RegexPatterns:
    """文書解析用の正規表現パターンを定義するクラス"""

    # 章のパターン（例：第1章、第２章）
    CHAPTER = re.compile(r"^第([0-9０-９]+)[ 　]*章[ 　\n]*(.*)?")
    # 節のパターン（例：第1節、第２節）
    SECTION = re.compile(r"^第([0-9０-９]+)[ 　]*節[ 　\n]*(.*)?")
    # 条項名のパターン（例：（目的））
    ARTICLE_NAME = re.compile(r"^（(?P<name>[^）]+)）$")
    # 条項番号のパターン（例：第1条、第２条）
    ARTICLE_NUM = re.compile(r"^第[ 　]*([0-9０-９]+)[ 　]*条[ 　]*(.*)?")

    # 項のパターン
    CLAUSE_PATTERNS = [
        re.compile(r"^（[0-9０-９]+）"),
        re.compile(r"^[\u3000 ]*[0-9０-９]+[\u3000 ．\.、\)]"),
    ]

    # 附則のパターン
    APPENDIX_PATTERNS = [
        re.compile(r"^附\s*則"),
        re.compile(r"^附\s*$"),
    ]

    # メタデータ抽出用のパターン
    META_PATTERNS = {
        "DocumentStandardNumber": re.compile(
            r"標準番号\s+(?P<v>[０-９0-9ー－\-]+)(?:\n|$)"
        ),
        "ResponsibleDepartment": re.compile(r"主管部署\s+(?P<v>.+?)(?:\n|$)"),
        "Established": re.compile(r"制\s*定\s+(?P<v>[ 　０-９0-9年月日]+)(?:\n|$)"),
        "LastRevised": re.compile(r"最終改定\s+(?P<v>[ 　０-９0-9年月日]+)(?:\n|$)"),
    }

    # 項番号のパターン
    ITEM_NUMBER = re.compile(r"\n([０-９0-9]+)[ 　]+")


class TextProcessor:
    """テキスト処理用のユーティリティクラス"""

    # 漢数字から数値への変換マップ
    KANJI_TO_NUM = {
        "一": 1,
        "二": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
        "十": 10,
        "百": 100,
    }

    @staticmethod
    def zen_to_han(text: str) -> str:
        """全角文字を半角文字に変換"""
        # zenkaku = "！＂＃＄％＆＇（）＊＋，－．／０１２３４５６７８９：；＜＝＞？＠ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ［＼］＾＿｀ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ｛｜｝～"
        # hankaku = "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"
        # trans = str.maketrans(zenkaku, hankaku)
        # return text.translate(trans)
        return jaconv.z2h(text, kana=False, digit=True, ascii=True)

    @staticmethod
    def clean_line(text: str) -> str:
        """行の末尾の空白文字を削除"""
        return re.sub(r"[ \t]+$", "", text.strip())

    @staticmethod
    def extract_number(text: str) -> Optional[int]:
        """テキストから数値を抽出（漢数字対応）"""
        text = TextProcessor.zen_to_han(text)

        if text.isdigit():
            return int(text)

        # 漢数字から数値への変換処理
        total = 0
        current = 0
        for char in text:
            if char in ("十", "百"):
                base = 10 if char == "十" else 100
                total += (current or 1) * base
                current = 0
            else:
                current = TextProcessor.KANJI_TO_NUM.get(char, 0)

        result = total + current
        return result if result > 0 else None

    @staticmethod
    def is_clause_line(line: str) -> bool:
        """項かどうかを判定"""
        return any(pattern.match(line) for pattern in RegexPatterns.CLAUSE_PATTERNS)

    @staticmethod
    def is_appendix_line(line: str) -> bool:
        """附則かどうかを判定"""
        if any(pattern.match(line) for pattern in RegexPatterns.APPENDIX_PATTERNS):
            return True
        return "附則" in line or "附 則" in line

    @staticmethod
    def normalize_item_markers(text: str) -> str:
        """項番号を正規化"""

        def replace_item(match):
            try:
                num = int(TextProcessor.zen_to_han(match.group(1)))
                return f"\n[第{num}項]  " if num else match.group(0)
            except (ValueError, KeyError):
                return match.group(0)

        return RegexPatterns.ITEM_NUMBER.sub(replace_item, text)


class PDFExtractor:
    """PDFからテキストを抽出するクラス"""

    COVER_PHRASE = "下記の標準が登録（制定・改定・廃止）されましたので公布いたします"

    def __init__(
        self, pdf_bytes: bytes, start_page: int = -1, footer_ratio: float = 0.92
    ):
        self.pdf_bytes = pdf_bytes
        self.start_page = start_page
        self.footer_ratio = footer_ratio

    def extract_lines(self) -> Iterator[tuple[int, float, str]]:
        """PDFから行単位でテキストを抽出"""
        try:
            doc = fitz.open(stream=self.pdf_bytes, filetype="pdf")  # type: ignore
        except Exception as e:
            raise ValueError(f"PDF の読み込みに失敗しました: {e}")

        if not doc or doc.page_count == 0:
            raise ValueError("PDF ドキュメントが空です。")

        # 表紙ページの有無を自動判定
        if self.start_page < 0:
            self.start_page = int(self.has_cover(doc[0].get_text()))  # type: ignore

        try:
            for page_index in range(self.start_page, len(doc)):
                page = doc[page_index]
                # フッター領域を除外するためのY座標閾値
                y_cutoff = page.rect.height * self.footer_ratio
                blocks = page.get_text("blocks")  # type: ignore

                # ブロックをY座標、X座標順でソート
                blocks.sort(key=lambda b: (round(b[1], 1), round(b[0], 1)))  # type: ignore

                for x0, y0, x1, y1, text, *_ in blocks:
                    if y0 >= y_cutoff:  # フッター領域は無視
                        continue

                    for raw_line in text.splitlines():
                        cleaned = TextProcessor.clean_line(raw_line)
                        if cleaned:
                            yield (page_index + 1, y0, cleaned)  # type: ignore
        finally:
            doc.close()

    def has_cover(self, first_page_content: str) -> bool:
        """最初のページが表紙かどうかを判定"""
        _has = PDFExtractor.COVER_PHRASE in first_page_content
        logger.debug(f"PDF cover page detected: {_has}")
        return _has


class MetadataExtractor:
    """文書メタデータを抽出するクラス"""

    @staticmethod
    def extract(
        lines: list[tuple[int, float, str]], doc_name: str, scan_lines: int = 100
    ) -> DocumentMetadata:
        """文書の最初の部分からメタデータを抽出"""
        meta_text = "\n".join(line for _, _, line in lines[:scan_lines])
        metadata = DocumentMetadata(DocumentName=doc_name)

        # 各メタデータパターンに対してマッチングを実行
        for field_name, pattern in RegexPatterns.META_PATTERNS.items():
            match = pattern.search(meta_text)
            if match:
                value = match.group("v").strip()

                # 制定日・改定日の場合は空白を除去し半角変換
                if field_name in ("Established", "LastRevised"):
                    value = re.sub(r"[ ]+", "", value)
                    value = TextProcessor.zen_to_han(value)

                setattr(
                    metadata,
                    field_name,
                    jaconv.z2h(value, kana=False, digit=True, ascii=True),
                )

        logger.debug(f"Extracted metadata: \n{metadata}")
        return metadata


class DocumentParser:
    """文書を章・節・条項に分割して解析するクラス"""

    def __init__(self, metadata: DocumentMetadata):
        self.metadata = metadata
        self.sections: list[Article] = []

        # 現在の章・節・条項の情報
        self.current_chapter_no: Optional[int] = None
        self.current_chapter_name: Optional[str] = None
        self.current_section_no: Optional[int] = None
        self.current_section_name: Optional[str] = None
        self.pending_article_name: Optional[str] = None
        self.current_article_no: Optional[int] = None
        self.is_collecting = False
        self.text_chunks: list[str] = []

        # 附則処理用の状態管理
        self.found_appendix = False
        self.pending_appendix_line: Optional[str] = None

        # 保留中の章・節番号
        self.pending_chapter_no: Optional[int] = None
        self.pending_section_no: Optional[int] = None

        self.chapter_has_sections = False

    def parse_lines(self, lines: list[tuple[int, float, str]]) -> list[dict[str, str]]:
        """行を解析して条項リストを生成"""
        for page_no, y_pos, line in lines:
            if self._check_appendix(line):  # 附則に到達したら処理終了
                break
            self._process_line(line)

        self._flush_section()  # 最後の条項を保存

        return [section.to_dict(self.metadata) for section in self.sections]

    def _check_appendix(self, line: str) -> bool:
        """附則の開始を検出"""
        if self.pending_appendix_line:
            combined_line = self.pending_appendix_line + line
            if "則" in line or TextProcessor.is_appendix_line(combined_line):
                self.found_appendix = True
                return True
            self.pending_appendix_line = None

        if TextProcessor.is_appendix_line(line):
            self.found_appendix = True
            return True

        if line.strip() == "附":
            self.pending_appendix_line = line
            return False

        return False

    def _process_line(self, line: str):
        """各行を解析して適切な処理を実行"""
        # 保留中の章番号がある場合の処理
        if self.pending_chapter_no is not None:
            if not (
                RegexPatterns.CHAPTER.match(line)
                or RegexPatterns.SECTION.match(line)
                or RegexPatterns.ARTICLE_NAME.match(line)
                or RegexPatterns.ARTICLE_NUM.match(line)
            ):
                self._set_chapter(self.pending_chapter_no, line.strip())
                self.pending_chapter_no = None
                return
            else:
                self._set_chapter(self.pending_chapter_no, None)
                self.pending_chapter_no = None

        # 保留中の節番号がある場合の処理
        if self.pending_section_no is not None:
            if not (
                RegexPatterns.CHAPTER.match(line)
                or RegexPatterns.SECTION.match(line)
                or RegexPatterns.ARTICLE_NAME.match(line)
                or RegexPatterns.ARTICLE_NUM.match(line)
            ):
                self._set_section(self.pending_section_no, line.strip())
                self.pending_section_no = None
                return
            else:
                self._set_section(self.pending_section_no, None)
                self.pending_section_no = None

        # 各種パターンのマッチング
        if self._try_match_chapter(line):
            return

        if self._try_match_section(line):
            return

        if self._try_match_article_name(line):
            return

        if self._try_match_article_num(line):
            return

        # 条項収集中で項の場合はテキストに追加
        if self.is_collecting and TextProcessor.is_clause_line(line):
            self.text_chunks.append(line)
            return

        # 条項収集中の場合はテキストに追加
        if self.is_collecting:
            self.text_chunks.append(line)

    def _try_match_chapter(self, line: str) -> bool:
        """章のパターンマッチング"""
        match = RegexPatterns.CHAPTER.match(line)
        if not match:
            return False

        self._flush_section()

        chapter_num_str = match.group(1)
        chapter_name = (match.group(2) or "").strip() or None
        chapter_no = TextProcessor.extract_number(chapter_num_str)

        if chapter_name:
            self._set_chapter(chapter_no, chapter_name)
        else:
            self.pending_chapter_no = chapter_no

        return True

    def _set_chapter(self, chapter_no: Optional[int], chapter_name: Optional[str]):
        """章情報を設定"""
        # 節がある章で節名がない場合、保留中の条項名を節名とする
        if (
            self.pending_article_name
            and self.chapter_has_sections
            and not self.current_section_name
        ):
            self.current_section_name = self.pending_article_name

        self.pending_article_name = None

        self.current_chapter_no = chapter_no
        self.current_chapter_name = chapter_name
        self.current_section_no = None
        self.current_section_name = None
        self.current_article_no = None
        self.chapter_has_sections = False

    def _try_match_section(self, line: str) -> bool:
        """節のパターンマッチング"""
        match = RegexPatterns.SECTION.match(line)
        if not match:
            return False

        self._flush_section()

        section_num_str = match.group(1)
        section_name = (match.group(2) or "").strip() or None
        section_no = TextProcessor.extract_number(section_num_str)

        if section_name:
            self._set_section(section_no, section_name)
        else:
            self.pending_section_no = section_no

        self.chapter_has_sections = True

        return True

    def _set_section(self, section_no: Optional[int], section_name: Optional[str]):
        """節情報を設定"""
        self.pending_article_name = None

        self.current_section_no = section_no
        self.current_section_name = section_name
        self.current_article_no = None
        self.is_collecting = False

    def _try_match_article_name(self, line: str) -> bool:
        """条項名のパターンマッチング"""
        match = RegexPatterns.ARTICLE_NAME.match(line)
        if not match:
            return False

        self.pending_article_name = match.group("name").strip()
        return True

    def _try_match_article_num(self, line: str) -> bool:
        """条項番号のパターンマッチング"""
        match = RegexPatterns.ARTICLE_NUM.match(line)
        if not match:
            return False

        self._flush_section()

        article_num_str = match.group(1)
        self.current_article_no = int(TextProcessor.zen_to_han(article_num_str))

        # 条項名の設定
        if self.pending_article_name:
            article_name = self.pending_article_name
            self.pending_article_name = None
        else:
            article_name = f"第{article_num_str}条"

        # 条文の残り部分を第1項として設定
        tail = (match.group(2) or "").strip()
        first_item = f"[第1項]  {tail}" if tail else "[第1項]  "
        self.text_chunks.append(first_item)
        self.is_collecting = True

        self.current_article_name = article_name

        return True

    def _flush_section(self):
        """現在の条項を保存"""
        # 保留中の章・節があれば設定
        if self.pending_chapter_no is not None:
            self._set_chapter(self.pending_chapter_no, None)
            self.pending_chapter_no = None

        if self.pending_section_no is not None:
            self._set_section(self.pending_section_no, None)
            self.pending_section_no = None

        # 条項データがある場合は保存
        if (
            hasattr(self, "current_article_name")
            and self.current_article_name
            and self.current_article_no
            and self.text_chunks
        ):
            raw_content = "\n".join(self.text_chunks).strip()
            normalized_content = TextProcessor.normalize_item_markers(raw_content)

            section = Article(
                ChapterNumber=self.current_chapter_no,
                ChapterName=self.current_chapter_name,
                SectionNumber=self.current_section_no,
                SectionName=self.current_section_name,
                ArticleName=self.current_article_name,
                ArticleNumber=self.current_article_no,
                TextContent=normalized_content,
            )
            self.sections.append(section)

        # 状態をリセット
        self.text_chunks.clear()
        if hasattr(self, "current_article_name"):
            self.current_article_name = None
        self.current_article_no = None


def parse_document_by_content(pdf_bytes: bytes, doc_name: str) -> list[dict[str, str]]:
    """PDF文書をバイト列から解析して条項リストを生成"""
    extractor = PDFExtractor(
        pdf_bytes, footer_ratio=config.RAG.PreProcess.PDF.splitByArticle.footerRatio
    )
    try:
        lines = list(extractor.extract_lines())
    except Exception as e:
        logger.warning(f"Primary PDF line extraction failed: {e}")
        lines = []

    if not lines:
        lines = _extract_lines_with_text_fallback(pdf_bytes)
    if not lines:
        return []

    metadata = MetadataExtractor.extract(lines, doc_name)

    parser = DocumentParser(metadata)
    articles = parser.parse_lines(lines)
    if articles:
        return articles

    # Fallback for non-regulation style documents:
    # if text exists but chapter/section/article parsing finds nothing,
    # create pseudo-article chunks to keep the document searchable.
    logger.info(
        "No structured articles detected. Falling back to generic page chunks."
    )
    return _build_generic_articles(lines, metadata)


def _extract_lines_with_text_fallback(pdf_bytes: bytes) -> list[tuple[int, float, str]]:
    """Fallback extractor for PDFs that do not yield block-level lines."""
    lines: list[tuple[int, float, str]] = []

    # 1) Try PyMuPDF page text mode.
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")  # type: ignore
        try:
            for page_index, page in enumerate(doc):
                text = page.get_text("text")  # type: ignore
                if not text or not text.strip():
                    continue
                for raw in text.splitlines():
                    cleaned = TextProcessor.clean_line(raw)
                    if cleaned:
                        lines.append((page_index + 1, 0.0, cleaned))
        finally:
            doc.close()
    except Exception as e:
        logger.warning(f"PyMuPDF text fallback failed: {e}")

    if lines:
        return lines

    # 2) Try PyPDF2 text extraction as a second fallback.
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        for page_index, page in enumerate(reader.pages):
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            if not text.strip():
                continue
            for raw in text.splitlines():
                cleaned = TextProcessor.clean_line(raw)
                if cleaned:
                    lines.append((page_index + 1, 0.0, cleaned))
    except Exception as e:
        logger.warning(f"PyPDF2 text fallback failed: {e}")

    if lines:
        return lines

    # 3) OCR fallback (for scanned PDFs).
    # This is intentionally last because OCR is much slower.
    if str(os.environ.get("RAG_ENABLE_OCR_FALLBACK", "1")).lower() in (
        "1",
        "true",
        "yes",
    ):
        ocr_lang = str(os.environ.get("RAG_OCR_LANGUAGE", "jpn+eng")).strip() or "jpn+eng"
        ocr_dpi = max(120, int(os.environ.get("RAG_OCR_DPI", "250")))
        ocr_max_pages = max(1, int(os.environ.get("RAG_OCR_MAX_PAGES", "500")))
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")  # type: ignore
            try:
                ocr_page_count = min(len(doc), ocr_max_pages)
                for page_index in range(ocr_page_count):
                    page = doc[page_index]
                    try:
                        text_page = page.get_textpage_ocr(  # type: ignore[attr-defined]
                            language=ocr_lang,
                            dpi=ocr_dpi,
                        )
                        text = page.get_text("text", textpage=text_page)  # type: ignore
                    except Exception:
                        text = ""

                    if not text or not text.strip():
                        continue
                    for raw in text.splitlines():
                        cleaned = TextProcessor.clean_line(raw)
                        if cleaned:
                            lines.append((page_index + 1, 0.0, cleaned))
            finally:
                doc.close()
            if lines:
                logger.info(
                    f"OCR fallback succeeded: extracted lines={len(lines)}, lang={ocr_lang}, dpi={ocr_dpi}"
                )
        except Exception as e:
            logger.warning(f"OCR fallback failed: {e}")

    return lines


def _build_generic_articles(
    lines: list[tuple[int, float, str]],
    metadata: DocumentMetadata,
    chunk_size: int = 1200,
    overlap: int = 200,
) -> list[dict[str, str]]:
    """Create pseudo-article chunks for text-heavy manuals and guides."""
    by_page: dict[int, list[str]] = {}
    for page_no, _y_pos, line in lines:
        by_page.setdefault(int(page_no), []).append(line)

    page_texts: list[tuple[int, str]] = []
    for page_no in sorted(by_page.keys()):
        merged = "\n".join(by_page[page_no]).strip()
        if merged:
            page_texts.append((page_no, merged))

    if not page_texts:
        return []

    generic_articles: list[dict[str, str]] = []
    fallback_index = 1
    effective_overlap = max(0, min(overlap, chunk_size // 2))

    for page_no, page_text in page_texts:
        normalized = TextProcessor.normalize_item_markers(page_text)
        if len(normalized) <= chunk_size:
            generic_articles.append(
                {
                    "DocumentName": metadata.DocumentName,
                    "DocumentStandardNumber": metadata.DocumentStandardNumber,
                    "ResponsibleDepartment": metadata.ResponsibleDepartment,
                    "Established": metadata.Established,
                    "LastRevised": metadata.LastRevised,
                    "ChapterNumber": None,
                    "ChapterName": None,
                    "SectionNumber": None,
                    "SectionName": None,
                    "ArticleName": f"抽出テキスト p.{page_no}",
                    "ArticleNumber": fallback_index,
                    "TextContent": normalized,
                }
            )
            fallback_index += 1
            continue

        step = max(1, chunk_size - effective_overlap)
        start = 0
        while start < len(normalized):
            chunk = normalized[start : start + chunk_size].strip()
            if chunk:
                generic_articles.append(
                    {
                        "DocumentName": metadata.DocumentName,
                        "DocumentStandardNumber": metadata.DocumentStandardNumber,
                        "ResponsibleDepartment": metadata.ResponsibleDepartment,
                        "Established": metadata.Established,
                        "LastRevised": metadata.LastRevised,
                        "ChapterNumber": None,
                        "ChapterName": None,
                        "SectionNumber": None,
                        "SectionName": None,
                        "ArticleName": f"抽出テキスト p.{page_no} #{fallback_index}",
                        "ArticleNumber": fallback_index,
                        "TextContent": chunk,
                    }
                )
                fallback_index += 1
            start += step

    logger.info(f"Generic fallback chunks created: {len(generic_articles)}")
    return generic_articles


@router.post("/upload/split-by-article", response_model=UploadFileResultModel)
async def upload_file_split_by_article(
    collection_name: str = Form(...),
    file: UploadFile = File(...),
    file_original_name: Optional[str] = Form(None),
    extra_metadata: str = Form(...),
):
    """条項ベースでPDFファイルを分割してアップロードするAPI"""
    if not file.filename:
        raise HTTPException(status_code=400, detail="ファイル名が提供されていません。")

    logger.info(
        f"splitByArticle_api called, {collection_name=}, file_name={file.filename}"
    )

    # ファイル拡張子の検証
    ext = file.filename.lower().split(".")[-1] or ""
    if not ext:
        raise HTTPException(
            status_code=400, detail="ファイル拡張子が提供されていません。"
        )
    if ext != "pdf":
        raise HTTPException(
            status_code=400,
            detail=f"条項によりの文書処理は PDF ファイルのみ対応しています、アプロードするファイル形式: {ext}。",
        )

    try:
        extra_metadata_data = (
            json.loads(extra_metadata, parse_int=str)
            if extra_metadata
            else {}
        )
    except json.JSONDecodeError as e:
        extra_metadata_data = {}

    try:
        logger.info("Reading file content...")
        content = await file.read()
        file_name = (
            file_original_name
            if file_original_name
            else file.filename[: file.filename.rfind(".")]
        )

        # PDF文書を解析して条項リストを生成
        articles = parse_document_by_content(content, file_name)
        if not articles or len(articles) == 0:
            raise HTTPException(
                status_code=400, detail="テキストが抽出できませんでした。"
            )

        # 有効な条項のみを抽出
        valid_articles = []
        text_contents = []

        for article in articles:
            text_content = article.get("TextContent", "")
            if text_content and text_content.strip():
                article_copy = article.copy()
                article_copy.pop(
                    "TextContent", None
                )  # テキスト内容はメタデータから除外
                valid_articles.append(article_copy)
                text_contents.append(text_content)

        if not valid_articles:
            raise HTTPException(
                status_code=400, detail="テキストが抽出できませんでした。"
            )

        logger.debug(f"Samples: {articles[0:3]}")
        logger.info(f"Processing {len(valid_articles)} valid articles...")

        # Chromaデータベース用のドキュメントとメタデータを準備
        documents = []
        metadatas = []

        metadata_models = [
            ArticleBasedSplitRecordMetadataModel(**article)
            for article in valid_articles
        ]

        for i, metadata_model in enumerate(metadata_models):
            # 階層ラベル + テキスト内容をドキュメントとして設定
            documents.append(
                f"{metadata_model.build_hierarchy_label()}\n\n{text_contents[i]}"
            )
            metadatas.append(
                {
                    **metadata_model.to_dict(),
                    **extra_metadata_data,
                }
            )

        # テキストの埋め込みベクトルを生成
        logger.info(f"Generating embeddings for {len(text_contents)} articles...")
        embeddings = embed_text_batch(text_contents)
        # transform into ndarray[Any, dtype[int32 | float32]]
        embeddings = np.array(embeddings, dtype=np.float32)

        # Chromaデータベースに保存
        chroma_db.get_or_create_collection(name=collection_name).add(
            ids=[str(uuid.uuid4()) for _ in range(len(documents))],
            documents=documents,
            embeddings=embeddings,
            metadatas=metadatas,
        )

        return UploadFileResultModel(
            status="uploaded",
            count=len(documents),
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
