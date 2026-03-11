type RagCitation = {
  source_id: string;
  title?: string;
  quote?: string;
  page?: number;
};

export type RagStructuredResponse = {
  answer: string;
  citations: RagCitation[];
  confidence?: 'high' | 'medium' | 'low';
  clarifying_question?: string;
  cannot_answer_reason?: string;
  trace?: Record<string, unknown>;
};

export type RagDoc = {
  id: string;
  title: string;
  content: string;
};

const normalizeText = (s: string) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase();

const normalizeQuote = (s: string) =>
  normalizeText(s)
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const extractJsonBlock = (raw: string): string => {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith('{') && text.endsWith('}')) return text;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return text.slice(start, end + 1);
};

export const parseStructuredResponse = (raw: string): { ok: boolean; data?: RagStructuredResponse; error?: string } => {
  const json = extractJsonBlock(raw);
  if (!json) return { ok: false, error: 'no_json' };
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'invalid_json' };
    const answer = String(parsed.answer || '').trim();
    const citations = Array.isArray(parsed.citations) ? parsed.citations : [];
    return {
      ok: true,
      data: {
        answer,
        citations: citations.map((c: any) => ({
          source_id: String(c?.source_id || c?.id || ''),
          title: c?.title ? String(c.title) : undefined,
          quote: c?.quote ? String(c.quote) : undefined,
          page: Number.isFinite(Number(c?.page)) ? Number(c.page) : undefined,
        })),
        confidence: parsed.confidence,
        clarifying_question: parsed.clarifying_question ? String(parsed.clarifying_question) : undefined,
        cannot_answer_reason: parsed.cannot_answer_reason ? String(parsed.cannot_answer_reason) : undefined,
        trace: parsed.trace && typeof parsed.trace === 'object' ? parsed.trace : undefined,
      },
    };
  } catch (e) {
    return { ok: false, error: 'parse_error' };
  }
};

const extractInlineCitationMarkers = (answer: string): number[] => {
  const ids = new Set<number>();
  const re = /\[(\d{1,2})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) ids.add(n);
  }
  return [...ids].sort((a, b) => a - b);
};

const sentenceHasCitation = (sentence: string): boolean => /\[\d{1,2}\]/.test(sentence);

const splitSentences = (text: string) =>
  String(text || '')
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

export const validateCitations = (
  response: RagStructuredResponse,
  docs: RagDoc[],
): { ok: boolean; valid: RagCitation[]; reasons: string[] } => {
  const reasons: string[] = [];
  const answer = String(response.answer || '').trim();
  if (!answer) return { ok: false, valid: [], reasons: ['empty_answer'] };

  const inlineMarkers = extractInlineCitationMarkers(answer);
  if (!inlineMarkers.length) {
    reasons.push('missing_inline_citations');
  } else {
    const maxMarker = Math.max(...inlineMarkers);
    if (maxMarker > response.citations.length) {
      reasons.push('inline_marker_out_of_range');
    }
    const sentences = splitSentences(answer);
    const missing = sentences.filter((s) => !sentenceHasCitation(s));
    if (missing.length) reasons.push('sentence_without_citation');
  }

  if (!Array.isArray(response.citations) || response.citations.length === 0) {
    reasons.push('no_citations');
    return { ok: false, valid: [], reasons };
  }

  const docById = new Map(docs.map((d) => [String(d.id), d]));
  const docByTitle = new Map(docs.map((d) => [String(d.title), d]));

  const valid: RagCitation[] = [];
  for (const c of response.citations) {
    const sourceId = String(c.source_id || '').trim();
    const quote = String(c.quote || '').trim();
    const doc = sourceId ? docById.get(sourceId) : (c.title ? docByTitle.get(String(c.title)) : undefined);
    if (!doc) {
      reasons.push(`missing_source:${sourceId || c.title || 'unknown'}`);
      continue;
    }
    if (!quote) {
      reasons.push(`missing_quote:${sourceId}`);
      continue;
    }
    const hay = normalizeQuote(doc.content);
    const needle = normalizeQuote(quote);
    if (!needle || !hay.includes(needle)) {
      reasons.push(`quote_not_found:${sourceId}`);
      continue;
    }
    valid.push({
      source_id: sourceId || doc.id,
      title: c.title || doc.title,
      quote,
      page: c.page,
    });
  }

  if (!valid.length) reasons.push('no_valid_citations');

  return { ok: reasons.length === 0, valid, reasons };
};

export const formatSourcesBlock = (citations: RagCitation[], language: 'ja' | 'en') => {
  const uniq = Array.from(
    new Set(
      citations
        .map((c) => String(c.title || c.source_id || '').trim())
        .filter(Boolean),
    ),
  ).slice(0, 5);
  if (!uniq.length) return '';
  const header = language === 'ja' ? '出典' : 'Sources';
  const lines = uniq.map((s, idx) => `${idx + 1}. ${s}`);
  return `${header}:\n${lines.join('\n')}`;
};

export const enforceMaxLines = (text: string, maxLines: number) => {
  const lines = String(text || '').split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n').trim();
};

export const buildCannotConfirm = (language: 'ja' | 'en', clarifyingQuestion?: string) => {
  const base =
    language === 'ja'
      ? '提供された文書から確認できません。'
      : 'I can’t confirm from the provided documents.';
  const fallbackQuestion =
    language === 'ja'
      ? '対象の規程名または該当資料名を教えてください。'
      : 'Which policy document should I use?';
  return `${base}\n${clarifyingQuestion || fallbackQuestion}`;
};

export const renderDebugTrace = (trace: Record<string, unknown>) => {
  const lines: string[] = [];
  lines.push('[debug]');
  for (const [k, v] of Object.entries(trace || {})) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) {
        lines.push(`- ${typeof item === 'string' ? item : JSON.stringify(item)}`);
      }
    } else if (v && typeof v === 'object') {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  return lines.join('\n');
};
