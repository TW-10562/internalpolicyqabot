# Handover

## What was broken

- Python RAG ran with stale YAML defaults instead of live env overrides.
- Solr wiring and retrieval defaults were inconsistent across Python and Node.
- Hybrid retrieval did expensive full-store loading on the request path.
- Direct vector and hybrid retrieval had severe latency spikes.

## What was fixed

- Runtime config loading now respects env overrides in Python RAG.
- Container-to-container URLs now point at service names instead of localhost defaults.
- Python and Node retrieval mode settings were aligned through `docker-compose.override.yml`.
- Pathological BM25 corpus construction was replaced with direct bounded collection loading and caching.
- Retrieval and embedding timing logs were added.
- Health checks and repeatable validation scripts were added.
- Full `docker compose down` then `docker compose up -d` restart was completed successfully.

## Post-restart status

- `postgres`: healthy
- `redis`: healthy
- `solr`: healthy
- `rag-python`: healthy
- `api`: healthy
- `worker`: running
- `ui`: running

## Validation highlights

- API health: ok
- Python RAG health: ok with Solr at `http://solr:8983`
- Solr core `mycore` responded with indexed documents
- APISIX `GET /v1/models`: success
- APISIX `POST /v1/chat/completions`: success at HTTP layer; gateway remains reachable
- Real Aviary task route: authenticated task creation succeeded after restart
- Post-restart grounded task `jouKXecI30GdY1XBM3ZW9` finished with source `Exment _ バックオフィスポータル-att-mgnt-guidelinesJP.pdf`
- Post-restart unique grounded task `f-yVugog2k30r_VP850ig` finished with source `Exment _ バックオフィスポータルApply_otJP.pdf`

## Commands prepared for repeatable use

- `scripts/healthcheck_all.sh`
- `scripts/test_gateway.sh`
- `scripts/test_rag_e2e.sh`
- `scripts/benchmark_retrieval.sh`
