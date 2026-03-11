import os
from typing import List, Optional, Sequence

import torch
from config.index import config
from langchain_core.documents import Document
from core.logging import logger
from torch import Tensor
from transformers import AutoModelForSequenceClassification, AutoTokenizer
from utils.search import ChromaDBSearchResultItem

os.environ["TRANSFORMERS_VERBOSITY"] = "error"

# ---------------------------
# 環境/グローバル設定
# ---------------------------
# GPU/CPU selection is based on torch.cuda.is_available().  we also
# provide a fallback env var so someone can force GPU (even when the
# PyTorch build doesn't report CUDA support) – useful for testing or when
# a device shows up later.
FORCE_GPU = os.environ.get("RAG_FORCE_GPU_ONLY", "0").lower() in (
    "1",
    "true",
    "yes",
)
if FORCE_GPU and not torch.cuda.is_available():
    logger.warning(
        "RAG_FORCE_GPU_ONLY set but torch.cuda.is_available() is False; "
        "GPU may be unavailable or PyTorch is CPU‑only."
    )

os.environ.setdefault(
    "TOKENIZERS_PARALLELISM", "true"
)  # 高速化のため並列トークン化を許可（Rustトークナイザー）
os.environ["KMP_DUPLICATE_LIB_OK"] = "True"

MODEL_NAME: str = config.Models.ragRerankModel.name
CACHE_DIR: Optional[str] = config.Models.ragRerankModel.cacheDir
MAX_LENGTH: int = config.RAG.Retrieval.rerankMaxLength
DEFAULT_BSZ_CUDA: int = config.RAG.Retrieval.rerankBatchSize
DEFAULT_BSZ_CPU: int = config.RAG.Retrieval.rerankBatchSizeCPU
USE_COMPILE: bool = config.RAG.Retrieval.rerankUseCompile
USE_8BIT: bool = config.RAG.Retrieval.rerankUse8Bit

device: str = "cuda" if (torch.cuda.is_available() or FORCE_GPU) else "cpu"
if config.RAG.Retrieval.throwErrorWhenCUDAUnavailable and device != "cuda":
    raise RuntimeError(
        "CUDA is not available, if you want to run on CPU, "
        "please set throwErrorWhenCUDAUnavailable to false in the config file."
    )

logger.info(f"Reranker device: {device}")


# ---------------------------
# モデル/トークナイザーの読み込み（エラー処理 & 高速化対応）
# ---------------------------
def _preferred_dtype() -> torch.dtype:
    if device == "cuda":
        if torch.cuda.is_bf16_supported():
            return torch.bfloat16
        return torch.float16
    return torch.float32


_tokenizer = None
_model = None


def _load_tokenizer():
    global _tokenizer
    if _tokenizer is not None:
        return _tokenizer
    logger.info("Loading reranker tokenizer...")
    try:
        _tokenizer = AutoTokenizer.from_pretrained(
            MODEL_NAME,
            cache_dir=CACHE_DIR,
            local_files_only=True,
            use_fast=True,
        )
    except Exception as e:
        logger.warning(f"Local tokenizer load failed: {e}. Falling back to download.")
        _tokenizer = AutoTokenizer.from_pretrained(
            MODEL_NAME,
            cache_dir=CACHE_DIR,
            use_fast=True,
        )
    return _tokenizer


def _load_model():
    global _model
    if _model is not None:
        return _model

    dtype = _preferred_dtype()
    logger.info(f"Loading reranker model (dtype={dtype}, 8bit={USE_8BIT})...")

    def _do_load(local_only: bool):
        if USE_8BIT:
            # 8ビット量化（より省メモリ；大きなモデルでより効果的、小さなモデルでは差は限定的）
            try:
                from transformers import BitsAndBytesConfig

                quant_cfg = BitsAndBytesConfig(load_in_8bit=True)
                m = AutoModelForSequenceClassification.from_pretrained(
                    MODEL_NAME,
                    cache_dir=CACHE_DIR,
                    local_files_only=local_only,
                    low_cpu_mem_usage=True,
                    quantization_config=quant_cfg,
                    device_map="auto",  # 直接GPUに配置
                )
                return m
            except Exception as e:
                logger.warning(f"8-bit load failed ({e}), fallback to non-8bit.")
        # 非量化パス：目標dtypeで直接読み込み
        m = AutoModelForSequenceClassification.from_pretrained(
            MODEL_NAME,
            cache_dir=CACHE_DIR,
            local_files_only=local_only,
            low_cpu_mem_usage=True,
            dtype=dtype if device == "cuda" else torch.float32,
        )
        m.to(device)
        return m

    try:
        _model = _do_load(local_only=True)
    except Exception as e:
        logger.warning(f"Local model load failed: {e}. Downloading from hub...")
        _model = _do_load(local_only=False)

    _model.eval()

    # PyTorch 2コンパイルでスループット向上（注意：初回JITコンパイルで一時的なオーバーヘッドあり；長時間実行/サービス環境で効果的）
    if USE_COMPILE and hasattr(torch, "compile"):
        try:
            _model = torch.compile(_model, mode="max-autotune")
            logger.info("Model compiled with torch.compile.")
        except Exception as e:
            logger.warning(f"torch.compile failed, continue without compile: {e}")

    if device == "cuda":
        # matmulの精度戦略を向上（A100/30xx/40xxで通常有効）
        try:
            torch.set_float32_matmul_precision("high")
        except Exception:
            pass

    logger.info("Reranker model loaded.")
    return _model


