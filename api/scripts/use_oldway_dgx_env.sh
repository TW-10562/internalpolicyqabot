#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   bash api/scripts/use_oldway_dgx_env.sh <dgx_ip> [docs_root]
#
# Example:
#   bash api/scripts/use_oldway_dgx_env.sh 172.30.140.163 /mnt/dgx_docs

DGX_IP="${1:-}"
DOCS_ROOT="${2:-/mnt/dgx_docs}"

if [[ -z "${DGX_IP}" ]]; then
  echo "ERROR: missing <dgx_ip>"
  echo "Usage: bash api/scripts/use_oldway_dgx_env.sh <dgx_ip> [docs_root]"
  exit 1
fi

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_TEMPLATE="${API_DIR}/.env.oldway.example"
ENV_FILE="${API_DIR}/.env"

if [[ ! -f "${ENV_TEMPLATE}" ]]; then
  echo "ERROR: template missing: ${ENV_TEMPLATE}"
  exit 1
fi

cp "${ENV_TEMPLATE}" "${ENV_FILE}"

sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://twave_01:twave_01password@${DGX_IP}:5433/qa_db|" "${ENV_FILE}"
sed -i "s|^PG_HOST=.*|PG_HOST=${DGX_IP}|" "${ENV_FILE}"
sed -i "s|^REDIS_HOST=.*|REDIS_HOST=${DGX_IP}|" "${ENV_FILE}"
sed -i "s|^SOLR_URL=.*|SOLR_URL=http://${DGX_IP}:8984|" "${ENV_FILE}"
sed -i "s|^OLLAMA_BASE_URL=.*|OLLAMA_BASE_URL=http://${DGX_IP}:11435|" "${ENV_FILE}"
sed -i "s|^DOCS_ROOT=.*|DOCS_ROOT=${DOCS_ROOT}|" "${ENV_FILE}"

echo "Wrote ${ENV_FILE} using old-way DGX profile."
echo
echo "Key values:"
grep -nE '^DATABASE_URL=|^PG_HOST=|^PG_PORT=|^REDIS_HOST=|^REDIS_PORT=|^SOLR_URL=|^RAG_BACKEND_URL=|^FAQ_CACHE_API_URL=|^OLLAMA_BASE_URL=|^DOCS_ROOT=' "${ENV_FILE}" || true
echo
echo "Next:"
echo "  1) Ensure DGX containers are up: expobot-postgres-1, expobot-redis-1, expobot-solr-1"
echo "  2) Ensure conflicting DB container is stopped (if present):"
echo "     docker stop tbot-postgres || true"
echo "  3) Mount docs (optional but recommended):"
echo "     bash api/scripts/setup_dgx_wsl.sh <dgx_user> ${DGX_IP} /srv/tbot/storage/docs ${DOCS_ROOT}"
