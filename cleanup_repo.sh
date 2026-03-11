#!/usr/bin/env bash
set -euo pipefail

MODE="${1:---dry-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="${ROOT_DIR}/cleanup_backups"
BACKUP_PATH="${BACKUP_DIR}/repo_cleanup_${STAMP}.tar.gz"
FILELIST="$(mktemp)"
SORTED_FILELIST="$(mktemp)"

cleanup() {
  rm -f "${FILELIST}" "${SORTED_FILELIST}"
}
trap cleanup EXIT

if [[ "${MODE}" != "--dry-run" && "${MODE}" != "--apply" ]]; then
  echo "Usage: bash cleanup_repo.sh [--dry-run|--apply]"
  exit 1
fi

SAFE_PATHS=(
  "project"
  "api/src/flow/runtime.ts"
  "api/src/middleware/production.ts"
  "api/src/service/aiTranslationService.ts"
  "api/src/service/translationService.ts"
  "api/src/services/cacheService.ts"
  "api/src/services/chatProcessor.ts"
  "api/src/services/healthCheck.ts"
  "api/src/services/index.ts"
  "api/src/services/llmService.ts"
  "api/src/services/logger.ts"
  "api/src/services/queryClassifier.ts"
  "api/src/services/ragService.ts"
  "api/src/services/responseFormatter.ts"
  "api/src/services/retryService.ts"
  "api/src/utils/database.ts"
  "api/src/utils/documentComparisonStore.ts"
  "api/src/utils/text.ts"
  "rag/services/document_comparison_service.py"
  "api/config/env.ts"
  "api/config/index.ts"
  "api/config/schema.ts"
  "api/config/uploadPath.ts"
  "api/scripts/test_admin_user_management.ts"
  "api/scripts/test_department_rbac.ts"
  "api/scripts/verify_rbac.ts"
  "api-example.js"
)

append_if_exists() {
  local rel="$1"
  if [[ -e "${ROOT_DIR}/${rel}" ]]; then
    printf '%s\0' "${rel}" >> "${FILELIST}"
  fi
}

append_find_results() {
  while IFS= read -r -d '' abs; do
    if [[ "${abs}" == "${ROOT_DIR}/"* ]]; then
      printf '%s\0' "${abs#${ROOT_DIR}/}" >> "${FILELIST}"
    fi
  done
}

for rel in "${SAFE_PATHS[@]}"; do
  append_if_exists "${rel}"
done

if [[ -d "${ROOT_DIR}/reports" ]]; then
  append_find_results < <(
    find "${ROOT_DIR}/reports" -mindepth 1 -maxdepth 1 \
      \( -name 'test-runs' -o -name 'rag_eval_*' \) -print0
  )
fi

append_find_results < <(
  find "${ROOT_DIR}/rag" "${ROOT_DIR}/faq_database" \
    \( -type d -name '__pycache__' -o -type f -name '*.pyc' \) -print0 2>/dev/null
)

append_find_results < <(
  find "${ROOT_DIR}" \
    \( -path "${ROOT_DIR}/api/node_modules" -o -path "${ROOT_DIR}/ui-2/node_modules" -o -path "${ROOT_DIR}/project/node_modules" -o -path "${ROOT_DIR}/aviary/node_modules" -o -path "${ROOT_DIR}/cleanup_backups" \) -prune \
    -o -type f -name '*Zone.Identifier' -print0 2>/dev/null
)

sort -zu "${FILELIST}" > "${SORTED_FILELIST}"

if [[ ! -s "${SORTED_FILELIST}" ]]; then
  echo "No cleanup targets found."
  exit 0
fi

echo "Cleanup mode: ${MODE}"
echo "Targets:"
while IFS= read -r -d '' rel; do
  printf '  %s\n' "${rel}"
done < "${SORTED_FILELIST}"

if [[ "${MODE}" == "--dry-run" ]]; then
  echo
  echo "Dry run only. Re-run with --apply to archive and remove the targets above."
  exit 0
fi

mkdir -p "${BACKUP_DIR}"
tar -C "${ROOT_DIR}" --null --files-from "${SORTED_FILELIST}" -czf "${BACKUP_PATH}"

while IFS= read -r -d '' rel; do
  rm -rf -- "${ROOT_DIR}/${rel}"
done < "${SORTED_FILELIST}"

if [[ -d "${ROOT_DIR}/api/src/services" ]] && [[ -z "$(find "${ROOT_DIR}/api/src/services" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
  rmdir "${ROOT_DIR}/api/src/services"
fi

echo
echo "Backup archive created:"
echo "  ${BACKUP_PATH}"
echo "Cleanup completed."
