import os
from pathlib import Path

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
import torch
from config.index import config
from config.schema import HFModelConfig, OllamaModelConfig
from core.logging import logger
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


def process_text(text):
    text = jaconv.z2h(text, kana=False, digit=True, ascii=True)
    text = text.replace(" ", "").replace("\n", "").replace("\t", "")
    return text


def ensure_local_HF_model(
    model_name: str, cache_dir: str, auto_download: bool = True
) -> str:

    model_dir = Path(cache_dir) / model_name.replace("/", "_")
    model_files = [
        "config.json",
        "sentence_bert_config.json",
        "pytorch_model.bin",
        "tokenizer.json",
        "tokenizer_config.json",
    ]

    if model_dir.exists() and any((model_dir / f).exists() for f in model_files):
        logger.info(f"Embedding model {model_name} found in local cache.")
    else:
        if not auto_download:
            raise FileNotFoundError(
                f"Model {model_name} not found in local cache at {model_dir}."
            )
        logger.info(f"Downloading embedding model {model_name} to local cache...")
        snapshot_download(
            repo_id=model_name, local_dir=model_dir, local_dir_use_symlinks=False
        )
        logger.info(f"Model {model_name} downloaded to: {model_dir}")

    return str(model_dir)


def load_embeddings():
    if isinstance(config.Models.ragEmbeddingModel, HFModelConfig):

        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

        model_dir = ensure_local_HF_model(
            model_name=config.Models.ragEmbeddingModel.name,
            cache_dir=config.Models.ragEmbeddingModel.cacheDir,
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

embed_text = embeddings.embed_query


def embed_text_batch(texts: list[str], batch_size: int = 16) -> list[list[float]]:
    results = []
    from tqdm import tqdm

    for i in tqdm(range(0, len(texts), batch_size), desc="Embedding texts"):
        batch_texts = texts[i : i + batch_size]
        batch_embeddings = embeddings.embed_documents(batch_texts)
        results.extend(batch_embeddings)
    return results
