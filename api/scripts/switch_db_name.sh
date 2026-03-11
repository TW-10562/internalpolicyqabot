#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   bash api/scripts/switch_db_name.sh <db_name>
#
# Example:
#   bash api/scripts/switch_db_name.sh expobot
#   bash api/scripts/switch_db_name.sh qa_db

DB_NAME="${1:-}"
if [[ -z "${DB_NAME}" ]]; then
  echo "ERROR: missing <db_name>"
  echo "Usage: bash api/scripts/switch_db_name.sh <db_name>"
  exit 1
fi

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${API_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: missing ${ENV_FILE}"
  exit 1
fi

if grep -q '^PG_DATABASE=' "${ENV_FILE}"; then
  sed -i "s|^PG_DATABASE=.*|PG_DATABASE=${DB_NAME}|" "${ENV_FILE}"
else
  echo "PG_DATABASE=${DB_NAME}" >> "${ENV_FILE}"
fi

if grep -q '^DATABASE_URL=' "${ENV_FILE}"; then
  CURRENT_URL="$(grep '^DATABASE_URL=' "${ENV_FILE}" | head -n1 | cut -d= -f2-)"
  NEW_URL="$(echo "${CURRENT_URL}" | sed -E "s|/[^/?]+(\\?.*)?$|/${DB_NAME}\\1|")"
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=${NEW_URL}|" "${ENV_FILE}"
else
  echo "WARNING: DATABASE_URL not found, only PG_DATABASE was updated."
fi

echo "Updated DB target in ${ENV_FILE}"
grep -nE '^DATABASE_URL=|^PG_DATABASE=' "${ENV_FILE}"
