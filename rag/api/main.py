import time

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
    return {
        "status": "ok",
        "solr_url": config.ApacheSolr.url,
        "solr_core": config.ApacheSolr.coreName,
        "embedding_model": get_active_embedding_model_name(),
        "vector_only_default": config.RAG.Retrieval.HybridSearch.vector_only,
        "bm25_only_default": config.RAG.Retrieval.HybridSearch.bm25_only,
        "collection_name": config.RAG.PreProcess.PDF.splitByArticle.collectionName,
    }


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
        return result
    except Exception as e:
        logger.error(f"[RAG] /search failed: {e}", exc_info=True)
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
        return result
    except Exception as e:
        logger.error(f"[RAG] /search/hybrid failed: {e}", exc_info=True)
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
