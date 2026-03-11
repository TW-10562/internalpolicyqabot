/* eslint-disable no-console */
const crypto = require('node:crypto');

const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:8080';
const EMPLOYEE_ID = process.env.BENCH_EMPLOYEE_ID || 'admin';
const PASSWORD = process.env.BENCH_PASSWORD || '12345';
const LOAD_PROFILES = String(process.env.BENCH_LOAD_PROFILES || '100,300,500')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0);
const REQUESTS_PER_PROFILE = Math.max(
  1,
  Number(process.env.BENCH_REQUESTS_PER_PROFILE || 120),
);
const POLL_MS = Math.max(200, Number(process.env.BENCH_POLL_MS || 700));
const TIMEOUT_MS = Math.max(10000, Number(process.env.BENCH_TIMEOUT_MS || 180000));
const ALL_FILE_SEARCH = process.env.BENCH_ALL_FILE_SEARCH !== '0';
const WARMUP_REQUESTS = Math.max(0, Number(process.env.BENCH_WARMUP_REQUESTS || 3));

const DEFAULT_QUERIES = [
  'What is the annual leave policy?',
  'How do I apply for overtime?',
  'What is the information security policy?',
  'How should a security issue be reported?',
  'How does credit management work?',
  'What rules apply to remote work?',
];

const queries = (process.env.BENCH_QUERIES || DEFAULT_QUERIES.join('||'))
  .split('||')
  .map((q) => q.trim())
  .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const percentile = (vals, p) => {
  if (!vals.length) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
};

const pickQuery = (index) => queries[index % queries.length] || queries[0] || 'What is the policy?';

const hasMeaningfulText = (text) => {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact.length >= 20;
};

const looksLikeFailureReply = (text) => {
  const v = String(text || '').toLowerCase();
  return (
    v.includes('answer generation failed due to a temporary model issue') ||
    /requested information was not found in the available .*internal documents/.test(v) ||
    /利用可能な.+社内文書内で/.test(v)
  );
};

async function login() {
  const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: EMPLOYEE_ID, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  const token = body?.result?.token;
  if (!token) {
    throw new Error(`Login failed: HTTP ${res.status}, body=${JSON.stringify(body)}`);
  }
  return token;
}

