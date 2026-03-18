#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi
  echo "Run as root (sudo is not available)." >&2
  exit 1
fi

HOSTNAME_FQDN="${HOSTNAME_FQDN:-hrbot.twave.internal}"

# If `hrbot.twave.internal` is not published in DNS, clients on the twave
# private network still need a working server IP to bootstrap trust (CA install)
# and hostname mapping (/etc/hosts). We probe a few likely IPs and pick the
# first one that serves the bootstrap CA.
SERVER_IP="${SERVER_IP:-}"
SERVER_IP_CANDIDATES="${SERVER_IP_CANDIDATES:-"10.17.0.221 172.30.140.148"}"
BOOTSTRAP_BASE="${BOOTSTRAP_BASE:-}"
CA_CERT_TMP="${CA_CERT_TMP:-/tmp/hrbot-root-ca.crt}"
CA_CERT_DEST="${CA_CERT_DEST:-/usr/local/share/ca-certificates/hrbot-root-ca.crt}"
CA_CERT_NAME="${CA_CERT_NAME:-HRBot Internal Root CA}"

is_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

extract_host_from_url() {
  local url="$1"
  url="${url#http://}"
  url="${url#https://}"
  url="${url%%/*}"
  url="${url%%:*}"
  printf '%s' "$url"
}

probe_bootstrap_ip() {
  local ip="$1"
  curl -fsS --connect-timeout 2 --max-time 5 "http://${ip}/bootstrap/hrbot-root-ca.crt" -o /dev/null
}

probe_https_ip() {
  local ip="$1"
  # We only care that TCP/443 + TLS is reachable; ignore cert validation here.
  curl -ksS --connect-timeout 2 --max-time 5 "https://${ip}/" -o /dev/null
}

probe_candidate_ip() {
  local ip="$1"
  probe_bootstrap_ip "${ip}" && probe_https_ip "${ip}"
}

choose_server_ip() {
  local ip

  # 1) Try whatever the hostname currently resolves to (DNS or existing /etc/hosts)
  if command -v getent >/dev/null 2>&1; then
    while IFS= read -r ip; do
      if [[ -n "${ip}" ]] && probe_candidate_ip "${ip}"; then
        echo "${ip}"
        return 0
      fi
    done < <(getent ahostsv4 "${HOSTNAME_FQDN}" 2>/dev/null | awk '{print $1}' | awk '!seen[$0]++' || true)
  fi

  # 2) Fall back to a known candidate list.
  for ip in ${SERVER_IP_CANDIDATES}; do
    if probe_candidate_ip "${ip}"; then
      echo "${ip}"
      return 0
    fi
  done

  return 1
}

if [[ -z "${BOOTSTRAP_BASE}" ]]; then
  if [[ -z "${SERVER_IP}" ]]; then
    SERVER_IP="$(choose_server_ip || true)"
  fi
  if [[ -z "${SERVER_IP}" ]]; then
    echo "ERROR: Could not reach HRBot bootstrap endpoint on any candidate IP." >&2
    echo "If you know the server IP, rerun with: SERVER_IP=<ip> sudo -E bash $0" >&2
    echo "Tried candidates: ${SERVER_IP_CANDIDATES}" >&2
    exit 1
  fi
  BOOTSTRAP_BASE="http://${SERVER_IP}/bootstrap"
else
  # If BOOTSTRAP_BASE is overridden, try to infer SERVER_IP (needed for /etc/hosts + curl --resolve).
  if [[ -z "${SERVER_IP}" ]]; then
    BOOTSTRAP_HOST="$(extract_host_from_url "${BOOTSTRAP_BASE}")"
    if [[ -n "${BOOTSTRAP_HOST}" ]]; then
      if is_ipv4 "${BOOTSTRAP_HOST}"; then
        SERVER_IP="${BOOTSTRAP_HOST}"
      elif command -v getent >/dev/null 2>&1; then
        SERVER_IP="$(getent ahostsv4 "${BOOTSTRAP_HOST}" 2>/dev/null | awk '{print $1; exit}' || true)"
        if [[ -z "${SERVER_IP}" ]]; then
          SERVER_IP="$(getent hosts "${BOOTSTRAP_HOST}" 2>/dev/null | awk '{print $1; exit}' || true)"
        fi
      fi
    fi
  fi
fi

if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: SERVER_IP could not be determined. Set SERVER_IP=<ip> and retry." >&2
  exit 1
fi

if ! probe_candidate_ip "${SERVER_IP}"; then
  echo "ERROR: Could not reach HRBot on ${SERVER_IP} (needs http://.../bootstrap and https://... on 443)." >&2
  echo "If you’re on a different twave subnet, rerun with a reachable IP:" >&2
  echo "  SERVER_IP=10.17.0.221 sudo -E bash $0" >&2
  echo "  SERVER_IP=172.30.140.148 sudo -E bash $0" >&2
  exit 1
