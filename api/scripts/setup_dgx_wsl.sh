#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   bash api/scripts/setup_dgx_wsl.sh <dgx_user> <dgx_host_or_ip> [dgx_docs_path] [local_mount_path]
#
# Example:
#   bash api/scripts/setup_dgx_wsl.sh tw10562 172.30.140.163 /srv/tbot/storage/docs /mnt/dgx_docs

DGX_USER="${1:-}"
DGX_HOST="${2:-}"
DGX_DOCS_PATH="${3:-/srv/tbot/storage/docs}"
LOCAL_MOUNT_PATH="${4:-/mnt/dgx_docs}"

if [[ -z "${DGX_USER}" || -z "${DGX_HOST}" ]]; then
  echo "ERROR: missing required args."
  echo "Usage: bash api/scripts/setup_dgx_wsl.sh <dgx_user> <dgx_host_or_ip> [dgx_docs_path] [local_mount_path]"
  exit 1
fi

if ! command -v sshfs >/dev/null 2>&1; then
  echo "ERROR: sshfs is not installed."
  echo "Install first: sudo apt-get update && sudo apt-get install -y sshfs"
  exit 1
fi

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${API_DIR}/.env"

FUSERMOUNT_BIN=""
if command -v fusermount >/dev/null 2>&1; then
  FUSERMOUNT_BIN="fusermount"
elif command -v fusermount3 >/dev/null 2>&1; then
  FUSERMOUNT_BIN="fusermount3"
fi

is_path_usable() {
  local p="$1"
  ls -ld "$p" >/dev/null 2>&1
}

try_unmount_stale() {
  local p="$1"
  # Try normal unmount first, then lazy unmount, then FUSE unmount.
  umount "$p" >/dev/null 2>&1 || true
  umount -l "$p" >/dev/null 2>&1 || true
  if [[ -n "${FUSERMOUNT_BIN}" ]]; then
    "${FUSERMOUNT_BIN}" -u "$p" >/dev/null 2>&1 || true
    "${FUSERMOUNT_BIN}" -uz "$p" >/dev/null 2>&1 || true
  fi
}

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f "${API_DIR}/.env.central.example" ]]; then
    cp "${API_DIR}/.env.central.example" "${ENV_FILE}"
    echo "Created ${ENV_FILE} from .env.central.example"
  else
    echo "ERROR: ${ENV_FILE} not found and no .env.central.example to copy from."
    exit 1
  fi
fi

# Recover stale/broken mountpoint states (common after network interruptions).
if [[ -e "${LOCAL_MOUNT_PATH}" ]]; then
  if ! is_path_usable "${LOCAL_MOUNT_PATH}"; then
    echo "Detected broken mount path state at ${LOCAL_MOUNT_PATH}, attempting recovery..."
    try_unmount_stale "${LOCAL_MOUNT_PATH}"
  fi
fi

mkdir -p "${LOCAL_MOUNT_PATH}" >/dev/null 2>&1 || {
  echo "mkdir failed for ${LOCAL_MOUNT_PATH}, attempting stale unmount recovery..."
  try_unmount_stale "${LOCAL_MOUNT_PATH}"
  mkdir -p "${LOCAL_MOUNT_PATH}"
}

if mountpoint -q "${LOCAL_MOUNT_PATH}" && is_path_usable "${LOCAL_MOUNT_PATH}"; then
  echo "Mount already active at ${LOCAL_MOUNT_PATH}"
else
  # If marked as mountpoint but unusable, force cleanup first.
  if mountpoint -q "${LOCAL_MOUNT_PATH}" && ! is_path_usable "${LOCAL_MOUNT_PATH}"; then
    echo "Mountpoint exists but is unusable; forcing remount..."
    try_unmount_stale "${LOCAL_MOUNT_PATH}"
  fi
  echo "Mounting ${DGX_USER}@${DGX_HOST}:${DGX_DOCS_PATH} -> ${LOCAL_MOUNT_PATH}"
  sshfs "${DGX_USER}@${DGX_HOST}:${DGX_DOCS_PATH}" "${LOCAL_MOUNT_PATH}" \
    -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,StrictHostKeyChecking=accept-new
fi

if [[ ! -d "${LOCAL_MOUNT_PATH}" ]] || ! is_path_usable "${LOCAL_MOUNT_PATH}"; then
  echo "ERROR: mount path not accessible: ${LOCAL_MOUNT_PATH}"
  exit 1
fi

# Ensure tag folders exist on DGX mount
mkdir -p "${LOCAL_MOUNT_PATH}/HR" "${LOCAL_MOUNT_PATH}/GA" "${LOCAL_MOUNT_PATH}/ACC" "${LOCAL_MOUNT_PATH}/OTHER"

touch "${LOCAL_MOUNT_PATH}/.wsl_dgx_mount_test" && rm -f "${LOCAL_MOUNT_PATH}/.wsl_dgx_mount_test"

# Upsert DOCS_ROOT and force postgres mode in .env
if grep -q '^DOCS_ROOT=' "${ENV_FILE}"; then
  sed -i "s|^DOCS_ROOT=.*|DOCS_ROOT=${LOCAL_MOUNT_PATH}|" "${ENV_FILE}"
else
  echo "DOCS_ROOT=${LOCAL_MOUNT_PATH}" >> "${ENV_FILE}"
fi

if grep -q '^DB_MODE=' "${ENV_FILE}"; then
  sed -i 's/^DB_MODE=.*/DB_MODE=postgres/' "${ENV_FILE}"
else
  echo 'DB_MODE=postgres' >> "${ENV_FILE}"
fi

echo
echo "Done."
echo "Mounted path: ${LOCAL_MOUNT_PATH}"
echo "Updated env:  ${ENV_FILE}"
echo "Current key lines:"
grep -nE '^DB_MODE=|^DOCS_ROOT=|^DATABASE_URL=|^PG_HOST=|^REDIS_HOST=|^SOLR_URL=|^RAG_BACKEND_URL=' "${ENV_FILE}" || true
echo
echo "Next:"
echo "  cd ${API_DIR}"
echo "  pkill -f \"ts-node-dev.*src/main.ts\" || true"
echo "  pnpm dev"
