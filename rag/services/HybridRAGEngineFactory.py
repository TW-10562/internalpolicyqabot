from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

import jaconv
from config.index import config
from core.logging import logger
from langchain.retrievers.ensemble import EnsembleRetriever
from langchain_chroma import Chroma
from langchain_community.retrievers import BM25Retriever
from models.schemas import HybridSearchRequest
from services.embedder import embeddings
from services.reranker_service import get_ranked_results
from sudachipy import dictionary, tokenizer

tok = None
mode = tokenizer.Tokenizer.SplitMode.C


CUR_DIR = Path(__file__).parent
JA_STOPWORDS = set()
with open(CUR_DIR / "stopwords-ja.txt", "r", encoding="utf-8") as f:
    for line in f:
        JA_STOPWORDS.add(line.strip())


def ja_preprocess(text: str):
    text = jaconv.z2h(text, kana=False, digit=True, ascii=True)
    text = text.replace("\n", "").replace("\r", "")
    t = text.lower()

    global tok
    if tok is None:
        try:
            tok = dictionary.Dictionary().create()
        except Exception as e:
            logger.warning(f"Sudachi tokenizer unavailable, fallback preprocessing: {e}")
            return [t] if t else []

    results = [
        m.surface()
        for m in tok.tokenize(t, mode)
        if m.part_of_speech()[0] != "補助記号" and m.surface() not in JA_STOPWORDS
    ]

    return results


