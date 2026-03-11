#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NVM_SH="${HOME}/.nvm/nvm.sh"
TARGET_MODE="${1:-dev}"
if [ $# -gt 0 ]; then
  shift
fi

# npm can export prefix vars that make nvm refuse to run in script context.
unset npm_config_prefix NPM_CONFIG_PREFIX PREFIX

if [ -s "${NVM_SH}" ]; then
  # shellcheck source=/dev/null
  source "${NVM_SH}"
  if [ -f "${ROOT_DIR}/.nvmrc" ]; then
    nvm use --silent >/dev/null || true
  else
    nvm use --silent 22.22.0 >/dev/null || true
  fi
fi

node "${ROOT_DIR}/scripts/check-node-version.mjs"

VITE_BIN="${ROOT_DIR}/node_modules/.bin/vite"
if [ ! -x "${VITE_BIN}" ]; then
  echo "[ViteError] Local vite binary not found. Run: npm install"
  exit 1
fi

cd "${ROOT_DIR}"
case "${TARGET_MODE}" in
  dev)
    exec "${VITE_BIN}" "$@"
    ;;
  build)
    exec "${VITE_BIN}" build "$@"
    ;;
  preview)
    exec "${VITE_BIN}" preview "$@"
    ;;
  *)
    exec "${VITE_BIN}" "${TARGET_MODE}" "$@"
    ;;
esac
