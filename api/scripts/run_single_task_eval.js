/* eslint-disable no-console */

const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:8080';
const EMPLOYEE_ID = process.env.BENCH_EMPLOYEE_ID || 'admin';
const PASSWORD = process.env.BENCH_PASSWORD || 'password';
const POLL_MS = Number(process.env.BENCH_POLL_MS || 700);
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 180000);
const ALL_FILE_SEARCH = process.env.BENCH_ALL_FILE_SEARCH !== '0';

const query = process.argv.slice(2).join(' ').trim();

if (!query) {
  console.error(JSON.stringify({ error: 'missing_query', message: 'Pass the query text as argv.' }));
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function submitQuery(token, taskId, prompt) {
  const res = await fetch(`${API_BASE_URL}/api/gen-task`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      type: 'CHAT',
      formData: {
        prompt,
        fieldSort: 1,
        taskId,
        fileId: [0],
        allFileSearch: ALL_FILE_SEARCH,
        useMcp: false,
        debug: true,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  const createdTaskId = data?.result?.taskId;
  if (!createdTaskId) {
    throw new Error(`Task submission failed: HTTP ${res.status}, body=${JSON.stringify(data)}`);
  }
  return String(createdTaskId);
}

function extractAnswer(content) {
  const single = String(content || '').match(/<!--SINGLE_LANG_START-->([\s\S]*?)<!--SINGLE_LANG_END-->/);
  if (!single) return String(content || '').trim();
  try {
    const parsed = JSON.parse(single[1]);
    return String(parsed?.content || '').trim();
  } catch {
    return String(content || '').trim();
  }
}

async function pollTask(token, taskId) {
  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    const url = `${API_BASE_URL}/api/gen-task-output/list?pageNum=1&pageSize=20&taskId=${encodeURIComponent(taskId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    const rows = data?.result?.rows || [];
    const row = rows.find((item) => Number(item.sort) === 1) || rows[0];
    if (row) {
      const status = String(row.status || '');
      if (status === 'FINISHED' || status === 'FAILED' || status === 'CANCEL') {
        const content = String(row.content || '');
        return {
          status,
          outputId: Number(row.id || 0) || null,
          totalMs: Date.now() - started,
          content,
          answer: extractAnswer(content),
        };
      }
    }
    await sleep(POLL_MS);
  }
  return {
    status: 'TIMEOUT',
    outputId: null,
    totalMs: Date.now() - started,
    content: '',
    answer: '',
  };
}

async function main() {
  const token = await login();
  const taskId = await createConversation(token);
  await submitQuery(token, taskId, query);
  const result = await pollTask(token, taskId);

  console.log(JSON.stringify({
    query,
    taskId,
    ...result,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: 'run_single_task_eval_failed', message: error?.message || String(error) }));
  process.exit(1);
});
