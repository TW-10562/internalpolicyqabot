/* eslint-disable no-console */

const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:8080';
const EMPLOYEE_ID = process.env.BENCH_EMPLOYEE_ID || 'admin';
const PASSWORD = process.env.BENCH_PASSWORD || '12345';
const ITERATIONS = Number(process.env.BENCH_ITERATIONS || 6);
const POLL_MS = Number(process.env.BENCH_POLL_MS || 700);
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 180000);
const ALL_FILE_SEARCH = process.env.BENCH_ALL_FILE_SEARCH !== '0';

const DEFAULT_QUERIES = [
  'What is the annual leave policy?',
  'Explain overtime compensation rules.',
  'How does shift allowance work?',
  'What are the probation period rules?',
  'How to request paid leave?',
  'What is the policy for late-night work?',
];

const queries = (process.env.BENCH_QUERIES || DEFAULT_QUERIES.join('||'))
  .split('||')
  .map((q) => q.trim())
  .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (vals, p) => {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
};

async function login() {
  const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: EMPLOYEE_ID, password: PASSWORD }),
  });
  const data = await res.json().catch(() => ({}));
  const token = data?.result?.token;
  if (!token) {
    throw new Error(`Login failed: HTTP ${res.status}, body=${JSON.stringify(data)}`);
  }
  return token;
}

async function createConversation(token) {
  const res = await fetch(`${API_BASE_URL}/api/gen-task`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ type: 'CHAT', formData: {} }),
  });
  const data = await res.json().catch(() => ({}));
  const taskId = data?.result?.taskId;
  if (!taskId) {
    throw new Error(`Conversation creation failed: HTTP ${res.status}, body=${JSON.stringify(data)}`);
  }
  return String(taskId);
}

async function createTask(token, query) {
  const taskId = await createConversation(token);
  const formData = {
    prompt: query,
    fieldSort: 1,
    taskId,
    fileId: [0],
    allFileSearch: ALL_FILE_SEARCH,
    useMcp: false,
  };

  const res = await fetch(`${API_BASE_URL}/api/gen-task`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ type: 'CHAT', formData }),
  });
  const data = await res.json().catch(() => ({}));
  const createdTaskId = data?.result?.taskId;
  if (!createdTaskId) {
    throw new Error(`Task creation failed: HTTP ${res.status}, body=${JSON.stringify(data)}`);
  }
  return String(createdTaskId);
}

async function pollTask(token, taskId) {
  const started = Date.now();
  let ttftMs = null;

  while (Date.now() - started < TIMEOUT_MS) {
    const u = `${API_BASE_URL}/api/gen-task-output/list?pageNum=1&pageSize=20&taskId=${encodeURIComponent(taskId)}`;
    const res = await fetch(u, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    const rows = data?.result?.rows || [];
    const row = rows.find((r) => Number(r.sort) === 1) || rows[0];

    if (row) {
      const content = String(row.content || '');
      if (ttftMs == null && content.trim().length > 0) {
        ttftMs = Date.now() - started;
      }
      const status = String(row.status || '');
      if (status === 'FINISHED' || status === 'FAILED' || status === 'CANCEL') {
        return {
          status,
          totalMs: Date.now() - started,
          ttftMs,
          contentLen: content.length,
        };
      }
    }

    await sleep(POLL_MS);
  }

  return {
    status: 'TIMEOUT',
    totalMs: Date.now() - started,
    ttftMs,
    contentLen: 0,
  };
}

async function run() {
  console.log(JSON.stringify({
    event: 'benchmark_start',
    api: API_BASE_URL,
    iterations: ITERATIONS,
    pollMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
    allFileSearch: ALL_FILE_SEARCH,
    queries,
  }));

  const token = await login();
  const results = [];

  for (let i = 0; i < ITERATIONS; i += 1) {
    const query = queries[i % queries.length];
    const taskId = await createTask(token, query);
    const r = await pollTask(token, taskId);
    results.push({ query, ...r });
    console.log(JSON.stringify({ event: 'benchmark_case', i, taskId, ...r }));
  }

  const done = results.filter((r) => r.status === 'FINISHED');
  const totals = done.map((r) => r.totalMs);
  const ttfts = done.map((r) => r.ttftMs).filter((v) => typeof v === 'number');

  const summary = {
    completed: done.length,
    total: results.length,
    statusCounts: results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {}),
    latencyMs: {
      avg: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0,
      p50: percentile(totals, 50),
      p95: percentile(totals, 95),
    },
    ttftMs: {
      avg: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : 0,
      p50: percentile(ttfts, 50),
      p95: percentile(ttfts, 95),
      count: ttfts.length,
    },
    raw: results,
  };

  console.log(JSON.stringify({ event: 'benchmark_summary', summary }, null, 2));
}

run().catch((e) => {
  console.error(JSON.stringify({ event: 'benchmark_error', message: e?.message || String(e) }));
  process.exit(1);
});
