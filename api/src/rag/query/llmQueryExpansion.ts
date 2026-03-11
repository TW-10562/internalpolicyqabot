const DEFAULT_LLM_BASE_URL = 'http://localhost:9080/v1';
const DEFAULT_LLM_MODEL = 'openai/gpt-oss-20b';
const DEFAULT_TIMEOUT_MS = 7000;

const normalizeBaseUrl = (value: string): string =>
  String(value || '').trim().replace(/\/+$/, '');

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

const uniqueLines = (values: string[], limit: number): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
};

const callGateway = async ({
  prompt,
  temperature = 0.1,
  maxTokens = 180,
  timeoutMsOverride,
}: {
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMsOverride?: number;
}): Promise<string> => {
  const baseUrl = normalizeBaseUrl(process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL);
  const model = String(process.env.LLM_MODEL || DEFAULT_LLM_MODEL).trim() || DEFAULT_LLM_MODEL;
  const timeoutMs = Math.max(
    2000,
    Number(timeoutMsOverride || process.env.RAG_LLM_QUERY_EXPANSION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  );
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.APISIX_API_KEY ||
    '';

  if (!baseUrl) return '';

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
      { role: 'system', content: 'You help retrieval query expansion for enterprise HR documents.' },
      { role: 'user', content: prompt },
    ],
    temperature,
    max_tokens: maxTokens,
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

export const generateQueryVariants = async (
  query: string,
  language: 'ja' | 'en',
): Promise<string[]> => {
  const source = String(query || '').trim();
  if (!source) return [];

  const prompt = [
    'You are helping a search system retrieve documents.',
    '',
    'Generate 5 short search queries that could retrieve relevant HR policy documents.',
    '',
    `Query: ${source}`,
    '',
    'Return only search queries separated by newline.',
    `User language: ${language}`,
  ].join('\n');

  const content = await callGateway({
    prompt,
    temperature: 0.1,
    maxTokens: 180,
    timeoutMsOverride: Number(process.env.RAG_LLM_QUERY_EXPANSION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  });
  if (!content) return [];

  const rawLines = String(content)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]\s*|\d+[.)]\s*)/, '').trim())
    .filter(Boolean);

  const cleaned = rawLines
    .map((line) => line.replace(/^["'`]|["'`]$/g, '').trim())
    .filter((line) => line.length >= 2)
    .filter((line) => line.toLowerCase() !== source.toLowerCase());

  return uniqueLines(cleaned, 5);
};

export const translateQueryToJapaneseHR = async (query: string): Promise<string> => {
  const source = String(query || '').trim();
  if (!source) return '';
  const prompt = [
    'Translate the following search query into Japanese HR terminology.',
    '',
    'Query:',
    source,
  ].join('\n');
  const translated = await callGateway({
    prompt,
    temperature: 0,
    maxTokens: 80,
    timeoutMsOverride: Number(process.env.RAG_LLM_QUERY_TRANSLATION_TIMEOUT_MS || 5000),
  });
  return String(translated || '')
    .split(/\r?\n/)[0]
    .replace(/^["'`]|["'`]$/g, '')
    .trim();
};

export const repairQueryForHrRetrieval = async (query: string): Promise<string> => {
  const source = String(query || '').trim();
  if (!source) return '';
  const prompt = [
    'Rewrite this search query so it can retrieve HR policy documents.',
    '',
    'Query:',
    source,
  ].join('\n');
  const repaired = await callGateway({
    prompt,
    temperature: 0.1,
    maxTokens: 80,
    timeoutMsOverride: Number(process.env.RAG_LLM_QUERY_REPAIR_TIMEOUT_MS || 5000),
  });
  return String(repaired || '')
    .split(/\r?\n/)[0]
    .replace(/^["'`]|["'`]$/g, '')
    .trim();
};
