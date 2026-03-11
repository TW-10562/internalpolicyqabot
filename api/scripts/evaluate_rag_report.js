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
const requireRag = arg('require-rag', '1') !== '0';
const failFast = arg('fail-fast', '1') !== '0';
const maxConsecutiveErrors = Math.max(1, Number(arg('max-consecutive-errors', '3')) || 3);
const retries = Math.max(0, Number(arg('retries', '2')) || 2);
const sleepBetweenMs = Math.max(0, Number(arg('sleep-between-ms', '500')) || 0);
const checkpointEvery = Math.max(1, Number(arg('checkpoint-every', '1')) || 1);
const startRow = Math.max(2, Number(arg('start-row', '2')) || 2);

if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/evaluate_rag_report.js --in <input.xlsx> --out <output.xlsx> [--sheet <name>] [--limit 100] [--start-row 2] [--require-rag 1] [--fail-fast 1] [--max-consecutive-errors 3] [--retries 2] [--sleep-between-ms 500] [--checkpoint-every 1]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normalizeHeader = (s) => String(s || '')
  .replace(/\u00a0/g, ' ')
  .toLowerCase()
  .replace(/[%()]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const hasCjk = (s) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(String(s || ''));
const normalizeText = (s) => String(s || '')
  .replace(/\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const tokenize = (s) => {
  const t = normalizeText(s).toLowerCase();
  if (!t) return [];
  if (hasCjk(t)) {
    const compact = t.replace(/[^\p{L}\p{N}]/gu, '');
    const grams = [];
    for (let i = 0; i < compact.length - 1; i += 1) grams.push(compact.slice(i, i + 2));
    return grams.length ? grams : compact.split('');
  }
  return t
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((x) => x.length > 1);
};

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

function getCellText(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  if (v && typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((x) => String(x.text || '')).join('').trim();
    if (v.text != null) return String(v.text).trim();
    if (v.result != null) return String(v.result).trim();
    if (v.hyperlink != null) return String(v.text || v.hyperlink || '').trim();
  }
  return String(v).trim();
}

function mapColumns(ws) {
  const row = ws.getRow(1);
  const m = new Map();
  row.eachCell((cell, col) => {
    m.set(normalizeHeader(getCellText(cell.value)), col);
  });
  const required = ['question', 'answer', 'source'];
  for (const r of required) {
    if (!m.get(r)) throw new Error(`Missing required column: ${r}`);
  }
  return m;
}

function extractBotAnswer(content) {
  const raw = String(content || '').trim();
  if (!raw) return '';
  const single = raw.match(/<!--SINGLE_LANG_START-->([\s\S]*?)<!--SINGLE_LANG_END-->/);
  if (single) {
    try {
      const parsed = JSON.parse(single[1]);
      return String(parsed?.content || '').trim();
    } catch {
      return raw;
    }
  }
  const dual = raw.match(/<!--DUAL_LANG_START-->([\s\S]*?)<!--DUAL_LANG_END-->/);
  if (dual) {
    try {
      const parsed = JSON.parse(dual[1]);
      return String(parsed?.translated || parsed?.japanese || '').trim();
    } catch {
      return raw;
    }
  }
  return raw;
}

function splitAnswerAndSources(answer) {
  const text = String(answer || '').trim();
  const match = text.match(/(?:^|\n|\s)(出典|Sources?)\s*[:：]\s*([\s\S]*)$/i);
  if (!match) return { cleanAnswer: normalizeText(text), sources: '' };
  const srcBlock = String(match[2] || '')
    .replace(/\r/g, '\n')
    .replace(/\s+\d+[\.\)]\s+/g, '\n$&')
    .trim();
  const sources = srcBlock
    .split('\n')
    .map((s) => normalizeText(s.replace(/^\d+[\.\)]\s*/, '')))
    .filter(Boolean)
    .join(' | ');
  const cleanAnswer = normalizeText(text.slice(0, match.index || 0));
  return { cleanAnswer, sources };
}

async function login() {
  const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: EMPLOYEE_ID, password: PASSWORD }),
  });
  const data = await res.json().catch(() => ({}));
  const token = data?.result?.token;
  if (!token) throw new Error(`Login failed: HTTP ${res.status}`);
  return token;
}

