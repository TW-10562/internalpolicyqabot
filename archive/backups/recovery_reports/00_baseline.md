# Baseline

- Date: 2026-03-24
- Project root: `/home/qabot/hrbot`
- Stack shape confirmed: `postgres`, `redis`, `solr`, `rag-python`, `api`, `worker`, `ui`, external `APISIX`

## Baseline faults carried into this recovery pass

- Python RAG config loading used YAML defaults even when runtime env overrides were set.
- YAML defaults still pointed Solr at `http://localhost:8983` and kept hybrid retrieval in `vector_only` mode.
- API/worker and Python RAG had split-brain retrieval settings and stale runtime values.
- Python hybrid retrieval used a pathological full-store corpus build pattern equivalent to loading the entire vector store on the critical path.
- Direct vector and hybrid retrieval had previously recorded 89 to 91 second latencies in `rag-python` logs.
- APISIX model and chat routing were largely consistent, but stale extra objects remained present and were not safe to delete blindly.

## Baseline evidence used

- `docker compose ps`
- `curl http://127.0.0.1:8080/health`
- `curl http://127.0.0.1:8010/health`
- `curl http://127.0.0.1:8983/solr/mycore/select?q=*:*&rows=0&wt=json`
- `docker logs hrbot-rag-python`
- `docker logs hrbot-worker`
- `docker logs hrbot-api`
