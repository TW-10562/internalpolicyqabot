#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${API_URL:-http://127.0.0.1:8080}"
API_CONTAINER="${API_CONTAINER:-hrbot-api}"
BASE_PROMPT="${1:-残業の事前申請の手順を教えてください}"
STAMP="$(date +%s)"
PROMPT="${BASE_PROMPT}。検証ID:${STAMP}"

tmp_create="$(mktemp)"
tmp_task="$(mktemp)"
cleanup() {
  rm -f "$tmp_create" "$tmp_task"
}
trap cleanup EXIT

TOKEN="$(
  docker exec -i "$API_CONTAINER" node <<'NODE'
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const { config } = require('/app/api/dist/config/index.js');

(async () => {
  const session = `codex-e2e-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
  });

  const payload = {
    userId: 1,
    userName: 'admin',
    empId: '0001',
    roleCode: 'SUPER_ADMIN',
    departmentCode: 'HR',
    session,
    exp: Date.now() + 24 * 60 * 60 * 1000,
  };

  const token = jwt.sign(payload, config.Backend.jwtSecret);

  await redis.sadd('login_tokens', session);
  await redis.set(
    session,
    JSON.stringify({
      loginTime: new Date().toISOString(),
      userId: 1,
      userName: 'admin',
      empId: '0001',
      roleCode: 'SUPER_ADMIN',
      departmentCode: 'HR',
      permissions: ['*|*'],
      roles: ['SUPER_ADMIN'],
    })
  );
  await redis.expire(session, 3600);
  await redis.quit();

  process.stdout.write(token);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
)"

if [[ -z "$TOKEN" ]]; then
  echo "rag e2e failed: could not mint API token" >&2
  exit 1
fi

create_payload="$(
  node -e '
    const prompt = process.argv[1];
    const stamp = process.argv[2];
    const payload = {
      type: "CHAT",
      formData: {
        taskId: `codex-rag-e2e-${stamp}`,
        fieldSort: 1,
        prompt,
        fileId: [],
        allFileSearch: true,
        useMcp: false,
      },
    };
    process.stdout.write(JSON.stringify(payload));
  ' "$PROMPT" "$STAMP"
)"

create_status="$(
  curl -sS -o "$tmp_create" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    --data "$create_payload" \
    "$API_URL/api/aviary/v1/tasks"
)"
if [[ "$create_status" != "200" ]]; then
  echo "rag e2e failed: task creation returned HTTP $create_status" >&2
  cat "$tmp_create" >&2
  exit 1
fi

TASK_ID="$(
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const taskId = data?.data?.id || "";
    if (!data?.ok || !taskId) process.exit(1);
    process.stdout.write(String(taskId));
  ' "$tmp_create"
)"

if [[ -z "$TASK_ID" ]]; then
  echo "rag e2e failed: task id missing" >&2
  exit 1
fi

echo "[rag-e2e] created task: $TASK_ID"

for attempt in $(seq 1 30); do
  task_status_code="$(
    curl -sS -o "$tmp_task" -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      "$API_URL/api/aviary/v1/tasks/$TASK_ID"
  )"
  if [[ "$task_status_code" != "200" ]]; then
    echo "rag e2e failed: task poll returned HTTP $task_status_code" >&2
    cat "$tmp_task" >&2
    exit 1
  fi

  task_status="$(
    node -e '
      const fs = require("fs");
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(data?.data?.task?.status || ""));
    ' "$tmp_task"
  )"

  if [[ "$task_status" == "FINISHED" ]]; then
    answer_and_source="$(
      node -e '
        const fs = require("fs");
        const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const raw = String(data?.data?.outputs?.[0]?.content || "");
        const match = raw.match(/<!--SINGLE_LANG_START-->\s*([\s\S]*?)\s*<!--SINGLE_LANG_END-->/);
        const parsed = match ? JSON.parse(match[1]) : { content: raw };
        const content = String(parsed.content || "").trim();
        const sourceMatch = content.match(/SOURCE:\s*([^\n]+)/);
        if (!content || !sourceMatch) process.exit(1);
        console.log(content);
        console.log("---");
        console.log(sourceMatch[1].trim());
      ' "$tmp_task"
    )"
    echo "[rag-e2e] status: FINISHED"
    echo "$answer_and_source"
    exit 0
  fi

  if [[ "$task_status" == "FAILED" ]]; then
    echo "rag e2e failed: task entered FAILED state" >&2
    cat "$tmp_task" >&2
    exit 1
  fi

  echo "[rag-e2e] poll $attempt status=$task_status"
  sleep 2
done

echo "rag e2e failed: task did not finish within timeout" >&2
cat "$tmp_task" >&2
exit 1
