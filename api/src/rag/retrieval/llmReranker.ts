const DEFAULT_LLM_BASE_URL = 'http://localhost:9080/v1';
const DEFAULT_LLM_MODEL = 'openai/gpt-oss-20b';

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

const callGateway = async (prompt: string): Promise<string> => {
  const baseUrl = normalizeBaseUrl(process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL);
  const model = String(process.env.LLM_MODEL || DEFAULT_LLM_MODEL).trim() || DEFAULT_LLM_MODEL;
  const timeoutMs = Math.max(2000, Number(process.env.RAG_LLM_RERANK_TIMEOUT_MS || 6000));
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.APISIX_API_KEY ||
    '';
  if (!baseUrl) return '';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers.apikey = apiKey;
    headers['x-api-key'] = apiKey;
  }

  const payload = {
    model,
    messages: [
      { role: 'system', content: 'You rerank documents for enterprise HR retrieval.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: 140,
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

export const rerankDocuments = async (query: string, docs: any[]): Promise<any[]> => {
  const inputDocs = Array.isArray(docs) ? docs : [];
  if (inputDocs.length <= 1) return inputDocs;

  const candidates = inputDocs.slice(0, 12).map((doc, index) => ({
    rid: `DOC_${index + 1}`,
    doc,
    title: String((Array.isArray(doc?.title) ? doc.title[0] : doc?.title) || doc?.file_name_s || doc?.id || '').trim(),
  }));
  const prompt = [
    'Select the documents most relevant to the user query.',
    '',
    'Query:',
    String(query || '').trim(),
    '',
    'Documents:',
    ...candidates.map((row) => `${row.rid}: ${row.title || 'Untitled'}`),
    '',
    'Return the IDs of the top 5 documents.',
  ].join('\n');

  const text = await callGateway(prompt);
  if (!text) return inputDocs;

  const orderedIds = Array.from(new Set((text.match(/DOC_\d+/g) || []).map((v) => String(v || '').trim())));
  if (orderedIds.length === 0) return inputDocs;

  const ranked: any[] = [];
  const seen = new Set<string>();
  for (const rid of orderedIds) {
    const hit = candidates.find((row) => row.rid === rid);
    if (!hit) continue;
    const key = String(hit.doc?.id || hit.rid);
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push(hit.doc);
    if (ranked.length >= 5) break;
  }
  for (const doc of inputDocs) {
    const key = String(doc?.id || '');
    if (key && seen.has(key)) continue;
    ranked.push(doc);
  }
  return ranked;
};

