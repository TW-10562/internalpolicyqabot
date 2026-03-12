import { detectRagLanguage } from '@/rag/language/detectLanguage';

const DEFAULT_LLM_BASE_URL = 'http://localhost:9080/v1';
const DEFAULT_LLM_MODEL = 'openai/gpt-oss-20b';
const DEFAULT_TIMEOUT_MS = 7000;
const MAX_GENERATED_TERMS = 5;

const normalizeBaseUrl = (value: string): string =>
  String(value || '').trim().replace(/\/+$/, '');

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

const extractTextFromContent = (content: any): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') return String(item.text || item.content || '');
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return String(content.text || content.content || '');
  }
  return '';
};

const callGateway = async (prompt: string): Promise<string> => {
  const baseUrl = normalizeBaseUrl(process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL);
  const model = String(process.env.LLM_MODEL || DEFAULT_LLM_MODEL).trim() || DEFAULT_LLM_MODEL;
  const timeoutMs = Math.max(2000, Number(process.env.RAG_CROSS_LANGUAGE_BRIDGE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.APISIX_API_KEY ||
    '';

  if (!baseUrl || !prompt) return '';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers.apikey = apiKey;
    headers['x-api-key'] = apiKey;
  }

  const payload = {
    model,
    messages: [
      { role: 'system', content: 'You help retrieve Japanese HR policy documents.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 120,
    top_p: 1,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return '';
    const data = await response.json();
    return extractTextFromContent(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '').trim();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
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
    '',
    'Return only phrases separated by newline.',
  ].join('\n');

  const content = await callGateway(prompt);
  if (!content) return [];

  const lines = String(content).split(/\r?\n/).map((line) => normalizeLine(line)).filter(Boolean);
  const japaneseOnly = lines.filter((line) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(line));
  return uniqueLines(japaneseOnly, MAX_GENERATED_TERMS);
};
