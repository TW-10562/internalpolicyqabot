/* eslint-disable no-console */
const crypto = require('node:crypto');
const path = require('node:path');
const ExcelJS = require('exceljs');

const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:8080';
const EMPLOYEE_ID = process.env.BENCH_EMPLOYEE_ID || 'admin';
const PASSWORD = process.env.BENCH_PASSWORD || '12345';
const POLL_MS = Number(process.env.BENCH_POLL_MS || 700);
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 180000);
const ALL_FILE_SEARCH = process.env.BENCH_ALL_FILE_SEARCH !== '0';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? String(args[i + 1] || '') : fallback;
};

const inputPath = arg('in', '');
const outputPath = arg('out', '');
const sheetName = arg('sheet', '');
const limit = Number(arg('limit', '100')) || 100;

if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/evaluate_rag_excel.js --in <input.xlsx> --out <output.xlsx> [--sheet <name>] [--limit 100]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normalizeHeader = (s) => String(s || '')
  .toLowerCase()
  .replace(/[%()]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const tokenize = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter((x) => x.length > 1);

const jaccard = (a, b) => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (!sa.size && !sb.size) return 1;
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0;
};

const overlapRecall = (a, b) => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (!sa.size) return 0;
  const inter = [...sa].filter((x) => sb.has(x)).length;
  return inter / sa.size;
};

function setCellByHeader(row, colMap, header, value) {
  const idx = colMap.get(normalizeHeader(header));
  if (!idx) return;
  row.getCell(idx).value = value;
}

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

async function createTask(token, query) {
  const payload = {
    type: 'CHAT',
    formData: {
      prompt: query,
      fieldSort: 1,
      taskId: `excel-eval-${crypto.randomUUID()}`,
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
  const data = await res.json().catch(() => ({}));
  const taskId = data?.result?.taskId;
  if (!taskId) {
    throw new Error(`Task creation failed: HTTP ${res.status}, body=${JSON.stringify(data)}`);
  }
  return String(taskId);
}

async function pollTask(token, taskId) {
  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    const u = `${API_BASE_URL}/api/gen-task-output/list?pageNum=1&pageSize=50&taskId=${encodeURIComponent(taskId)}`;
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    const rows = data?.result?.rows || [];
    const row = rows.find((r) => Number(r.sort) === 1) || rows[0];
    if (row) {
      const status = String(row.status || '');
      if (status === 'FINISHED' || status === 'FAILED' || status === 'CANCEL') {
        return {
          status,
          outputId: Number(row.id || 0) || null,
          content: String(row.content || ''),
          totalMs: Date.now() - started,
        };
      }
    }
    await sleep(POLL_MS);
  }
  return { status: 'TIMEOUT', outputId: null, content: '', totalMs: Date.now() - started };
}

async function fetchKpi(token, outputId) {
  if (!outputId) return null;
  const res = await fetch(`${API_BASE_URL}/api/rag/kpi?outputId=${encodeURIComponent(String(outputId))}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  return data?.data || null;
}

function evaluate(expected, actual, expectedSource) {
  const expTokens = tokenize(expected);
  const outTokens = tokenize(actual);
  const a1 = Math.round(overlapRecall(expTokens, outTokens) * 100);
  const a2 = Math.round(jaccard(expTokens, outTokens) * 100);
  const avg = (a1 + a2) / 2;
  const label = avg >= 75 ? 'PASS' : avg >= 45 ? 'PARTIAL' : 'FAIL';
  const src = String(expectedSource || '').trim();
  const srcMatch = src ? (actual.toLowerCase().includes(src.toLowerCase()) ? 'YES' : 'NO') : 'N/A';
  return { a1, a2, label, srcMatch };
}

async function run() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(inputPath));
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw new Error('Worksheet not found');

  const headerRow = ws.getRow(1);
  const colMap = new Map();
  headerRow.eachCell((cell, col) => {
    colMap.set(normalizeHeader(cell.value), col);
  });

  const questionCol = colMap.get(normalizeHeader('Question'));
  if (!questionCol) throw new Error('Question column not found');

  const token = await login();
  let processed = 0;
  for (let r = 2; r <= ws.rowCount; r += 1) {
    if (processed >= limit) break;
    const row = ws.getRow(r);
    const question = String(row.getCell(questionCol).value || '').trim();
    if (!question) continue;

    const expectedAnswer = String(row.getCell(colMap.get(normalizeHeader('Answer')) || 0).value || '').trim();
    const expectedSource = String(row.getCell(colMap.get(normalizeHeader('Source')) || 0).value || '').trim();

    processed += 1;
    console.log(`[${processed}/${limit}] ${question.slice(0, 100)}`);

    let taskId = '';
    let status = 'FAILED';
    let outputId = null;
    let answer = '';
    let kpi = null;
    try {
      taskId = await createTask(token, question);
      const result = await pollTask(token, taskId);
      status = result.status;
      outputId = result.outputId;
      answer = result.content || '';
      kpi = await fetchKpi(token, outputId);
    } catch (e) {
      status = 'ERROR';
      answer = '';
    }

    const evalResult = evaluate(expectedAnswer, answer, expectedSource);
    const inputTokens = Number(kpi?.inputTokens || 0) || 0;
    const outputTokens = Number(kpi?.outputTokens || 0) || 0;
    const totalTokens = inputTokens + outputTokens;

    setCellByHeader(row, colMap, 'current answer from aviary rag', answer);
    setCellByHeader(row, colMap, 'current answer from the LLM', answer);
    setCellByHeader(row, colMap, 'Accuracy-1 in %', evalResult.a1);
    setCellByHeader(row, colMap, 'Accuracy-2 in %', evalResult.a2);
    setCellByHeader(row, colMap, 'Accuracy-3', evalResult.label);
    setCellByHeader(row, colMap, 'Accuracy-4', evalResult.srcMatch);
    setCellByHeader(row, colMap, 'RAG Search Time', Number(kpi?.retrievalMs || kpi?.ragMs || 0));
    setCellByHeader(row, colMap, 'LLM Generation Time', Number(kpi?.llmMs || 0));
    setCellByHeader(row, colMap, 'Translation Time', Number(kpi?.translationMs || 0));
    setCellByHeader(row, colMap, 'Total Response Time', Number(kpi?.totalMs || 0));
    setCellByHeader(row, colMap, 'Input Tokens (estimated)', inputTokens);
    setCellByHeader(row, colMap, 'Output Tokens (estimated)', outputTokens);
    setCellByHeader(row, colMap, 'Total Tokens (estimated)', totalTokens);
    setCellByHeader(row, colMap, 'Remarks', `status=${status}; taskId=${taskId}; outputId=${outputId || ''}`);
    row.commit();
  }

  await wb.xlsx.writeFile(path.resolve(outputPath));
  console.log(`Done. Processed ${processed} question(s). Output: ${path.resolve(outputPath)}`);
}

run().catch((e) => {
  console.error(`Evaluation failed: ${e.message || String(e)}`);
  process.exit(1);
});
