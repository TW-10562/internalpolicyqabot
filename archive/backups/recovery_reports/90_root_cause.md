# Root Cause

## Confirmed root causes

1. Python RAG config resolution applied YAML defaults first and did not reliably honor runtime env overrides, which left Solr and retrieval-mode settings stale at runtime.
2. `api/config/default.yml` still encoded localhost-style service addresses and `vector_only` defaults that no longer matched the deployed multi-container topology.
3. API and worker containers still exposed stale retrieval-related env values such as `RAG_SERVICE_URL=http://localhost:8010` and old semantic weights, which preserved configuration drift even when the main path was working.
4. Python hybrid retrieval built BM25-capable corpora using a full-store loading pattern on the request path, causing avoidable latency and memory pressure.
5. Direct vector and hybrid queries suffered from cold-start embedding and retrieval cost, which produced earlier 89 to 91 second requests.
6. Optional query-intent and term-expansion assets are missing, so all chat requests default to `rag_query`.

## Non-RAG issue observed during recovery

- Microsoft SSO update flow still hits a duplicate `emp_id` unique-constraint error in the API layer. This is unrelated to the RAG recovery path and was not changed.