fi

echo "Using HRBot server IP: ${SERVER_IP}"
echo "Using bootstrap URL: ${BOOTSTRAP_BASE}"

get_invoking_user() {
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER:-}" != "root" ]]; then
    echo "${SUDO_USER}"
    return 0
  fi
  return 1
}

get_user_home() {
  local user="$1"
  getent passwd "$user" | awk -F: '{print $6}'
}

run_as_user() {
  local user="$1"
  shift
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$user" -- "$@"
  else
    # Fallback; should be rare on Ubuntu.
    su -s /bin/bash "$user" -c "$(printf '%q ' "$@")"
  fi
}

install_ca_to_nssdb() {
  local user="$1"
  local nssdb_dir="$2"

  run_as_user "$user" mkdir -p "$nssdb_dir"
  if [[ ! -f "${nssdb_dir}/cert9.db" ]]; then
    run_as_user "$user" certutil -N -d "sql:${nssdb_dir}" --empty-password >/dev/null 2>&1 || true
  fi

  if [[ -f "${nssdb_dir}/cert9.db" ]]; then
    run_as_user "$user" certutil -D -d "sql:${nssdb_dir}" -n "${CA_CERT_NAME}" >/dev/null 2>&1 || true
    run_as_user "$user" certutil -A -d "sql:${nssdb_dir}" -t "C,," -n "${CA_CERT_NAME}" -i "${CA_CERT_DEST}" >/dev/null 2>&1 || true
    echo "Installed CA into NSS DB: ${nssdb_dir}"
  else
    echo "NOTE: Could not initialize NSS DB at ${nssdb_dir}; skipping."
  fi
}

curl -fsSL "${BOOTSTRAP_BASE}/hrbot-root-ca.crt" -o "${CA_CERT_TMP}"
install -m 0644 "${CA_CERT_TMP}" "${CA_CERT_DEST}"

if ! grep -qE "^[[:space:]]*${SERVER_IP//./\\.}[[:space:]]+${HOSTNAME_FQDN//./\\.}([[:space:]]|\$)" /etc/hosts; then
  printf '\n%s %s\n' "${SERVER_IP}" "${HOSTNAME_FQDN}" >> /etc/hosts
fi

if command -v update-ca-certificates >/dev/null 2>&1; then
  update-ca-certificates
fi

# Chrome/Chromium/Edge on Linux can rely on the per-user NSS DB for trust anchors.
# Installing into the system CA store alone isn't always picked up immediately.
INV_USER="$(get_invoking_user || true)"
if [[ -n "${INV_USER}" ]]; then
  INV_HOME="$(get_user_home "${INV_USER}" || true)"
  if [[ -n "${INV_HOME}" && -d "${INV_HOME}" ]]; then
    NSSDB_DIR="${INV_HOME}/.pki/nssdb"
    if ! command -v certutil >/dev/null 2>&1; then
      if command -v apt-get >/dev/null 2>&1; then
        echo "Installing libnss3-tools (for Chrome/Chromium trust store)..."
        apt-get update || true
        apt-get install -y libnss3-tools || true
      fi
    fi

    if command -v certutil >/dev/null 2>&1; then
      # Classic (non-snap) Chrome/Chromium
      install_ca_to_nssdb "${INV_USER}" "${NSSDB_DIR}"

      # Snap Chromium uses HOME=~/snap/chromium/current
      if [[ -d "${INV_HOME}/snap/chromium" ]]; then
        install_ca_to_nssdb "${INV_USER}" "${INV_HOME}/snap/chromium/current/.pki/nssdb"
        install_ca_to_nssdb "${INV_USER}" "${INV_HOME}/snap/chromium/common/.pki/nssdb"
      fi

      # Brave snap (optional)
      if [[ -d "${INV_HOME}/snap/brave" ]]; then
        install_ca_to_nssdb "${INV_USER}" "${INV_HOME}/snap/brave/current/.pki/nssdb"
        install_ca_to_nssdb "${INV_USER}" "${INV_HOME}/snap/brave/common/.pki/nssdb"
      fi
    fi
  fi
fi

if command -v resolvectl >/dev/null 2>&1; then
  resolvectl flush-caches >/dev/null 2>&1 || true
elif command -v systemd-resolve >/dev/null 2>&1; then
  systemd-resolve --flush-caches >/dev/null 2>&1 || true
fi

echo "Verifying TLS trust with curl..."
if curl -fsS --resolve "${HOSTNAME_FQDN}:443:${SERVER_IP}" "https://${HOSTNAME_FQDN}/" >/dev/null 2>&1; then
  echo "OK: system trust store accepts the HRBot certificate."
else
  echo "WARNING: curl still does not trust the certificate."
  echo "If you're using Firefox, enable: about:config -> security.enterprise_roots.enabled = true"
fi

echo "Done. Fully restart your browser, then open: https://${HOSTNAME_FQDN}"
