from typing import Dict, List, Literal, Optional
from typing_extensions import Self
from core.logging import logger
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


class SearchRequest(BaseModel):
    collection_name: list[str]
    query: str
    top_k: int = 3
    mode: str = "default"


class BM25Params(BaseModel):
    k1: float = 1.8  # typical values are between 1.2 and 2.0
    b: float = 0.75  # typical values are between 0 and 1


class HybridSearchRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    collection_name: str = Field(..., description="List of collection names to search")
    query: str = Field(..., description="The search query string")
    top_k: int = Field(default=10, description="Number of top results to return")
    vector_only: Optional[bool] = Field(
        default=False, description="If true, use only vector similarity for search"
    )
    bm25_only: Optional[bool] = Field(
        default=False, description="If true, use only BM25 relevance for search"
    )
    vector_weight: float = Field(
        default=0.5,
        description="Weight for vector similarity in hybrid search (0.0 to 1.0)",
        ge=0.0,
        le=1.0,
    )
    bm25_weight: float = Field(
        default=0.5,
        description="Weight for BM25 relevance in hybrid search (0.0 to 1.0)",
        ge=0.0,
        le=1.0,
    )
    bm25_params: Optional[BM25Params] = Field(
        default=None,
        description="Parameters for BM25 ranking algorithm",
    )
    metadata_filters: Optional[Dict[str, object]] = Field(
        default=None,
        description="Optional metadata equality/in filters applied before retrieval.",
    )
    candidate_file_ids: Optional[List[str]] = Field(
        default=None,
        description="Optional candidate file ids (storage keys) used for pre-filtering.",
    )

    @model_validator(mode="after")
    def validate_search_params(self) -> Self:
        if self.vector_only and self.bm25_only:
            raise ValidationError("vector_only and bm25_only cannot both be true.")

        if not self.vector_only and not self.bm25_only:
            if (total_weight := (self.vector_weight + self.bm25_weight)) != 1.0:
                raise ValidationError(
                    f"The sum of vector_weight and bm25_weight must be 1.0, got {total_weight}."
                )

        if (
            self.vector_only
            and not self.bm25_only
            and (self.vector_weight != 1.0 and self.bm25_weight != 0.0)
        ):
            self.vector_weight = 1.0
            self.bm25_weight = 0.0

        if (
            self.bm25_only
            and not self.vector_only
            and (self.vector_weight != 0.0 and self.bm25_weight != 1.0)
        ):
            self.vector_weight = 0.0
            self.bm25_weight = 1.0

        if not self.vector_only:
            if self.bm25_params is None:
                self.bm25_params = BM25Params()
                logger.info(
                    f"BM25 parameters not provided, using default values {self.bm25_params.model_dump()}"
                )
        return self


class DeleteRequest(BaseModel):
    collection_name: str
    ids: Optional[List[str]] = None


class DeleteResponseModel(BaseModel):
    status: Literal["deleted", "no match", "failed"]
    collection: str
    deleted_records: Optional[List[str]] = None

class UpdateRequest(BaseModel):
    collection_name: str
    ids: List[str]
    documents: List[str]
    metadatas: Optional[List[Dict]] = None


class ArticleBasedSplitRecordMetadataModel(BaseModel):
    """
    Metadata schema for article-based split records from IJTT's structured PDF file.
    ChromaDB does not support None or empty string values in metadata,
    so all fields with None or empty string values will be converted to the string "<|None|>".
    """
    model_config = ConfigDict(extra="allow")

    DocumentName: Optional[str] = None
    DocumentStandardNumber: Optional[str] = None
    ResponsibleDepartment: Optional[str] = None
    Established: Optional[str] = None
    LastRevised: Optional[str] = None
    ChapterNumber: Optional[int | str] = None
    ChapterName: Optional[str] = None
    SectionNumber: Optional[int | str] = None
    SectionName: Optional[str] = None
    ArticleName: Optional[str] = None
    ArticleNumber: Optional[int | str] = None

    def to_dict(self) -> Dict[str, str]:
        def _none_guard(v: str | None) -> str:
            if v is None:
                return "<|None|>"
            s = str(v).strip()
            return s if s else "<|None|>"

        raw_dict = self.model_dump(exclude_none=False)
        return {k: _none_guard(v) for k, v in raw_dict.items()}

    def build_hierarchy_label(self) -> str:
        md = self.to_dict()
        doc_name = md.get("DocumentName")

        if doc_name and doc_name != "<|None|>":
            title = doc_name

        ch_n = md.get("ChapterNumber")
        ch_nm = md.get("ChapterName")
        chapter = ""
        if ch_n is not None and ch_n != "<|None|>":
            chapter = f"第{ch_n}章" + (
                f"  {ch_nm}" if ch_nm and ch_nm != "<|None|>" else ""
            )
        elif ch_nm and ch_nm != "<|None|>":
            chapter = ch_nm

        sec_n = md.get("SectionNumber")
        sec_nm = md.get("SectionName")
        section = ""
        if sec_n is not None and sec_n != "<|None|>":
            section = f"第{sec_n}節" + (
                f" {sec_nm}" if sec_nm and sec_nm != "<|None|>" else ""
            )
        elif sec_nm and sec_nm != "<|None|>":
            section = sec_nm

        art_n = md.get("ArticleNumber")
        art_nm = md.get("ArticleName")
        article = ""
        if art_n is not None and art_n != "<|None|>":
            article = f"第{art_n}条" + (
                f" {art_nm}" if art_nm and art_nm != "<|None|>" else ""
            )
        elif art_nm and art_nm != "<|None|>":
            article = art_nm

        parts = [p for p in (chapter, section, article) if p]
        if title and parts:
            return f"{title}  / " + " / ".join(parts)
        elif title:
            return title
        else:
            return " / ".join(parts)


class UploadFileResultModel(BaseModel):
    status: Literal["uploaded", "failed"]
    count: int
