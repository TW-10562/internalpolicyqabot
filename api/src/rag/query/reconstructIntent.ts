import { openaiClient } from '@/service/openai_client';

const normalizeSpacing = (value: string): string =>
  String(value || '').replace(/\s+/g, ' ').trim();

const uniqueLines = (values: string[], limit: number): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeSpacing(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
};

export type IntentReconstructionGate = {
  shouldApply: boolean;
  tokenCount: number;
  queryLength: number;
};

export const getIntentReconstructionGate = (query: string): IntentReconstructionGate => {
  const normalized = normalizeSpacing(query);
  const tokenCount = normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
  const queryLength = normalized.length;
  const shouldApply = tokenCount <= 2 || queryLength <= 15;
  return { shouldApply, tokenCount, queryLength };
};

export const reconstructIntentQueries = async (
  query: string,
  _language: 'ja' | 'en',
): Promise<string[]> => {
  const source = normalizeSpacing(query);
  if (!source) return [];

  const prompt = [
    'You are helping a document retrieval system understand vague user queries.',
    '',
    'User query:',
    source,
    '',
    'Generate 5 more specific search queries that might retrieve HR policy documents.',
    '',
    'Return only search queries separated by newline.',
  ].join('\n');

  try {
    const response = await openaiClient.generate(
      [
        { role: 'system', content: 'You produce concise retrieval query variants for enterprise HR policy search.' },
        { role: 'user', content: prompt },
      ],
      {
        temperature: 0.1,
        max_tokens: 180,
      },
    );
    const raw = String(response?.content || '');
    if (!raw.trim()) return [];

    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*•]\s*|\d+[.)]\s*)/, '').trim())
      .filter(Boolean)
      .map((line) => line.replace(/^["'`]|["'`]$/g, '').trim())
      .filter((line) => line.length >= 2)
      .filter((line) => line.toLowerCase() !== source.toLowerCase());

    return uniqueLines(lines, 5);
  } catch {
    return [];
  }
};