async function createTask(token, query) {
  const payload = {
    type: 'CHAT',
    formData: {
      prompt: query,
      fieldSort: 1,
      taskId: `excel-report-${crypto.randomUUID()}`,
      fileId: [0],
      allFileSearch: ALL_FILE_SEARCH,
      useMcp: false,
    },
  };
  const res = await fetch(`${API_BASE_URL}/api/gen-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  const taskId = data?.result?.taskId;
  if (!taskId) throw new Error(`Task creation failed: HTTP ${res.status}; body=${JSON.stringify(data).slice(0, 400)}`);
  return String(taskId);
}

async function pollTask(token, taskId) {
  const started = Date.now();
  let pollCycles = 0;
  while (Date.now() - started < TIMEOUT_MS) {
    pollCycles += 1;
    const url = `${API_BASE_URL}/api/gen-task-output/list?pageNum=1&pageSize=50&taskId=${encodeURIComponent(taskId)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    const rows = data?.result?.rows || [];
    const row = rows.find((r) => Number(r.sort) === 1) || rows[0];
    if (row) {
      const status = String(row.status || '');
      if (status === 'FINISHED' || status === 'FAILED' || status === 'CANCEL') {
        return {
          status,
          outputId: Number(row.id || 0) || null,
          content: getCellText(row.content),
          totalMs: Date.now() - started,
          pollCycles,
        };
      }
    }
    await sleep(POLL_MS);
  }
  return { status: 'TIMEOUT', outputId: null, content: '', totalMs: Date.now() - started, pollCycles };
}

async function fetchKpi(token, outputId) {
  if (!outputId) return null;
  const res = await fetch(`${API_BASE_URL}/api/rag/kpi?outputId=${encodeURIComponent(String(outputId))}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  return data?.data || null;
}

async function fetchTrace(token, taskId, outputId) {
  if (!taskId || !outputId) return null;
  const url = `${API_BASE_URL}/api/rag/trace?taskId=${encodeURIComponent(String(taskId))}&outputId=${encodeURIComponent(String(outputId))}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  return data?.data || null;
}

async function translateToEnglish(token, outputId) {
  if (!outputId) return { text: '', ms: 0, error: '' };
  const started = Date.now();
  const res = await fetch(`${API_BASE_URL}/api/gen-task/translate-on-demand`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ outputId: Number(outputId), targetLanguage: 'en' }),
  });
  const data = await res.json().catch(() => ({}));
  const ms = Date.now() - started;
  const text = normalizeText(data?.result?.content || data?.data?.content || '');
  if (!res.ok || !text) {
    return { text: '', ms, error: `translate failed HTTP ${res.status}` };
  }
  return { text, ms, error: '' };
}

function evaluate(expected, actual, expectedSource) {
  if (!String(expected || '').trim()) {
    return { recallPct: '', jaccardPct: '', semanticApprox: '', sourceMatch: 'N/A', verdict: 'NO_EXPECTED_ANSWER' };
  }
  const expTokens = tokenize(expected);
  const outTokens = tokenize(actual);
  const recallPct = Math.round(overlapRecall(expTokens, outTokens) * 100);
  const jaccardPct = Math.round(jaccard(expTokens, outTokens) * 100);
  const semanticApprox = Math.round((recallPct * 0.6) + (jaccardPct * 0.4));
  const source = String(expectedSource || '').trim();
  const sourceMatch = source ? (String(actual || '').toLowerCase().includes(source.toLowerCase()) ? 'YES' : 'NO') : 'N/A';
  const verdict = semanticApprox >= 75 ? 'PASS' : semanticApprox >= 45 ? 'PARTIAL' : 'FAIL';
  return { recallPct, jaccardPct, semanticApprox, sourceMatch, verdict };
}

const fmtSec = (ms) => (Number.isFinite(ms) && ms > 0 ? (ms / 1000).toFixed(2) : 'N/A');

function autosize(ws, count) {
  for (let i = 1; i <= count; i += 1) {
    if (i === 2 || i === 4 || i === 5) ws.getColumn(i).width = 56;
    else if (i === 3 || i === 6) ws.getColumn(i).width = 44;
    else ws.getColumn(i).width = 18;
  }
}

