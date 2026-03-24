# Changes Made

## Existing files changed

- `api/config/default.yml`
  - corrected container service hostnames
  - corrected Solr URL
  - set safer hybrid defaults instead of stale vector-only defaults

- `rag/config/index.py`
  - fixed Python config loading so env overrides are applied after YAML load and schema validation
  - normalized service URLs away from localhost-style values when running in containers

- `rag/services/HybridRAGEngineFactory.py`
  - replaced pathological full-store retrieval logic with direct bounded collection loading
  - cached BM25 corpus materialization
  - added retrieval timing logs for BM25, vector, hybrid, and total request handling

- `rag/services/embedder.py`
  - added query embedding cache
  - added embedding timing logs for query and batch embedding calls

- `rag/api/main.py`
  - exposed runtime wiring in `/health`
  - added structured request and completion logging for search endpoints

- `docker-compose.override.yml`
  - added health checks
  - aligned runtime env overrides for `rag-python`, `api`, and `worker`
  - corrected stale `RAG_SERVICE_URL`
  - forced consistent Solr and retrieval-mode settings
  - kept vector retrieval disabled on the live Node worker path to favor the stable lexical-first path

## New files created

- `scripts/healthcheck_all.sh`
- `scripts/test_gateway.sh`
- `scripts/test_rag_e2e.sh`
- `scripts/benchmark_retrieval.sh`
- `recovery_reports/00_baseline.md`
- `recovery_reports/10_gateway_auth.md`
- `recovery_reports/90_root_cause.md`
- `recovery_reports/91_changes_made.md`
- `recovery_reports/92_remaining_risks.md`
- `recovery_reports/93_benchmark_before_after.md`
- `recovery_reports/99_handover.md`
- `recovery_logs/20260324_recovery.log`

## Backup copies created before later edits

- `backup_configs/rag/services/embedder.py.bak.20260324`
- `backup_compose/docker-compose.override.yml.bak.20260324`
