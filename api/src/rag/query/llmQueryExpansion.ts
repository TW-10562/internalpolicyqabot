import { openaiClient } from '@/service/openai_client';

const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_MAX_ATTEMPTS = 1;
const QUERY_LLM_REASONING_EFFORT = String(
  process.env.RAG_LLM_REASONING_EFFORT ||
  process.env.LLM_REASONING_EFFORT ||
  'low',
).trim();

type QueryRewriteResult = {
  language?: 'en' | 'ja' | 'mixed';
  answer_language?: 'en' | 'ja';
  queries?: string[];
  keywords?: string[];
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

const extractFirstJsonObject = (value: string): string => {
  const source = String(value || '').trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return source.slice(start, end + 1);
};

const parseQueryRewriteResult = (value: string): QueryRewriteResult | null => {
  const jsonText = extractFirstJsonObject(value);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as QueryRewriteResult;
  } catch {
    return null;
  }
};

const callGateway = async ({
  systemPrompt,
  userPrompt,
  temperature = 0.1,
  maxTokens = 180,
  timeoutMsOverride,
}: {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMsOverride?: number;
}): Promise<string> => {
  const timeoutMs = Math.max(
    2000,
    Number(timeoutMsOverride || process.env.RAG_LLM_QUERY_EXPANSION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  );
  const maxAttempts = Math.max(
    1,
    Math.min(2, Number(process.env.RAG_LLM_QUERY_EXPANSION_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS)),
  );
  try {
    const response = await openaiClient.generate(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        temperature,
        max_tokens: maxTokens,
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

export const generateQueryVariants = async (
  query: string,
  language: 'ja' | 'en',
): Promise<string[]> => {
  const source = String(query || '').trim();
  if (!source) return [];

  const systemPrompt = [
    'You are a retrieval query rewriter for a RAG system whose documents are mostly in Japanese.',
    '',
    "Task:",
    "Rewrite the user's query into Japanese retrieval queries optimized for searching Japanese internal policy/HR documents.",
    '',
    'Rules:',
    '1. Preserve important named entities, acronyms, system names, team names, and policy terms.',
    '2. Keep the meaning exact.',
    '3. Do not answer the question.',
    '4. Produce compact retrieval-oriented queries, not conversational text.',
    '5. If the user query is already Japanese, normalize it lightly instead of rewriting heavily.',
    '6. If the query is English, include both English semantic paraphrases and Japanese retrieval phrases.',
    '7. For English queries, return 1-2 English semantic paraphrases and 3-4 Japanese business-document search phrases.',
    '8. Prefer official Japanese policy vocabulary such as 手続き, 手順, 報告, 届出, 申請, 規程, 懲戒, 相談, 防止, 承認 when relevant.',
    '9. Do not drift into adjacent topics, parent categories, or related benefits that were not explicitly asked for.',
    '10. Do not invent forms, report names, templates, guides, or approval-flow labels unless the user explicitly asks for them.',
    '11. Keep each retrieval query short, concrete, and close to the original noun/entity being asked about.',
    '12. Output JSON only.',
    '',
    'Return format:',
    '{',
    '  "language": "en|ja|mixed",',
    '  "answer_language": "en|ja",',
    '  "queries": [',
    '    "query variant 1",',
    '    "query variant 2",',
    '    "query variant 3"',
    '  ],',
    '  "keywords": [',
    '    "important term 1",',
    '    "important term 2"',
    '  ]',
    '}',
  ].join('\n');
  const userPrompt = ['User query:', source].join('\n');

  const content = await callGateway({
    systemPrompt,
    userPrompt,
    temperature: 0.1,
    maxTokens: 240,
    timeoutMsOverride: Number(process.env.RAG_LLM_QUERY_EXPANSION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  });
  if (!content) return [];

  const parsed = parseQueryRewriteResult(content);
  if (parsed?.queries?.length) {
    const parsedQueries = uniqueLines(
      parsed.queries.map((line) => String(line || '').replace(/^["'`]|["'`]$/g, '').trim()),
      5,
    ).filter((line) => line.toLowerCase() !== source.toLowerCase());
    if (parsedQueries.length) return parsedQueries;
  }

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
  const translatedVariants = await generateQueryVariants(source, 'en');
  if (translatedVariants.length > 0) return translatedVariants[0];
  const systemPrompt = 'Translate the following search query into Japanese HR terminology. Return only the translated query.';
  const userPrompt = ['Query:', source].join('\n');
  const translated = await callGateway({
    systemPrompt,
    userPrompt,
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
  const repairedVariants = await generateQueryVariants(source, /[\u3040-\u30ff\u4e00-\u9faf]/.test(source) ? 'ja' : 'en');
  if (repairedVariants.length > 0) return repairedVariants[0];
  const systemPrompt = 'Rewrite this search query so it can retrieve HR policy documents. Return only the rewritten query.';
  const userPrompt = ['Query:', source].join('\n');
  const repaired = await callGateway({
    systemPrompt,
    userPrompt,
    temperature: 0.1,
    maxTokens: 80,
    timeoutMsOverride: Number(process.env.RAG_LLM_QUERY_REPAIR_TIMEOUT_MS || 5000),
  });
  return String(repaired || '')
    .split(/\r?\n/)[0]
    .replace(/^["'`]|["'`]$/g, '')
    .trim();
};
