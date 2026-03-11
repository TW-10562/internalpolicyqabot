import { QueryClass } from '@/rag/query/queryRouter';

export type GroundedFormatterInput = {
  answer: string;
  language: 'ja' | 'en';
  queryClass: QueryClass;
};

export type GroundedFormatterResult = {
  answer: string;
  mode: 'procedural' | 'policy' | 'factual' | 'generic';
  changed: boolean;
};

const readNumber = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeLine = (line: string): string =>
  String(line || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\-*•●▪︎]+\s*/, '')
    .replace(/^\d+[\).．]\s*/, '')
    .trim();

const splitSourceFooter = (text: string): { body: string; footer: string } => {
  const lines = String(text || '').split('\n');
  let sourceStart = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = String(lines[i] || '').trim();
    if (!line) continue;
    if (/^SOURCES?\s*:/i.test(line)) {
      sourceStart = i;
      break;
    }
    if (line.length > 0) break;
  }
  if (sourceStart < 0) return { body: String(text || '').trim(), footer: '' };
  return {
    body: lines.slice(0, sourceStart).join('\n').trim(),
    footer: lines.slice(sourceStart).join('\n').trim(),
  };
};

const dedupeLines = (lines: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = normalizeLine(value).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
};

const toMeaningfulLines = (body: string): string[] =>
  dedupeLines(
    String(body || '')
      .split('\n')
      .map((line) => String(line || '').trim())
      .filter(Boolean),
  );

const isProceduralLine = (line: string): boolean =>
  /(?:\bsubmit\b|\brequest\b|\bapply\b|\bopen\b|\bclick\b|\bselect\b|\benter\b|\blog\s*in\b|\bconfirm\b|\bapprove\b|申請|提出|入力|選択|確認|承認|ログイン|実施)/i
    .test(String(line || ''));

const asProcedural = (lines: string[], language: 'ja' | 'en'): string => {
  const maxSteps = Math.max(2, readNumber('RAG_GROUNDED_FORMATTER_MAX_STEPS', 8));
  const maxNotes = Math.max(1, readNumber('RAG_GROUNDED_FORMATTER_MAX_NOTES', 3));
  const stepCandidates = lines.map(normalizeLine).filter(Boolean);
  const actionSteps = stepCandidates.filter(isProceduralLine);
  const steps = (actionSteps.length >= 2 ? actionSteps : stepCandidates).slice(0, maxSteps);
  const notes = stepCandidates.filter((line) => !steps.includes(line)).slice(0, maxNotes);

  if (language === 'ja') {
    const rows: string[] = ['手順:'];
    rows.push(...steps.map((step, idx) => `${idx + 1}. ${step}`));
    if (notes.length > 0) {
      rows.push('補足:');
      rows.push(...notes.map((note) => `- ${note}`));
    }
    return rows.join('\n');
  }

  const rows: string[] = ['Steps:'];
  rows.push(...steps.map((step, idx) => `Step ${idx + 1}: ${step}`));
  if (notes.length > 0) {
    rows.push('Notes:');
    rows.push(...notes.map((note) => `- ${note}`));
  }
  return rows.join('\n');
};

const asPolicyOrFactual = (
  lines: string[],
  language: 'ja' | 'en',
  mode: 'policy' | 'factual' | 'generic',
): string => {
  const maxDetails = Math.max(2, readNumber('RAG_GROUNDED_FORMATTER_MAX_DETAILS', 5));
  const normalized = lines.map(normalizeLine).filter(Boolean);
  if (normalized.length === 0) return '';
  const direct = normalized[0];
  const detailLines = normalized.slice(1, maxDetails + 1);
  if (!detailLines.length) return direct;

  if (language === 'ja') {
    const label = mode === 'policy' ? '根拠:' : '詳細:';
    return [direct, `${label}`, ...detailLines.map((line) => `- ${line}`)].join('\n');
  }

  const label = mode === 'policy' ? 'Supporting evidence:' : 'Details:';
  return [direct, `${label}`, ...detailLines.map((line) => `- ${line}`)].join('\n');
};

export const formatGroundedAnswer = (input: GroundedFormatterInput): GroundedFormatterResult => {
  const raw = String(input.answer || '').trim();
  if (!raw) {
    return { answer: raw, mode: 'generic', changed: false };
  }

  const { body, footer } = splitSourceFooter(raw);
  const lines = toMeaningfulLines(body);
  if (!lines.length) {
    return { answer: raw, mode: 'generic', changed: false };
  }

  let mode: GroundedFormatterResult['mode'] = 'generic';
  let formattedBody = body;
  if (input.queryClass === 'procedural') {
    mode = 'procedural';
    formattedBody = asProcedural(lines, input.language);
  } else if (input.queryClass === 'policy') {
    mode = 'policy';
    formattedBody = asPolicyOrFactual(lines, input.language, 'policy');
  } else if (input.queryClass === 'factual' || input.queryClass === 'comparison') {
    mode = 'factual';
    formattedBody = asPolicyOrFactual(lines, input.language, 'factual');
  } else {
    mode = 'generic';
    formattedBody = asPolicyOrFactual(lines, input.language, 'generic');
  }

  const answer = [formattedBody.trim(), footer.trim()].filter(Boolean).join('\n\n');
  return {
    answer,
    mode,
    changed: answer.trim() !== raw,
  };
};