# Warm up only when reranking is enabled; this avoids hard startup
# dependency on network/model downloads in local/offline environments.
if config.RAG.Retrieval.usingRerank:
    _tokenizer = _load_tokenizer()
    _model = _load_model()


# ---------------------------
# コア推論関数
# ---------------------------
def _batch_pairs(query: str, passages: Sequence[str], bsz: int):
    """(query, passage)ペアデータをバッチごとにスライス。"""
    n = len(passages)
    for i in range(0, n, bsz):
        yield [(query, passages[j]) for j in range(i, min(i + bsz, n))]


@torch.inference_mode()
def _predict_scores(
    query: str, texts: Sequence[str], max_length: int, batch_size: int
) -> Tensor:
    """バッチごとのtokenization + 推論、shape=[N]のスコアテンソル（torch.sigmoid(logits)）を返す。"""
    tokenizer = _tokenizer or _load_tokenizer()
    model = _model or _load_model()

    scores: List[Tensor] = []
    use_autocast = (device == "cuda") and (
        not USE_8BIT
    )  # 量化モデルは通常autocastが不要

    for pairs in _batch_pairs(query, texts, batch_size):
        inputs = tokenizer(
            pairs,
            padding=True,  # 本バッチ最長までpadding、512全填充を回避
            truncation="only_second",  # 完全なqueryを保持、passageを優先的に切り詰め
            max_length=max_length,
            return_tensors="pt",
        )  # type: ignore

        # 入力を事前にGPUに転送（非同期転送で若干の高速化）
        inputs = {k: v.to(device, non_blocking=True) for k, v in inputs.items()}

        if use_autocast:
            # bf16を優先、次にfp16を選択
            amp_dtype = (
                torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
            )
            with torch.autocast(device_type="cuda", dtype=amp_dtype):
                logits = model(**inputs).logits  # type: ignore
        else:
            logits = model(**inputs).logits  # type: ignore

        # 多くのクロスエンコーダーは二値分類/回帰ヘッド；sigmoidで[0,1]に圧縮
        batch_scores = torch.sigmoid(logits).squeeze(-1)
        scores.append(batch_scores.detach().to("cpu"))

    return torch.cat(scores, dim=0) if scores else torch.empty(0, dtype=torch.float32)


def _guess_batch_size(n: int) -> int:
    """デバイスに応じて比較的安全なbatch sizeを選択、必要に応じて微調整/外部設定可能。"""
    if device == "cuda":
        # 超長文対応時のメモリリスク軽減、サンプル量に応じて若干調整
        base = DEFAULT_BSZ_CUDA
        if n > 256:
            base = max(16, base // 2)
        return base
    else:
        return min(DEFAULT_BSZ_CPU, max(8, int(0.5 * DEFAULT_BSZ_CPU)))


def get_ranked_results(
    query: str, passages: List[ChromaDBSearchResultItem] | List[Document], top_n: Optional[int]
) -> List[ChromaDBSearchResultItem] | List[Document]:
    """
    queryと候補passagesを入力し、関連度降順で並び替えた（またはtop_nを取得した）元のオブジェクトリストを返す。
    """
    if not passages:
        return []
    
    if isinstance(passages[0], Document):
        texts: List[str] = [p.page_content for p in passages]  # type: ignore
    elif isinstance(passages[0], ChromaDBSearchResultItem):
        texts: List[str] = [p.content for p in passages]  # type: ignore

    bsz = _guess_batch_size(len(texts))
    scores: Tensor = _predict_scores(query, texts, MAX_LENGTH, bsz)  # shape=[N]

    if scores.numel() != len(passages):
        logger.error("Score/Passage length mismatch. Fallback to original order.")
        return passages[: top_n or len(passages)]

    n = scores.shape[0]
    if top_n is not None and 0 < top_n < n:
        # 前K件のみ取得、全要素ソートのO(N log N)オーバーヘッドを回避
        topk_scores, topk_idx = torch.topk(scores, k=top_n, largest=True, sorted=True)
        ranked = [passages[int(i)] for i in topk_idx.tolist()]
    else:
        # 完全ソートが必要
        sorted_idx = torch.argsort(scores, descending=True)
        ranked = [passages[int(i)] for i in sorted_idx.tolist()]

    return ranked  # type: ignore
