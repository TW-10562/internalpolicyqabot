#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${API_URL:-http://127.0.0.1:8080}"
RAG_URL="${RAG_URL:-http://127.0.0.1:8010}"
SOLR_URL="${SOLR_URL:-http://127.0.0.1:8983/solr/mycore/select?q=*:*&rows=0&wt=json}"

cd "$ROOT_DIR"

required_services=(postgres redis solr rag-python api worker ui)

echo "[health] docker compose services"
for service in "${required_services[@]}"; do
  cid="$(docker compose ps -q "$service")"
  if [[ -z "$cid" ]]; then
    echo "health check failed: service '$service' has no running container" >&2
    exit 1
  fi

  state="$(docker inspect --format '{{.State.Status}}' "$cid")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$cid")"
  echo "  - $service state=$state health=$health"

  if [[ "$state" != "running" ]]; then
    echo "health check failed: service '$service' is not running" >&2
    exit 1
  fi

  if [[ "$health" != "n/a" && "$health" != "healthy" ]]; then
    echo "health check failed: service '$service' is not healthy" >&2
    exit 1
  fi
done

echo "[health] api"
api_body="$(curl -sS "$API_URL/health")"
node -e '
  const data = JSON.parse(process.argv[1]);
  if (data.status !== "ok" || data.db?.pgAvailable !== true) process.exit(1);
  console.log(`  - api status=${data.status} postgres=${data.db.pgAvailable}`);
' "$api_body"

echo "[health] rag-python"
rag_body="$(curl -sS "$RAG_URL/health")"
node -e '
  const data = JSON.parse(process.argv[1]);
  if (data.status !== "ok") process.exit(1);
  console.log(`  - rag status=${data.status} solr=${data.solr_url} vector_only_default=${data.vector_only_default}`);
' "$rag_body"

echo "[health] solr"
solr_body="$(curl -sS "$SOLR_URL")"
node -e '
  const data = JSON.parse(process.argv[1]);
  const found = Number(data?.response?.numFound || 0);
  if (!Number.isFinite(found) || found <= 0) process.exit(1);
  console.log(`  - solr numFound=${found}`);
' "$solr_body"

"$ROOT_DIR/scripts/test_gateway.sh"
"$ROOT_DIR/scripts/test_rag_e2e.sh"

echo "[health] complete"
