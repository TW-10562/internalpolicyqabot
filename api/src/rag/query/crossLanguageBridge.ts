import { detectRagLanguage } from '@/rag/language/detectLanguage';
import { openaiClient } from '@/service/openai_client';

const DEFAULT_TIMEOUT_MS = 7000;
const MAX_GENERATED_TERMS = 5;
const DEFAULT_MAX_ATTEMPTS = 1;
const QUERY_LLM_REASONING_EFFORT = String(
  process.env.RAG_LLM_REASONING_EFFORT ||
  process.env.LLM_REASONING_EFFORT ||
  'low',
).trim();

const normalizeLine = (value: string): string =>
  String(value || '')
    .replace(/^\s*(?:[-*]\s*|\d+[.)]\s*)/, '')
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const uniqueLines = (values: string[], limit: number): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = normalizeLine(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
};

const callGateway = async (prompt: string): Promise<string> => {
  const timeoutMs = Math.max(2000, Number(process.env.RAG_CROSS_LANGUAGE_BRIDGE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  const maxAttempts = Math.max(
    1,
    Math.min(2, Number(process.env.RAG_CROSS_LANGUAGE_BRIDGE_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS)),
  );
  if (!prompt) return '';

  try {
    const response = await openaiClient.generate(
      [
        { role: 'system', content: 'You help retrieve Japanese HR policy documents.' },
        { role: 'user', content: prompt },
      ],
      {
        temperature: 0.1,
        max_tokens: 120,
        top_p: 1,
        stream: false,
        timeout_ms: timeoutMs,
        max_attempts: maxAttempts,
        retry_on_empty: false,
        allow_reasoning_fallback: true,
        extra_body: QUERY_LLM_REASONING_EFFORT
          ? { reasoning_effort: QUERY_LLM_REASONING_EFFORT }
          : undefined,
      },
    );
    return String(response?.content || '').trim();
  } catch {
    return '';
  }
};

export const generateJapaneseQueryVariants = async (query: string): Promise<string[]> => {
  const source = String(query || '').trim();
  if (!source) return [];

  const language = detectRagLanguage(source);
  if (language !== 'en') return [];

  const prompt = [
    'You are helping retrieve Japanese HR policy documents.',
    '',
    'User query:',
    source,
    '',
    'Generate 4-6 Japanese HR terminology search phrases that could appear in internal policy documents.',
    'Prefer official business-document wording rather than conversational Japanese.',
    'If the query asks about a process, reporting flow, approval, or procedure, include at least two phrases with terms like 手続き, 手順, 報告, 届出, 申請, or フロー.',
    'If the query is about violations, misconduct, discipline, or incidents, prefer policy terms such as 懲戒, 懲戒事案, 懲戒案件, 規程, and 報告.',
    'Do not broaden the topic into adjacent policies, reimbursements, vehicle-use rules, or other related HR concepts unless the user explicitly asked for them.',
    'Do not invent document artifacts such as forms, templates, guides, report names, or approval-flow names unless the user explicitly asked for them.',
    'Keep each phrase short and close to the original entity being requested.',
    '',
    'Return only phrases separated by newline.',
  ].join('\n');

  const content = await callGateway(prompt);
  if (!content) return [];

  const lines = String(content).split(/\r?\n/).map((line) => normalizeLine(line)).filter(Boolean);
  const japaneseOnly = lines.filter((line) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(line));
  return uniqueLines(japaneseOnly, MAX_GENERATED_TERMS);
};
