import os
from functools import lru_cache
from pathlib import Path
from time import perf_counter
from typing import List

import torch
from core.logging import logger

# GPU configuration -------------------------------------------------------
# legacy environment variable support (user exported it earlier but code
# didn't honour it)
FORCE_GPU = os.environ.get("RAG_FORCE_GPU_ONLY", "0").lower() in (
    "1",
    "true",
    "yes",
)
if FORCE_GPU and not torch.cuda.is_available():
    logger.warning(
        "RAG_FORCE_GPU_ONLY is set but torch.cuda.is_available() is False; "
        "PyTorch may not have been built with CUDA or GPU is not visible."
    )


import jaconv
from config.index import config
from config.schema import HFModelConfig, OllamaModelConfig
from huggingface_hub import snapshot_download
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_ollama import OllamaEmbeddings

CUDA_AVAILABLE = torch.cuda.is_available() or FORCE_GPU
if config.RAG.Retrieval.throwErrorWhenCUDAUnavailable:
    if not CUDA_AVAILABLE:
        raise RuntimeError(
            "CUDA is not available, if you want to run on CPU, "
            "please set throwErrorWhenCUDAUnavailable to false in the config file."
        )
    EMBEDDING_MODEL_DEVICE = "cuda"
else:
    EMBEDDING_MODEL_DEVICE = "cuda" if CUDA_AVAILABLE else "cpu"
logger.info(f"Embedding model device: {EMBEDDING_MODEL_DEVICE}")
EMBED_QUERY_CACHE_SIZE = max(
    64, int(os.environ.get("RAG_EMBED_QUERY_CACHE_SIZE", "256"))
)


def get_active_embedding_model_name() -> str:
    model = config.Models.ragEmbeddingModel
    return str(getattr(model, "name", "") or "").strip()


def get_active_embedding_cache_dir() -> str:
    model = config.Models.ragEmbeddingModel
    return str(getattr(model, "cacheDir", "") or "").strip()


def process_text(text):
    text = jaconv.z2h(str(text or ""), kana=False, digit=True, ascii=True)
    text = text.replace(" ", "").replace("\n", "").replace("\t", "")
    return text


def _find_hf_cache_snapshot(model_name: str) -> str | None:
    """Look for a model in the default HuggingFace cache directory."""
    hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
    model_cache_dir = hf_cache / f"models--{model_name.replace('/', '--')}"
    if not model_cache_dir.exists():
        return None
    snapshots_dir = model_cache_dir / "snapshots"
    if not snapshots_dir.exists():
        return None
    # Use the most recent snapshot (there's usually only one)
    snapshots = sorted(snapshots_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    for snap in snapshots:
        if snap.is_dir() and (snap / "config.json").exists():
            return str(snap)
    return None


def _check_model_dir(model_dir: Path) -> bool:
    """Check if a directory contains a valid, complete model."""
    if not model_dir.exists():
        return False
    indicator_files = [
        "config.json",
        "sentence_bert_config.json",
        "pytorch_model.bin",
        "tokenizer.json",
        "tokenizer_config.json",
    ]
    has_indicator = any((model_dir / f).exists() for f in indicator_files)
    has_safetensors = any(model_dir.glob("*.safetensors"))
    if not (has_indicator or has_safetensors):
        return False
    # If a shard index exists, verify all shards are present
    index_file = model_dir / "model.safetensors.index.json"
    if index_file.exists():
        try:
            import json
            with index_file.open() as f:
                index = json.load(f)
            shard_files = set(index.get("weight_map", {}).values())
            if shard_files and not all((model_dir / s).exists() for s in shard_files):
                logger.warning(f"Incomplete model at {model_dir}: missing shards")
                return False
        except Exception:
            pass
    return True


def ensure_local_HF_model(
    model_name: str, cache_dir: str, auto_download: bool = True
) -> str:

    model_dir = Path(cache_dir) / model_name.replace("/", "_")

    if _check_model_dir(model_dir):
        logger.info(f"Embedding model {model_name} found in local cache.")
        return str(model_dir)

    # Fallback: check the default HuggingFace cache directory
    hf_snapshot = _find_hf_cache_snapshot(model_name)
    if hf_snapshot:
        logger.info(
            f"Embedding model {model_name} found in HuggingFace cache: {hf_snapshot}"
        )
        return hf_snapshot

    if not auto_download:
        raise FileNotFoundError(
            f"Model {model_name} not found in local cache at {model_dir} "
            f"or in HuggingFace cache."
        )
    logger.info(f"Downloading embedding model {model_name} to local cache...")
    snapshot_download(
        repo_id=model_name, local_dir=model_dir, local_dir_use_symlinks=False
    )
    logger.info(f"Model {model_name} downloaded to: {model_dir}")

    return str(model_dir)


def load_embeddings():
    if isinstance(config.Models.ragEmbeddingModel, HFModelConfig):
        model_name = get_active_embedding_model_name()
        cache_dir = get_active_embedding_cache_dir()
        model_source = "env" if os.getenv("RAG_EMBEDDING_MODEL") else "config"
        logger.info(
            f"Active embedding model: {model_name} "
            f"(source={model_source}, cache_dir={cache_dir})"
        )

        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

        model_dir = ensure_local_HF_model(
            model_name=model_name,
            cache_dir=cache_dir,
        )

        emb = HuggingFaceEmbeddings(
            model_name=model_dir,
            model_kwargs={
                "device": EMBEDDING_MODEL_DEVICE,
                "local_files_only": True,
            },
            encode_kwargs={"normalize_embeddings": True},
        )
        return emb

    elif isinstance(config.Models.ragEmbeddingModel, OllamaModelConfig):
        logger.info(
            f"Active embedding model: {config.Models.ragEmbeddingModel.name} (source=config:ollama)"
        )

        ollama_base_url = config.Ollama.url[0] or None
        if not ollama_base_url:
            raise ValueError("Ollama base URL is not configured.")

        emb = OllamaEmbeddings(
            model=config.Models.ragEmbeddingModel.name,
            base_url=ollama_base_url,
            num_gpu=1,
        )
        return emb

    else:
        raise NotImplementedError("Unsupported embedding model configuration.")


embeddings = load_embeddings()


@lru_cache(maxsize=EMBED_QUERY_CACHE_SIZE)
def _embed_query_cached(normalized_text: str) -> tuple[float, ...]:
    started = perf_counter()
    vector = tuple(embeddings.embed_query(normalized_text))
    logger.info(
        f"[RAG] Query embedding computed in {perf_counter() - started:.3f}s "
        f"(chars={len(normalized_text)})"
    )
    return vector


def embed_text(text: str) -> list[float]:
    normalized = process_text(text)
    if not normalized:
        normalized = str(text or "").strip()
    return list(_embed_query_cached(normalized))


def embed_text_batch(texts: list[str], batch_size: int = 4) -> list[list[float]]:
    results = []
    from tqdm import tqdm

    for i in tqdm(range(0, len(texts), batch_size), desc="Embedding texts"):
        started = perf_counter()
        batch_texts = [
            process_text(text) or str(text or "").strip()
            for text in texts[i : i + batch_size]
        ]
        batch_embeddings = embeddings.embed_documents(batch_texts)
        logger.info(
            f"[RAG] Batch embeddings computed in {perf_counter() - started:.3f}s "
            f"(batch={len(batch_texts)})"
        )
        results.extend(batch_embeddings)
    return results