class HybridRAGSearchEngine:

    def __init__(self, *, collection_name: str, embeddings):
        self.collection_name = collection_name
        self.embeddings = embeddings

        logger.info(
            f"[RAG] Initializing Chroma vectorstore for collection '{collection_name}'"
        )
        self.vectorstore = Chroma(
            collection_name=collection_name,
            embedding_function=self.embeddings,
            persist_directory=config.RAG.VectorStore.path,
        )

        self._all_documents_cache: Optional[List] = None
        self._bm25_lock = threading.Lock()

    def _compute_candidate_k(self, req: HybridSearchRequest) -> int:
        if config.RAG.Retrieval.usingRerank:
            logger.info("[RAG] Reranker enabled")
            return max(1, req.top_k * 4)

        if not req.vector_only and not req.bm25_only:
            logger.info("[RAG] Hybrid without rerank")
            return max(1, req.top_k * 4)
        return max(1, req.top_k)

    def _maybe_rerank(self, query: str, docs: List, top_k: int) -> List:
        if not docs:
            logger.warning("[RAG] No documents to rank")
            return []
        if not config.RAG.Retrieval.usingRerank:
            return docs[:top_k]
        logger.info("[RAG] Reranking retrieved documents")
        ranked = get_ranked_results(query, docs, top_n=top_k)
        logger.info("[RAG] Ranking completed")
        return ranked

    def _ensure_all_documents(self, refresh: bool = False) -> List:
        with self._bm25_lock:
            if self._all_documents_cache is None or refresh:
                logger.info(
                    "[RAG] Loading all documents from Chroma for BM25-capable modes"
                )
                self._all_documents_cache = self.vectorstore.similarity_search(
                    "", k=100000
                )
                logger.info(
                    f"[RAG] Cached {len(self._all_documents_cache or [])} documents for BM25"
                )
        return self._all_documents_cache or []

    def _normalize_where_filter(self, req: HybridSearchRequest) -> Dict[str, Any]:
        where: Dict[str, Any] = {}

        raw_meta = req.metadata_filters if isinstance(req.metadata_filters, dict) else {}
        for key, value in raw_meta.items():
            k = str(key or "").strip()
            if not k:
                continue
            if isinstance(value, list):
                vals = [v for v in value if v is not None and str(v).strip() != ""]
                if not vals:
                    continue
                where[k] = vals[0] if len(vals) == 1 else {"$in": vals}
                continue
            if value is None:
                continue
            if isinstance(value, str) and value.strip() == "":
                continue
            where[k] = value

        candidate_ids = [
            str(v).strip()
            for v in (req.candidate_file_ids or [])
            if str(v).strip()
        ]
        if candidate_ids:
            existing = where.get("file_path_s")
            if isinstance(existing, dict) and isinstance(existing.get("$in"), list):
                allowed = [v for v in existing["$in"] if str(v) in set(candidate_ids)]
                if allowed:
                    where["file_path_s"] = {"$in": allowed}
            elif isinstance(existing, str):
                where["file_path_s"] = existing if existing in set(candidate_ids) else {"$in": candidate_ids}
            else:
                where["file_path_s"] = {"$in": candidate_ids}

        return where

    @staticmethod
    def _matches_filter_value(actual: Any, expected: Any) -> bool:
        if isinstance(expected, dict):
            in_values = expected.get("$in")
            if isinstance(in_values, list):
                return str(actual) in {str(v) for v in in_values}
            return False
        return str(actual) == str(expected)

    def _doc_matches_where(self, doc: Any, where: Dict[str, Any]) -> bool:
        if not where:
            return True
        md = getattr(doc, "metadata", {}) or {}
        if not isinstance(md, dict):
            return False
        for key, expected in where.items():
            if key not in md:
                return False
            if not self._matches_filter_value(md.get(key), expected):
                return False
        return True

    def hybrid_search_rag(
        self, req: HybridSearchRequest, *, refresh_bm25_cache: bool = False
    ):

        logger.info("[RAG] Starting hybrid_search_rag")
        try:
            k_candidates = self._compute_candidate_k(req)
            where_filter = self._normalize_where_filter(req)
            if where_filter:
                logger.info(
                    f"[RAG] Applying metadata pre-filter keys: {list(where_filter.keys())}"
                )

            # ----- Vector-only -----
            if req.vector_only:
                logger.info("[RAG] Vector-only search")
                vector_kwargs: Dict[str, Any] = {"k": k_candidates}
                if where_filter:
                    vector_kwargs["filter"] = where_filter
                retriever = self.vectorstore.as_retriever(
                    search_kwargs=vector_kwargs
                )
                retrieved_docs = retriever.invoke(req.query)
                if where_filter and not retrieved_docs:
                    logger.warning(
                        "[RAG] Vector-only metadata filter returned 0 docs; retrying without metadata filter"
                    )
                    retriever = self.vectorstore.as_retriever(
                        search_kwargs={"k": k_candidates}
                    )
                    retrieved_docs = retriever.invoke(req.query)
                logger.info("[RAG] Vector-only search completed")
                return self._maybe_rerank(req.query, retrieved_docs, req.top_k)

            # ----- BM25 & Hybrid  -----
            all_documents = self._ensure_all_documents(refresh=refresh_bm25_cache)
            if not all_documents:
                logger.warning("[RAG] No documents in store")
                return []

            candidate_documents = all_documents
            if where_filter:
                filtered_docs = [
                    d for d in all_documents if self._doc_matches_where(d, where_filter)
                ]
                if filtered_docs:
                    candidate_documents = filtered_docs
                    logger.info(
                        f"[RAG] Metadata pre-filter reduced BM25 corpus to {len(candidate_documents)} docs"
                    )
                else:
                    logger.warning(
                        "[RAG] Metadata pre-filter returned 0 docs; falling back to unfiltered corpus"
                    )

            bm25_params = req.bm25_params.model_dump() if req.bm25_params else {}

            # ----- BM25-only -----
            if req.bm25_only:
                logger.info("[RAG] BM25-only search")
                bm25_retriever = BM25Retriever.from_documents(
                    documents=candidate_documents,
                    bm25_params=bm25_params,
                    preprocess_func=ja_preprocess,
                )
                bm25_retriever.k = k_candidates
                retrieved_docs = bm25_retriever.invoke(req.query)
                logger.info("[RAG] BM25-only search completed")
                return self._maybe_rerank(req.query, retrieved_docs, req.top_k)

            # ----- Hybrid（Ensemble）-----
            logger.info("[RAG] Hybrid search")
            multiplier = 2
            expanded_top_k = max(k_candidates, req.top_k * max(1, int(multiplier)))

            vector_kwargs: Dict[str, Any] = {"k": expanded_top_k}
            if where_filter:
                vector_kwargs["filter"] = where_filter
            vector_retriever = self.vectorstore.as_retriever(
                search_kwargs=vector_kwargs
            )
            bm25_retriever = BM25Retriever.from_documents(
                documents=candidate_documents,
                bm25_params=bm25_params,
                preprocess_func=ja_preprocess,
            )
            bm25_retriever.k = expanded_top_k

            ensemble_retriever = EnsembleRetriever(
                retrievers=[vector_retriever, bm25_retriever],
                weights=[req.vector_weight, req.bm25_weight],
            )
            retrieved_docs = ensemble_retriever.invoke(req.query)
            logger.info(
                f"[RAG] Hybrid produced {len(retrieved_docs)} candidates (pre-rerank/trim)"
            )
            return self._maybe_rerank(req.query, retrieved_docs, req.top_k)

        except Exception as e:
            logger.error(
                f"[RAG] hybrid_search_rag failed for '{req.query}': {e}", exc_info=True
            )
            raise Exception(f"Hybrid search operation failed: {str(e)}") from e


class HybridRAGEngineFactory:

    # TODO: Periodically clear cached engine instances to save memory? Or limit cache size?
    def __init__(self, embeddings):
        self._embeddings = embeddings
        self._cache: Dict[str, HybridRAGSearchEngine] = {}  # type: ignore
        self._lock = threading.Lock()

    def get(self, collection_name: str) -> HybridRAGSearchEngine:
        if not collection_name:
            raise ValueError("collection_name must be a non-empty string")
        with self._lock:
            engine = self._cache.get(collection_name)
            if engine is not None:
                logger.info(
                    f"[RAG] Factory cache hit for collection '{collection_name}'"
                )
                return engine
            logger.info(
                f"[RAG] Factory creating engine for collection '{collection_name}'"
            )
            engine = HybridRAGSearchEngine(
                collection_name=collection_name,
                embeddings=self._embeddings,
            )
            self._cache[collection_name] = engine
            return engine

    def clear(self, collection_name: str) -> None:
        with self._lock:
            if collection_name in self._cache:
                logger.info(
                    f"[RAG] Factory clearing engine for collection '{collection_name}'"
                )
                self._cache.pop(collection_name, None)

    def clear_all(self) -> None:
        with self._lock:
            logger.info("[RAG] Factory clearing all cached engines")
            self._cache.clear()


hybrid_RAG_engine_factory = HybridRAGEngineFactory(embeddings=embeddings)
