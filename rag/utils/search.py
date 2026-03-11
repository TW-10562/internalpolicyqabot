from core.logging import logger
from chromadb import Collection, QueryResult
from typing import Optional
from pydantic import BaseModel
from services.embedder import process_text, embed_text
from config.index import config

class ChromaDBSearchResultItem(BaseModel):
    id: str
    content: str
    chunk_number_i: Optional[int]
    title: Optional[str]
    file_path_s: Optional[str]
    score: Optional[float]

def search_query(collection: Collection, query_text: str, top_k: int = 3) -> Optional[list[ChromaDBSearchResultItem]]:
    try:
        cleaned = process_text(query_text)
        if config.APP_MODE == "rag-evaluation":
            logger.debug(f"[SEARCH] Processed Query: '{cleaned}'")
        vector = embed_text(cleaned)
        results = collection.query(
            query_embeddings=[vector],
            n_results=top_k,
            include=["documents", "metadatas", "distances"]
        )
        if not results or not results["documents"]:
            return None
        
        ids = results["ids"][0] if results["ids"] else []
        documents = results["documents"][0]
        metadatas = results["metadatas"][0] if results["metadatas"] else [{}]*len(documents)
        scores = results["distances"][0] if results["distances"] else [0]*len(documents)

        return [
            ChromaDBSearchResultItem(
                id=id,
                content=doc,
                chunk_number_i=meta.get("chunk_number_i", -1),  # type: ignore
                title=meta.get("title", ""),  # type: ignore
                file_path_s=meta.get("file_path_s", ""),  # type: ignore
                score=score
            )
            for id, doc, meta, score in zip(ids, documents, metadatas, scores)
        ]
    except Exception as e:
        if config.APP_MODE == "rag-evaluation":
            logger.error(f"[SEARCH_QUERY] Failed query: {e}", exc_info=True)
        return None

def extract_passages(results):
    try:
        if results and "documents" not in results or not results["documents"]:
            return []
        return results["documents"][0]
    except Exception as e:
        logger.error(f"[RAG] Failed to extract documents: {e}", exc_info=True)
        return []