async function createTask(token, prompt) {
  const payload = {
    type: 'CHAT',
    formData: {
      prompt,
      fieldSort: 1,
      taskId: `load-${crypto.randomUUID()}`,
      fileId: [0],
      allFileSearch: ALL_FILE_SEARCH,
      useMcp: false,
    },
  };

  const res = await fetch(`${API_BASE_URL}/api/gen-task`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  const taskId = body?.result?.taskId;
  if (!taskId) {
    throw new Error(`Task create failed: HTTP ${res.status}, body=${JSON.stringify(body)}`);
  }
  return String(taskId);
}

async function pollTask(token, taskId) {
  const startedAt = Date.now();
  let ttftMs = null;
  let finalStatus = 'TIMEOUT';
  let content = '';

  while (Date.now() - startedAt < TIMEOUT_MS) {
    const url = `${API_BASE_URL}/api/gen-task-output/list?pageNum=1&pageSize=20&taskId=${encodeURIComponent(taskId)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    const rows = body?.result?.rows || [];
    const row = rows.find((r) => Number(r.sort) === 1) || rows[0];

    if (row) {
      content = String(row.content || '');
      if (ttftMs == null && content.trim().length > 0) {
        ttftMs = Date.now() - startedAt;
      }
      finalStatus = String(row.status || '');
      if (finalStatus === 'FINISHED' || finalStatus === 'FAILED' || finalStatus === 'CANCEL') {
        break;
      }
    }

    await sleep(POLL_MS);
  }

  return {
    status: finalStatus,
    totalMs: Date.now() - startedAt,
    ttftMs,
    contentLen: content.length,
    hasMeaningfulText: hasMeaningfulText(content),
    looksLikeFailureReply: looksLikeFailureReply(content),
  };
}

function summarize(results, concurrency) {
  const finished = results.filter((r) => r.status === 'FINISHED');
  const totalMs = finished.map((r) => r.totalMs);
  const ttfts = finished
    .map((r) => r.ttftMs)
    .filter((v) => typeof v === 'number');
  const failedReplies = finished.filter((r) => r.looksLikeFailureReply).length;
  const meaningful = finished.filter((r) => r.hasMeaningfulText).length;

  const statusCounts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  return {
    concurrency,
    requests: results.length,
    statusCounts,
    successRate: results.length ? finished.length / results.length : 0,
    meaningfulAnswerRate: finished.length ? meaningful / finished.length : 0,
    failureReplyRate: finished.length ? failedReplies / finished.length : 0,
    latencyMs: {
      avg: totalMs.length ? totalMs.reduce((a, b) => a + b, 0) / totalMs.length : 0,
      p50: percentile(totalMs, 50),
      p95: percentile(totalMs, 95),
      p99: percentile(totalMs, 99),
    },
    ttftMs: {
      avg: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : 0,
      p50: percentile(ttfts, 50),
      p95: percentile(ttfts, 95),
      p99: percentile(ttfts, 99),
      count: ttfts.length,
    },
  };
}

async function runSingleLoadProfile({ token, concurrency, requests, label }) {
  const queue = Array.from({ length: requests }, (_, i) => i);
  const results = [];

  const worker = async () => {
    while (queue.length) {
      const idx = queue.shift();
      if (typeof idx !== 'number') return;
      const prompt = pickQuery(idx);
      const startedAt = Date.now();
      try {
        const taskId = await createTask(token, prompt);
        const outcome = await pollTask(token, taskId);
        results.push({
          index: idx,
          prompt,
          taskId,
          ...outcome,
          queueWaitMs: 0,
          wallMs: Date.now() - startedAt,
        });
      } catch (error) {
        results.push({
          index: idx,
          prompt,
          taskId: null,
          status: 'CLIENT_ERROR',
          totalMs: Date.now() - startedAt,
          ttftMs: null,
          contentLen: 0,
          hasMeaningfulText: false,
          looksLikeFailureReply: true,
          error: String(error?.message || error),
        });
      }
    }
  };

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = Date.now() - startedAt;
  const summary = summarize(results, concurrency);

  console.log(JSON.stringify({
    event: 'load_profile_summary',
    label,
    elapsedMs,
    summary,
  }, null, 2));

  return { label, elapsedMs, summary, rawCount: results.length };
}

async function run() {
  if (!queries.length) {
    throw new Error('No benchmark queries found. Set BENCH_QUERIES or keep defaults.');
  }
  if (!LOAD_PROFILES.length) {
    throw new Error('No load profiles found. Set BENCH_LOAD_PROFILES, e.g. 100,300,500');
  }

  console.log(JSON.stringify({
    event: 'load_benchmark_start',
    api: API_BASE_URL,
    employeeId: EMPLOYEE_ID,
    profiles: LOAD_PROFILES,
    requestsPerProfile: REQUESTS_PER_PROFILE,
    warmupRequests: WARMUP_REQUESTS,
    pollMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
    allFileSearch: ALL_FILE_SEARCH,
    queryCount: queries.length,
  }, null, 2));

  const token = await login();

  if (WARMUP_REQUESTS > 0) {
    await runSingleLoadProfile({
      token,
      concurrency: Math.min(5, WARMUP_REQUESTS),
      requests: WARMUP_REQUESTS,
      label: 'warmup',
    });
  }

  const reports = [];
  for (const profile of LOAD_PROFILES) {
    reports.push(await runSingleLoadProfile({
      token,
      concurrency: profile,
      requests: Math.max(profile, REQUESTS_PER_PROFILE),
      label: `concurrency_${profile}`,
    }));
  }

  console.log(JSON.stringify({
    event: 'load_benchmark_complete',
    reports,
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    event: 'load_benchmark_error',
    message: String(error?.message || error),
  }, null, 2));
  process.exit(1);
});
