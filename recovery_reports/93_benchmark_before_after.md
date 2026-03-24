# Benchmark Before And After

## Before

- `2026-03-23` `rag-python` log: `POST /check_embedding_model` took `48.3133s`
- `2026-03-24 00:32 JST` `rag-python` log: `POST /check_embedding_model` took `89.7882s`
- `2026-03-24 00:32 JST` `rag-python` log: vector-only `/search/hybrid` completed in `90.726s`
- `2026-03-24 00:32 JST` `rag-python` log: hybrid `/search/hybrid` completed in `90.9108s`
- Hybrid BM25 setup relied on a pathological full-store load pattern on the request path

## After

- Cached BM25 corpus load: `1664` documents cached in `0.648s`
- Post-restart embedding check: `0.563s`
- Post-restart BM25-only retrieval: `0.462s`
- Post-restart vector-only retrieval: `0.246s`
- Post-restart hybrid retrieval: `0.805s`
- Real worker retrieval for a non-cached RAG request: `332ms`
- Real worker retrieval for a cached repeat RAG request: `17ms`
- Post-restart unique Aviary RAG task retrieval: `23ms`
- Post-restart unique Aviary RAG task total LLM generation: `89429ms` after one retry

## Interpretation

- The structural latency fix came from removing the pathological corpus-building path and aligning runtime config.
- The stable production path is now lexical-first in the Node worker, with vector retrieval disabled there to avoid unnecessary latency.
- Retrieval is now fast and stable; remaining latency is dominated by the upstream LLM backend, not by Solr or vector search.
