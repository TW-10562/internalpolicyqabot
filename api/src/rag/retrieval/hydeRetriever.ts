import { config } from '@config/index';

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

const withTimeout = async <T>(factory: () => Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      factory(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${timeoutMs}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const normalizeSentencePair = (text: string): string => {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  const parts = normalized
    .split(/(?<=[。．.!?！？])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!parts.length) return normalized;
  return parts.slice(0, 2).join(' ');
};

const documentKey = (doc: any, fallbackIndex = 0): string => {
  const id = String(doc?.id || '').trim();
  if (id) return id;
  const title = String((Array.isArray(doc?.title) ? doc.title[0] : doc?.title) || '').trim();
  const fileName = String(doc?.file_name_s || '').trim();
  const text = `${title}|${fileName}`.trim();
  return text || `doc_${fallbackIndex + 1}`;
};

type HyDESemanticDoc = {
  doc: any;
  key: string;
  embeddingSimilarity: number;
};

const normalizeHydeSemanticDocs = (raw: any[], topK: number): HyDESemanticDoc[] => {
  const docs = Array.isArray(raw) ? raw : [];
  return docs
    .map((item: any, idx: number) => {
      const metadata = item?.metadata || {};
      const content = String(item?.page_content || '').trim();
      const id = String(item?.id || metadata?.file_id || metadata?.file_path_s || `hyde_${idx + 1}`);
      const title = String(
        metadata?.DocumentName ||
          metadata?.file_name_s ||
          metadata?.title ||
          metadata?.ArticleName ||
          `hyde_doc_${idx + 1}`,
      );

      const rawSimilarity = Number(item?.score ?? item?.similarity ?? item?.relevance_score ?? item?.rerank_score);
      const rawDistance = Number(item?.distance ?? item?.dist ?? item?.vector_distance);
      const embeddingSimilarity =
        Number.isFinite(rawSimilarity) && rawSimilarity > 0
          ? rawSimilarity
          : Number.isFinite(rawDistance) && rawDistance >= 0
            ? 1 / (1 + rawDistance)
            : Math.max(0.05, (topK - idx) / Math.max(1, topK));

      const normalizedDoc = {
        id,
        title,
        content_txt: content,
        file_name_s: String(metadata?.file_name_s || title || id),
        department_code_s: String(metadata?.department_code_s || ''),
        score: Number(embeddingSimilarity || 0),
        hyde_similarity: Number(embeddingSimilarity || 0),
      };
      return {
        doc: normalizedDoc,
        key: documentKey(normalizedDoc, idx),
        embeddingSimilarity: Number(embeddingSimilarity || 0),
      };
    })
    .filter((item) => Boolean(item?.doc?.id || item?.doc?.title));
};

const callGateway = async (prompt: string): Promise<string> => {
  const baseUrl = normalizeBaseUrl(process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL);
  const model = String(process.env.LLM_MODEL || DEFAULT_LLM_MODEL).trim() || DEFAULT_LLM_MODEL;
  const timeoutMs = Math.max(2500, Number(process.env.RAG_HYDE_LLM_TIMEOUT_MS || 7000));
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
      { role: 'system', content: 'You generate concise hypothetical HR-policy style paragraphs for retrieval.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 180,
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
    return normalizeSentencePair(extractTextFromContent(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || ''));
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
};

export type HyDERetrievalInput = {
  query: string;
  language: 'ja' | 'en';
  solrDocs: any[];
  ragBackendUrl?: string;
  ragBackendCollectionName?: string;
  fileScopeIds?: string[];
  metadataFilters?: Record<string, any>;
  onLog?: (event: string, payload?: Record<string, any>) => void;
};

export type HyDESimilarityScore = {
  id: string;
  title: string;
  solr_score: number;
  embedding_similarity: number;
  final_score: number;
};

export type HyDERetrievalResult = {
  docs: any[];
  hypotheticalAnswer: string;
  similarityScores: HyDESimilarityScore[];
};

export const retrieveWithHyDE = async (
  input: HyDERetrievalInput,
): Promise<HyDERetrievalResult> => {
  const log = input.onLog || (() => undefined);
  const sourceQuery = String(input.query || '').trim();
  const baseDocs = Array.isArray(input.solrDocs) ? input.solrDocs : [];
  if (!sourceQuery) {
    return { docs: baseDocs.slice(0, 8), hypotheticalAnswer: '', similarityScores: [] };
  }

  const prompt = [
    'You are helping retrieve HR policy documents.',
    '',
    'Write a short paragraph that might appear in a company HR document answering the question.',
    '',
    'Question:',
    sourceQuery,
    '',
    'Paragraph:',
  ].join('\n');
  const hypotheticalAnswer = await callGateway(prompt);
  if (!hypotheticalAnswer) {
    return { docs: baseDocs.slice(0, 8), hypotheticalAnswer: '', similarityScores: [] };
  }

  const backendUrl = String(input.ragBackendUrl || config?.RAG?.Backend?.url || process.env.RAG_BACKEND_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!backendUrl) {
    return { docs: baseDocs.slice(0, 8), hypotheticalAnswer, similarityScores: [] };
  }

  const payload = {
    collection_name: String(
      input.ragBackendCollectionName ||
      config?.RAG?.PreProcess?.PDF?.splitByArticle?.collectionName ||
      'splitByArticleWithHybridSearch',
    ),
    query: hypotheticalAnswer,
    top_k: Math.max(8, Number(process.env.RAG_HYDE_TOP_K || 12)),
    vector_only: true,
    bm25_only: false,
    vector_weight: 1,
    bm25_weight: 0,
    bm25_params: config?.RAG?.Retrieval?.HybridSearch?.bm25_params || { k1: 1.8, b: 0.75 },
    ...(Array.isArray(input.fileScopeIds) && input.fileScopeIds.length
      ? { candidate_file_ids: input.fileScopeIds }
      : {}),
    ...(input.metadataFilters ? { metadata_filters: input.metadataFilters } : {}),
  };

  try {
    const timeoutMs = Math.max(1000, Number(process.env.RAG_HYDE_BACKEND_TIMEOUT_MS || 6000));
    const res = await withTimeout(
      () =>
        fetch(`${backendUrl}/search/hybrid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      timeoutMs,
    );
    if (!res.ok) {
      return { docs: baseDocs.slice(0, 8), hypotheticalAnswer, similarityScores: [] };
    }

    const body = await res.json();
    const hydeSemanticDocs = normalizeHydeSemanticDocs(body, Number(payload.top_k || 12));
    if (!hydeSemanticDocs.length) {
      return { docs: baseDocs.slice(0, 8), hypotheticalAnswer, similarityScores: [] };
    }

    const hydeByKey = new Map<string, HyDESemanticDoc>();
    for (const item of hydeSemanticDocs) {
      if (!hydeByKey.has(item.key)) hydeByKey.set(item.key, item);
    }

    const combinedMap = new Map<string, any>();
    for (let idx = 0; idx < baseDocs.length; idx += 1) {
      const doc = baseDocs[idx];
      const key = documentKey(doc, idx);
      combinedMap.set(key, { doc, key });
    }
    for (const item of hydeSemanticDocs) {
      if (!combinedMap.has(item.key)) {
        combinedMap.set(item.key, { doc: item.doc, key: item.key });
      }
    }

    const scored = Array.from(combinedMap.values()).map((row: any, idx) => {
      const doc = row.doc;
      const key = row.key;
      const solrScore = Number(doc?.score || 0);
      const hydeScore = Number(hydeByKey.get(key)?.embeddingSimilarity || doc?.hyde_similarity || 0);
      const finalScore = (solrScore * 0.6) + (hydeScore * 0.4);
      const title = String((Array.isArray(doc?.title) ? doc.title[0] : doc?.title) || doc?.file_name_s || doc?.id || '');
      return {
        key,
        doc: {
          ...doc,
          hyde_similarity: Number(hydeScore.toFixed(6)),
          solr_score: Number(solrScore.toFixed(6)),
          final_score: Number(finalScore.toFixed(6)),
          score: Number(finalScore.toFixed(6)),
        },
        similarity: {
          id: String(doc?.id || key || `doc_${idx + 1}`),
          title,
          solr_score: Number(solrScore.toFixed(6)),
          embedding_similarity: Number(hydeScore.toFixed(6)),
          final_score: Number(finalScore.toFixed(6)),
        } as HyDESimilarityScore,
      };
    });

    scored.sort((a, b) => b.doc.score - a.doc.score);
    const docs = scored.slice(0, 8).map((row) => row.doc);
    const similarityScores = scored.slice(0, 8).map((row) => row.similarity);

    log('hyde_similarity_scores', {
      scores: similarityScores.map((item) => ({
        id: item.id,
        final_score: item.final_score,
        embedding_similarity: item.embedding_similarity,
      })),
    });

    return {
      docs,
      hypotheticalAnswer,
      similarityScores,
    };
  } catch {
    return { docs: baseDocs.slice(0, 8), hypotheticalAnswer, similarityScores: [] };
  }
};

