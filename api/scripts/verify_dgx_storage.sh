#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   bash api/scripts/verify_dgx_storage.sh [docs_root]
#
# Example:
#   bash api/scripts/verify_dgx_storage.sh /mnt/dgx_docs

DOCS_ROOT="${1:-/mnt/dgx_docs}"

echo "Checking docs root: ${DOCS_ROOT}"
if [[ ! -d "${DOCS_ROOT}" ]]; then
  echo "ERROR: docs root not found."
  exit 1
fi

for tag in HR GA ACC OTHER; do
  mkdir -p "${DOCS_ROOT}/${tag}"
done

echo
echo "Folder status:"
ls -lah "${DOCS_ROOT}" || true
for tag in HR GA ACC OTHER; do
  echo "--- ${tag} ---"
  ls -lah "${DOCS_ROOT}/${tag}" || true
done

echo
echo "Writable check:"
touch "${DOCS_ROOT}/HR/.write_test" && rm -f "${DOCS_ROOT}/HR/.write_test"
echo "OK: write access confirmed."

