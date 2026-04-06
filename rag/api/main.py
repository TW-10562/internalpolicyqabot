import os
import sys
import threading
import time

import torch
from api.modeAPI import upload_router
from config.index import config
from core.logging import logger
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from models.schemas import (
    DeleteRequest,
    DeleteResponseModel,
    HybridSearchRequest,
    SearchRequest,
    UpdateRequest,
)
from services.document_service import delete_collection
from services.embedder import (
    embed_text,
    get_active_embedding_cache_dir,
    get_active_embedding_model_name,
)
from services.HybridRAGEngineFactory import hybrid_RAG_engine_factory
from services.rag_service import search_rag
from services.record_service import delete_document, update_document


# ---------------------------------------------------------------------------
# CUDA failure watchdog – tracks consecutive GPU errors and triggers a
# container restart (sys.exit) when the GPU is unrecoverably broken.
# Docker's restart policy (unless-stopped) will bring the container back up
# with a fresh CUDA context.
# ---------------------------------------------------------------------------
_CUDA_MAX_CONSECUTIVE_FAILURES = int(
    os.environ.get("RAG_CUDA_MAX_FAILURES", "5")
)

_cuda_failure_count = 0
_cuda_failure_lock = threading.Lock()


def record_cuda_success() -> None:
    """Reset the consecutive failure counter on any successful GPU operation."""
    global _cuda_failure_count
    with _cuda_failure_lock:
        if _cuda_failure_count > 0:
            logger.info(
                f"[CUDA-WATCHDOG] GPU recovered after {_cuda_failure_count} consecutive failure(s). Resetting counter."
            )
        _cuda_failure_count = 0


def record_cuda_failure(error: Exception) -> None:
    """Increment the failure counter; trigger restart if threshold exceeded."""
    global _cuda_failure_count
    with _cuda_failure_lock:
        _cuda_failure_count += 1
        logger.error(
            f"[CUDA-WATCHDOG] Consecutive CUDA failure {_cuda_failure_count}/{_CUDA_MAX_CONSECUTIVE_FAILURES}: {error}"
        )
        if _cuda_failure_count >= _CUDA_MAX_CONSECUTIVE_FAILURES:
            logger.critical(
                f"[CUDA-WATCHDOG] {_cuda_failure_count} consecutive CUDA failures detected. "
                "GPU is in an unrecoverable state. Triggering container restart."
            )
            # Exit with non-zero code so Docker restarts the container
            sys.exit(1)

app = FastAPI(docs_url="/docs")

ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    start_time = time.perf_counter()
    response = await call_next(request)
    process_time = time.perf_counter() - start_time
    response.headers["X-Process-Time"] = f"{process_time:.4f}"
    logger.info(
        f"{request.method} {request.url.path} - time taken: {process_time:.4f}s"
    )
    return response


app.include_router(upload_router)


@app.on_event("startup")
def log_rag_runtime_config():
    logger.info(
        "[RAG] Startup runtime config: "
        f"embedding_model={get_active_embedding_model_name()} "
        f"embedding_cache_dir={get_active_embedding_cache_dir()} "
        f"rerank_model={config.Models.ragRerankModel.name} "
        f"vector_only_default={config.RAG.Retrieval.HybridSearch.vector_only}"
    )


@app.get("/healthz")
@app.get("/health")
def health_check():
    gpu_ok = True
    gpu_detail = "ok"

    # Lightweight CUDA probe – only runs if CUDA was available at startup.
    # Does NOT run a full embedding (too expensive for a 15-second poll).
    # Instead it checks that CUDA is still responsive via a tiny tensor op.
    if torch.cuda.is_available():
        try:
            # Tiny operation – allocates ~4 bytes, runs a single add on GPU
            t = torch.tensor([1.0], device="cuda")
            _ = t + t
            del t
        except Exception as e:
            gpu_ok = False
            gpu_detail = str(e)
            logger.warning(f"[HEALTH] CUDA probe failed: {e}")

    status_code = 200 if gpu_ok else 503
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=status_code,
        content={
            "status": "ok" if gpu_ok else "degraded",
            "gpu": gpu_detail,
            "solr_url": config.ApacheSolr.url,
            "solr_core": config.ApacheSolr.coreName,
            "embedding_model": get_active_embedding_model_name(),
            "vector_only_default": config.RAG.Retrieval.HybridSearch.vector_only,
            "bm25_only_default": config.RAG.Retrieval.HybridSearch.bm25_only,
            "collection_name": config.RAG.PreProcess.PDF.splitByArticle.collectionName,
        },
    )


@app.post("/search")
def search(req: SearchRequest):
    start_time = time.perf_counter()
    try:
        logger.info(
            "[RAG] /search request: "
            f"collections={len(req.collection_name)} "
            f"top_k={req.top_k} "
            f"query_len={len(req.query or '')}"
        )
        result = search_rag(req)
        logger.info(
            "[RAG] /search completed: "
            f"results={len(result.get('results', []))} "
            f"elapsed={time.perf_counter() - start_time:.3f}s"
        )
        record_cuda_success()
        return result
    except Exception as e:
        logger.error(f"[RAG] /search failed: {e}", exc_info=True)
        if "CUDA" in str(e):
            record_cuda_failure(e)
        raise HTTPException(
            status_code=500,
            detail={
                "message": str(e),
                "query": req.query,
                "collection_name": req.collection_name,
                "top_k": req.top_k,
            },
        )


@app.post("/search/hybrid")
def hybrid_search(req: HybridSearchRequest):
    start_time = time.perf_counter()
    try:
        logger.info(
            "[RAG] /search/hybrid request: "
            f"collection={req.collection_name} "
            f"top_k={req.top_k} "
            f"vector_only={req.vector_only} "
            f"bm25_only={req.bm25_only} "
            f"metadata_filter_keys={sorted((req.metadata_filters or {}).keys()) if isinstance(req.metadata_filters, dict) else []} "
            f"candidate_file_ids={len(req.candidate_file_ids or [])} "
            f"query_len={len(req.query or '')}"
        )
        result = hybrid_RAG_engine_factory.get(req.collection_name).hybrid_search_rag(req)
        logger.info(
            "[RAG] /search/hybrid completed: "
            f"results={len(result or [])} "
            f"elapsed={time.perf_counter() - start_time:.3f}s"
        )
        record_cuda_success()
        return result
    except Exception as e:
        logger.error(f"[RAG] /search/hybrid failed: {e}", exc_info=True)
        if "CUDA" in str(e):
            record_cuda_failure(e)
        raise HTTPException(
            status_code=500,
            detail={
                "message": str(e),
                "query": req.query,
                "collection_name": req.collection_name,
                "top_k": req.top_k,
                "vector_only": req.vector_only,
                "bm25_only": req.bm25_only,
            },
        )


@app.put("/update")
def update(req: UpdateRequest):
    try:
        return update_document(req)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/collection", response_model=DeleteResponseModel)
def delete_col(req: DeleteRequest):
    try:
        return delete_collection(req)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/record")
def delete_doc(req: DeleteRequest):
    try:
        return delete_document(req)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/check_embedding_model")
def check_embedding_model():
    start_time = time.perf_counter()
    try:
        embed_text("基本給はどのように決まりますか？")
        return {
            "message": "Embedding model is working correctly.",
            "embedding_model": get_active_embedding_model_name(),
            "embedding_cache_dir": get_active_embedding_cache_dir(),
            "elapsed_seconds": round(time.perf_counter() - start_time, 3),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
