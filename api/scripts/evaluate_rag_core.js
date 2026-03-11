/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:8080';
const EMPLOYEE_ID = process.env.BENCH_EMPLOYEE_ID || 'admin';
const PASSWORD = process.env.BENCH_PASSWORD || '12345';
const POLL_MS = Number(process.env.BENCH_POLL_MS || 700);
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 120000);
const ALL_FILE_SEARCH = process.env.BENCH_ALL_FILE_SEARCH !== '0';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? String(args[i + 1] || '') : fallback;
};

const casesPath = arg('cases', path.join(__dirname, 'rag_eval_cases.json'));
const enforceGate = arg('enforce-gate', process.env.RAG_EVAL_ENFORCE_GATE || '1') !== '0';
const minHitAtK = Number(arg('min-hit-at-k', process.env.RAG_EVAL_MIN_HIT_AT_K || '0.55'));
const minGroundedRate = Number(arg('min-grounded-rate', process.env.RAG_EVAL_MIN_GROUNDED_RATE || '0.70'));
const minSourceTermOkRate = Number(arg('min-source-term-ok-rate', process.env.RAG_EVAL_MIN_SOURCE_TERM_OK_RATE || '0.65'));
const minRefusalPrecision = Number(arg('min-refusal-precision', process.env.RAG_EVAL_MIN_REFUSAL_PRECISION || '0.60'));
const maxAvgLatencyMs = Number(arg('max-avg-latency-ms', process.env.RAG_EVAL_MAX_AVG_LATENCY_MS || '30000'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      taskId: `rag-eval-${crypto.randomUUID()}`,
      fileId: [0],
      allFileSearch: ALL_FILE_SEARCH,
      useMcp: false,
      debug: true,
    },
  };
  const res = await fetch(`${API_BASE_URL}/api/gen-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  const taskId = data?.result?.taskId;
  if (!taskId) throw new Error(`Task creation failed: HTTP ${res.status}`);
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

function extractAnswer(content) {
  const single = content.match(/<!--SINGLE_LANG_START-->([\s\S]*?)<!--SINGLE_LANG_END-->/);
  if (single) {
    try {
      const parsed = JSON.parse(single[1]);
      return String(parsed?.content || '').trim();
    } catch {
      return String(content || '').trim();
    }
  }
  return String(content || '').trim();
}

function parseDebug(answer) {
  const idx = answer.indexOf('[debug]');
  if (idx === -1) return null;
  const block = answer.slice(idx).trim();
  const lines = block.split('\n');
  const trace = {};
  let currentKey = null;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    if (line.includes(':') && !line.startsWith('-')) {
      const [k, ...rest] = line.split(':');
      const v = rest.join(':').trim();
      currentKey = k.trim();
      if (v) {
        trace[currentKey] = v;
        currentKey = null;
      } else {
        trace[currentKey] = [];
      }
      continue;
    }
    if (line.startsWith('-') && currentKey) {
      const item = line.replace(/^-+\s*/, '');
      trace[currentKey].push(item);
    }
  }
  return trace;
}

function isRefusal(answer) {
  return /I can’t confirm from the provided documents|提供された文書から確認できません/.test(answer);
}

function hasInlineCitations(answer) {
  return /\[\d{1,2}\]/.test(answer);
}

function sourcesInAnswer(answer) {
  const sourceLines = String(answer || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^SOURCE\s*:/i.test(line))
    .map((line) => line.replace(/^SOURCE\s*:\s*/i, '').trim())
    .filter(Boolean);
  if (sourceLines.length) return sourceLines;

  const match = answer.match(/(?:^|\n)(Sources|出典)\s*:\s*([\s\S]*)$/i);
  if (!match) return [];
  return match[2]
    .split('\n')
    .map((s) => s.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(Boolean);
}

function sourceTermsCheck(sources, expectedTerms, forbiddenTerms) {
  const hay = String((sources || []).join(' ').toLowerCase());
  const expected = Array.isArray(expectedTerms) ? expectedTerms : [];
  const forbidden = Array.isArray(forbiddenTerms) ? forbiddenTerms : [];

  const expectedHit = expected.length
    ? expected.some((term) => hay.includes(String(term || '').toLowerCase()))
    : true;
  const forbiddenHit = forbidden.length
    ? forbidden.some((term) => hay.includes(String(term || '').toLowerCase()))
    : false;

  return { expectedHit, forbiddenHit };
}

async function run() {
  if (!fs.existsSync(casesPath)) {
    throw new Error(`Cases file not found: ${casesPath}`);
  }
  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf-8'));
  if (!Array.isArray(cases)) throw new Error('Cases file must be a JSON array');

  const token = await login();
  const stats = {
    total: 0,
    answered: 0,
    refused: 0,
    grounded: 0,
    refusal_correct: 0,
    retrieval_hits: 0,
    retrieval_checks: 0,
    source_terms_ok: 0,
    source_terms_checked: 0,
    total_latency_ms: 0,
  };

  for (const c of cases) {
    stats.total += 1;
    const query = String(c.query || '');
    const expectedSources = Array.isArray(c.expected_sources) ? c.expected_sources : [];
    const expectedSourceTerms = Array.isArray(c.expected_source_terms) ? c.expected_source_terms : [];
    const forbiddenSourceTerms = Array.isArray(c.forbidden_source_terms) ? c.forbidden_source_terms : [];
    const shouldAnswer = c.should_answer !== false;

    const taskId = await createTask(token, query);
    const result = await pollTask(token, taskId);
    const answer = extractAnswer(result.content);
    const refused = isRefusal(answer);

    if (!refused) stats.answered += 1;
    if (refused) stats.refused += 1;

    if (shouldAnswer === false && refused) stats.refusal_correct += 1;

    if (!refused && hasInlineCitations(answer) && sourcesInAnswer(answer).length) {
      stats.grounded += 1;
    }

    stats.total_latency_ms += result.totalMs || 0;

    const debug = parseDebug(answer);
    const sourceList = sourcesInAnswer(answer);
    const sourceTermResult = sourceTermsCheck(sourceList, expectedSourceTerms, forbiddenSourceTerms);
    const hasSourceTermExpectation = expectedSourceTerms.length > 0 || forbiddenSourceTerms.length > 0;
    if (hasSourceTermExpectation) {
      stats.source_terms_checked += 1;
      if (sourceTermResult.expectedHit && !sourceTermResult.forbiddenHit) {
        stats.source_terms_ok += 1;
      }
    }

    if (expectedSources.length && debug?.retrieved) {
      stats.retrieval_checks += 1;
      const retrievedIds = debug.retrieved.map((x) => {
        try {
          const parsed = JSON.parse(x);
          return parsed.id;
        } catch {
          const idMatch = String(x).match(/id":"?([^",}]+)"?/);
          return idMatch ? idMatch[1] : null;
        }
      }).filter(Boolean);
      const hit = expectedSources.some((src) => retrievedIds.includes(src));
      if (hit) stats.retrieval_hits += 1;
    }

    console.log(JSON.stringify({
      query,
      status: result.status,
      refused,
      grounded: !refused && hasInlineCitations(answer),
      source_terms_ok: sourceTermResult.expectedHit && !sourceTermResult.forbiddenHit,
      source_forbidden_hit: sourceTermResult.forbiddenHit,
      latency_ms: result.totalMs,
    }));
  }

  const summary = {
    total: stats.total,
    answered: stats.answered,
    refused: stats.refused,
    retrieval_checks: stats.retrieval_checks,
    source_terms_checked: stats.source_terms_checked,
    hit_at_k: stats.retrieval_checks ? stats.retrieval_hits / stats.retrieval_checks : null,
    grounded_rate: stats.answered ? stats.grounded / stats.answered : null,
    source_term_ok_rate: stats.source_terms_checked ? stats.source_terms_ok / stats.source_terms_checked : null,
    refusal_precision: stats.refused ? stats.refusal_correct / stats.refused : null,
    avg_latency_ms: stats.total ? Math.round(stats.total_latency_ms / stats.total) : 0,
  };

  const gateFailures = [];
  if (enforceGate) {
    if (summary.retrieval_checks > 0 && summary.hit_at_k != null && summary.hit_at_k < minHitAtK) {
      gateFailures.push(`hit_at_k ${summary.hit_at_k.toFixed(3)} < ${minHitAtK.toFixed(3)}`);
    }
    if (summary.grounded_rate != null && summary.grounded_rate < minGroundedRate) {
      gateFailures.push(`grounded_rate ${summary.grounded_rate.toFixed(3)} < ${minGroundedRate.toFixed(3)}`);
    }
    if (summary.source_terms_checked > 0 && summary.source_term_ok_rate != null && summary.source_term_ok_rate < minSourceTermOkRate) {
      gateFailures.push(`source_term_ok_rate ${summary.source_term_ok_rate.toFixed(3)} < ${minSourceTermOkRate.toFixed(3)}`);
    }
    if (summary.refused > 0 && summary.refusal_precision != null && summary.refusal_precision < minRefusalPrecision) {
      gateFailures.push(`refusal_precision ${summary.refusal_precision.toFixed(3)} < ${minRefusalPrecision.toFixed(3)}`);
    }
    if (Number.isFinite(maxAvgLatencyMs) && maxAvgLatencyMs > 0 && summary.avg_latency_ms > maxAvgLatencyMs) {
      gateFailures.push(`avg_latency_ms ${summary.avg_latency_ms} > ${Math.round(maxAvgLatencyMs)}`);
    }
  }

  console.log(JSON.stringify({ event: 'rag_eval_summary', summary }, null, 2));
  if (enforceGate) {
    if (gateFailures.length > 0) {
      console.error(JSON.stringify({ event: 'rag_eval_gate_failed', gate_failures: gateFailures }, null, 2));
      process.exit(2);
    }
    console.log(JSON.stringify({ event: 'rag_eval_gate_passed' }, null, 2));
  }
}

run().catch((e) => {
  console.error(JSON.stringify({ event: 'rag_eval_error', message: e?.message || String(e) }));
  process.exit(1);
});