async function run() {
  const sourceWb = new ExcelJS.Workbook();
  await sourceWb.xlsx.readFile(path.resolve(inputPath));
  const sourceWs = sheetName ? sourceWb.getWorksheet(sheetName) : sourceWb.worksheets[0];
  if (!sourceWs) throw new Error('Source worksheet not found');
  const col = mapColumns(sourceWs);

  const reportWb = new ExcelJS.Workbook();
  const detail = reportWb.addWorksheet('Evaluation Report');
  const summary = reportWb.addWorksheet('Summary');

  const headers = [
    'S.NO',
    'Question',
    'Expected Answer',
    'Expected Source',
    'Bot Answer (Japanese)',
    'English Translation',
    'Source(s) from Bot',
    'Status',
    'Total (s)',
    'TTFT (s)',
    'Queue (s)',
    'Poll cycles',
    'Backend total (s)',
    'RAG (s)',
    'LLM (s)',
    'Title (s)',
    'Retrieval (s)',
    'RAG Search Time (ms)',
    'LLM Generation Time (ms)',
    'Translation Time (ms)',
    'Total Response Time (ms)',
    'Input Tokens (estimated)',
    'Output Tokens (estimated)',
    'Total Tokens (estimated)',
    'Accuracy Recall %',
    'Accuracy Jaccard %',
    'Semantic Score %',
    'Evaluation',
    'RAG Used',
    'Remarks',
  ];
  detail.addRow(headers);
  detail.getRow(1).font = { bold: true };
  autosize(detail, headers.length);

  const token = await login();
  let processed = 0;
  let pass = 0;
  let partial = 0;
  let fail = 0;
  let failedRows = 0;
  let noExpected = 0;
  let consecutiveErrors = 0;
  let totalMsSum = 0;
  let ragMsSum = 0;
  let llmMsSum = 0;
  let trMsSum = 0;
  let semSum = 0;

  for (let r = startRow; r <= sourceWs.rowCount; r += 1) {
    if (processed >= limit) break;
    const row = sourceWs.getRow(r);
    const question = getCellText(row.getCell(col.get('question')).value);
    if (!question) continue;

    processed += 1;
    const serial = getCellText(row.getCell(col.get(normalizeHeader('S.NO')) || 1).value) || processed;
    const expectedAnswer = getCellText(row.getCell(col.get('answer')).value);
    const expectedSource = getCellText(row.getCell(col.get('source')).value);

    console.log(`[${processed}/${limit}] ${question.slice(0, 100)}`);

    let status = 'ERROR';
    let taskId = '';
    let outputId = '';
    let botAnswer = '';
    let botSources = '';
    let english = '';
    let kpi = null;
    let trace = null;
    let remark = '';
    let pollCycles = 0;
    let totalFromPollMs = 0;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        taskId = await createTask(token, question);
        const out = await pollTask(token, taskId);
        status = out.status;
        pollCycles = Number(out.pollCycles || 0);
        totalFromPollMs = Number(out.totalMs || 0);
        outputId = out.outputId ? String(out.outputId) : '';
        const parsedAnswer = splitAnswerAndSources(extractBotAnswer(out.content || ''));
        botAnswer = parsedAnswer.cleanAnswer;
        botSources = parsedAnswer.sources;
        kpi = await fetchKpi(token, out.outputId);
        trace = await fetchTrace(token, taskId, out.outputId);
        const tr = await translateToEnglish(token, out.outputId);
        english = tr.text;
        if (tr.error) remark = tr.error;
        if (!kpi) remark = 'KPI not found for output';
        break;
      } catch (e) {
        remark = e?.message || String(e);
        status = 'ERROR';
        if (attempt < retries) {
          await sleep(700 * (attempt + 1));
          continue;
        }
      }
    }

    if (status === 'ERROR') consecutiveErrors += 1;
    else consecutiveErrors = 0;

    const ragMs = Number(kpi?.retrievalMs || kpi?.ragMs || 0) || 0;
    const llmMs = Number(kpi?.llmMs || 0) || 0;
    const trMs = Number(kpi?.translationMs || 0) || 0;
    const totalMs = Number(kpi?.totalMs || 0) || 0;
    const titleMs = Number(kpi?.titleMs || 0) || 0;
    const inTok = Number(kpi?.inputTokens || 0) || 0;
    const outTok = Number(kpi?.outputTokens || 0) || 0;
    const totTok = inTok + outTok;
    const backendTotalMs = Number(trace?.totalMs || 0) || 0;
    const ttftMs = Number(trace?.ttftMs || 0) || 0;
    const queueMs = backendTotalMs > 0 && totalFromPollMs > 0 ? Math.max(0, totalFromPollMs - backendTotalMs) : 0;
    const ragUsed = kpi?.ragUsed === true;
    const statusLabel = status === 'FINISHED' ? 'Completed' : status;

    let ev = { recallPct: '', jaccardPct: '', semanticApprox: '', sourceMatch: 'N/A', verdict: 'ERROR_NO_RESULT' };
    if (statusLabel === 'Completed') {
      ev = evaluate(expectedAnswer, botAnswer, expectedSource);
      if (ev.verdict === 'PASS') pass += 1;
      else if (ev.verdict === 'PARTIAL') partial += 1;
      else if (ev.verdict === 'NO_EXPECTED_ANSWER') noExpected += 1;
      else fail += 1;
    } else {
      failedRows += 1;
    }

    let finalEval = ev.verdict;
    if (requireRag && status === 'FINISHED' && !ragUsed) {
      finalEval = 'INVALID_NO_RAG';
      remark = `${remark ? `${remark}; ` : ''}RAG not used for this query`;
    }

    if (statusLabel === 'Completed') {
      totalMsSum += totalMs;
      ragMsSum += ragMs;
      llmMsSum += llmMs;
      trMsSum += trMs;
      semSum += Number(ev.semanticApprox || 0);
    }

    detail.addRow([
      serial,
      question,
      expectedAnswer,
      expectedSource,
      botAnswer,
      english,
      botSources,
      statusLabel,
      fmtSec(totalMs),
      fmtSec(ttftMs),
      fmtSec(queueMs),
      pollCycles,
      fmtSec(backendTotalMs),
      fmtSec(Number(kpi?.ragMs || 0) || 0),
      fmtSec(llmMs),
      fmtSec(titleMs),
      fmtSec(ragMs),
      ragMs || 'N/A',
      llmMs || 'N/A',
      trMs || 'N/A',
      totalMs || 'N/A',
      inTok || 'N/A',
      outTok || 'N/A',
      totTok || 'N/A',
      ev.recallPct,
      ev.jaccardPct,
      ev.semanticApprox,
      finalEval,
      ragUsed ? 'YES' : 'NO',
      remark || `taskId=${taskId}; outputId=${outputId}`,
    ]);

    if (processed % checkpointEvery === 0) {
      await reportWb.xlsx.writeFile(path.resolve(outputPath));
      console.log(`checkpoint saved (${processed} rows): ${path.resolve(outputPath)}`);
    }

    if (failFast && consecutiveErrors >= maxConsecutiveErrors) {
      throw new Error(
        `Aborting: ${consecutiveErrors} consecutive request errors. Last error: ${remark || 'unknown'}. ` +
        'Your API/queue is rejecting requests before RAG execution.',
      );
    }

    if (sleepBetweenMs > 0) {
      await sleep(sleepBetweenMs);
    }
  }

  const avg = (n) => (processed ? Math.round((n / processed) * 100) / 100 : 0);
  summary.addRow(['Metric', 'Value']);
  summary.getRow(1).font = { bold: true };
  summary.addRows([
    ['Input File', path.resolve(inputPath)],
    ['Sheet', sourceWs.name],
    ['Processed Questions', processed],
    ['Failed Rows (no final answer)', failedRows],
    ['PASS', pass],
    ['PARTIAL', partial],
    ['FAIL', fail],
    ['NO_EXPECTED_ANSWER', noExpected],
    ['Avg Semantic Score %', avg(semSum)],
    ['Avg Total Response Time (ms)', avg(totalMsSum)],
    ['Avg RAG Search Time (ms)', avg(ragMsSum)],
    ['Avg LLM Generation Time (ms)', avg(llmMsSum)],
    ['Avg Translation Time (ms)', avg(trMsSum)],
    ['Generated At', new Date().toISOString()],
  ]);
  summary.getColumn(1).width = 36;
  summary.getColumn(2).width = 50;

  await reportWb.xlsx.writeFile(path.resolve(outputPath));
  console.log(`Done. Generated report: ${path.resolve(outputPath)} (processed ${processed})`);
}

run().catch((e) => {
  console.error(`Evaluation failed: ${e.message || String(e)}`);
  process.exit(1);
});
