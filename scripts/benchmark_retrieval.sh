#!/usr/bin/env bash
set -euo pipefail

RAG_URL="${RAG_URL:-http://127.0.0.1:8010}"
COLLECTION_NAME="${COLLECTION_NAME:-splitByArticleWithHybridSearch}"
QUERY="${1:-残業 申請方法}"
RUNS="${RUNS:-3}"

tmp_body="$(mktemp)"
cleanup() {
  rm -f "$tmp_body"
}
trap cleanup EXIT

run_case() {
  local name="$1"
  local endpoint="$2"
  local payload="$3"
  local checker="$4"
  local times=()

  for _ in $(seq 1 "$RUNS"); do
    local seconds
    seconds="$(
      curl --max-time 60 -sS -o "$tmp_body" -w '%{time_total}' \
        -H 'Content-Type: application/json' \
        --data "$payload" \
        "$RAG_URL$endpoint"
    )"
    node -e "$checker" "$tmp_body" >/dev/null
    times+=("$seconds")
  done

  node -e '
    const label = process.argv[1];
    const values = process.argv.slice(2).map(Number);
    const avgMs = values.reduce((sum, value) => sum + value, 0) / values.length * 1000;
    const minMs = Math.min(...values) * 1000;
    const maxMs = Math.max(...values) * 1000;
    console.log(`${label}: avg=${avgMs.toFixed(1)}ms min=${minMs.toFixed(1)}ms max=${maxMs.toFixed(1)}ms`);
  ' "$name" "${times[@]}"
}

embed_payload="$(
  node -e '
    process.stdout.write(JSON.stringify({ text: process.argv[1] }));
  ' "$QUERY"
)"
bm25_payload="$(
  node -e '
    process.stdout.write(JSON.stringify({
      collection_name: process.argv[1],
      query: process.argv[2],
      top_k: 5,
      bm25_only: true,
    }));
  ' "$COLLECTION_NAME" "$QUERY"
)"
vector_payload="$(
  node -e '
    process.stdout.write(JSON.stringify({
      collection_name: process.argv[1],
      query: process.argv[2],
      top_k: 5,
      vector_only: true,
    }));
  ' "$COLLECTION_NAME" "$QUERY"
)"
hybrid_payload="$(
  node -e '
    process.stdout.write(JSON.stringify({
      collection_name: process.argv[1],
      query: process.argv[2],
      top_k: 5,
    }));
  ' "$COLLECTION_NAME" "$QUERY"
)"

echo "[benchmark] query=$QUERY collection=$COLLECTION_NAME runs=$RUNS"
run_case \
  "embedding_check" \
  "/check_embedding_model" \
  "$embed_payload" \
  'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!data?.message) process.exit(1);'
run_case \
  "bm25_only" \
  "/search/hybrid" \
  "$bm25_payload" \
  'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!Array.isArray(data) || data.length === 0) process.exit(1);'
run_case \
  "vector_only" \
  "/search/hybrid" \
  "$vector_payload" \
  'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!Array.isArray(data) || data.length === 0) process.exit(1);'
run_case \
  "hybrid" \
  "/search/hybrid" \
  "$hybrid_payload" \
  'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!Array.isArray(data) || data.length === 0) process.exit(1);'
