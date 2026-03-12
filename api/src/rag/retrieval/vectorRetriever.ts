import { config } from '@config/index';
import { resolveDocumentImportanceWeight } from './importanceWeight';

const readNumberEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeDocKey = (doc: any, fallbackIndex = 0): string => {
  const id = String(doc?.id || '').trim();
  if (id) return id;
  const title = String((Array.isArray(doc?.title) ? doc.title[0] : doc?.title) || '').trim();
  const fileName = String(doc?.file_name_s || '').trim();
  const key = `${title}|${fileName}`.trim();
  return key || `doc_${fallbackIndex + 1}`;
};

const normalizeVectorDocs = (raw: any[], topK: number): any[] =>
  (Array.isArray(raw) ? raw : [])
    .map((item: any, idx: number) => {
      const metadata = item?.metadata || {};
      const content = String(item?.page_content || '').trim();
      const id = String(item?.id || metadata?.file_id || metadata?.file_path_s || `vector_${idx + 1}`);
      const title = String(
        metadata?.DocumentName ||
          metadata?.file_name_s ||
          metadata?.title ||
          metadata?.ArticleName ||
          `vector_doc_${idx + 1}`,
      );
      const rawSimilarity = Number(item?.score ?? item?.similarity ?? item?.relevance_score ?? item?.rerank_score);
      const rawDistance = Number(item?.distance ?? item?.dist ?? item?.vector_distance);
      const vectorSimilarity =
        Number.isFinite(rawSimilarity) && rawSimilarity > 0
          ? rawSimilarity
          : Number.isFinite(rawDistance) && rawDistance >= 0
            ? 1 / (1 + rawDistance)
            : Math.max(0.05, (topK - idx) / Math.max(1, topK));
      const sectionTitle = String(
        metadata?.section_title ||
        metadata?.section_title_s ||
        metadata?.SectionName ||
        metadata?.heading ||
        '',
      ).trim();
      const articleNumber = String(
        metadata?.article_number ||
        metadata?.article_number_s ||
        metadata?.ArticleNumber ||
        metadata?.article_no ||
        '',
      ).trim();
      const policyType = String(
        metadata?.policy_type ||
        metadata?.policy_type_s ||
        metadata?.PolicyType ||
        metadata?.rag_tag_s ||
        '',
      ).trim();
      const chunkId = String(
        metadata?.chunk_id ||
        metadata?.chunk_id_s ||
        metadata?.chunkId ||
        item?.id ||
        '',
      ).trim();
      const documentId = String(
        metadata?.document_id ||
        metadata?.document_id_s ||
        metadata?.doc_id ||
        metadata?.file_id ||
        '',
      ).trim();
      const pageNumber = Number(
        metadata?.page_number ??
        metadata?.page_number_i ??
        metadata?.page ??
        metadata?.page_i,
      );
      const documentLastUpdated = String(
        metadata?.document_last_updated ||
        metadata?.document_last_updated_s ||
        metadata?.updated_at ||
        metadata?.updated_at_s ||
        metadata?.modified_at ||
        metadata?.modified_at_s ||
        metadata?.LastRevised ||
        '',
      ).trim();
      return {
        id,
        title,
        content_txt: content,
        file_name_s: String(metadata?.file_name_s || title || id),
        department_code_s: String(metadata?.department_code_s || ''),
        score: Number(vectorSimilarity || 0),
        vector_similarity: Number(vectorSimilarity || 0),
        semantic_score: Number(vectorSimilarity || 0),
        ...(sectionTitle ? { section_title_s: sectionTitle } : {}),
        ...(articleNumber ? { article_number_s: articleNumber } : {}),
        ...(policyType ? { policy_type_s: policyType } : {}),
        ...(chunkId ? { chunk_id_s: chunkId } : {}),
        ...(documentId ? { document_id_s: documentId } : {}),
        ...(Number.isFinite(pageNumber) ? { page_number_i: Number(pageNumber) } : {}),
        ...(documentLastUpdated ? { document_last_updated_s: documentLastUpdated } : {}),
        importance_weight_f: Number(
          metadata?.importance_weight_f ??
            metadata?.importance_weight ??
            0,
        ),
      };
    })
    .filter((doc) => Boolean(doc?.id || doc?.title));

export type VectorRetrievalInput = {
  query: string;
  ragBackendUrl?: string;
  ragBackendCollectionName?: string;
  fileScopeIds?: string[];
  metadataFilters?: Record<string, any>;
  onLog?: (event: string, payload?: Record<string, any>) => void;
};

export type VectorSimilarityScore = {
  id: string;
  title: string;
  vector_similarity: number;
};

export type VectorRetrievalResult = {
  docs: any[];
  similarityScores: VectorSimilarityScore[];
  embeddingModel: string;
};

export const retrieveVectorDocuments = async (
  input: VectorRetrievalInput,
): Promise<VectorRetrievalResult> => {
  const log = input.onLog || (() => undefined);
  const query = String(input.query || '').trim();
  if (!query) {
    return { docs: [], similarityScores: [], embeddingModel: String(process.env.RAG_VECTOR_EMBEDDING_MODEL || '') };
  }

  const backendUrl = String(input.ragBackendUrl || config?.RAG?.Backend?.url || process.env.RAG_BACKEND_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!backendUrl) {
    return { docs: [], similarityScores: [], embeddingModel: String(process.env.RAG_VECTOR_EMBEDDING_MODEL || '') };
  }

  const embeddingModel = String(
    process.env.RAG_VECTOR_EMBEDDING_MODEL ||
      process.env.RAG_EMBEDDING_MODEL ||
      process.env.EMBEDDING_MODEL_NAME ||
      'BAAI/bge-m3',
  ).trim();
  const topK = Math.max(8, Number(process.env.RAG_VECTOR_TOP_K || 20));

  const payload = {
    collection_name: String(
      input.ragBackendCollectionName ||
        config?.RAG?.PreProcess?.PDF?.splitByArticle?.collectionName ||
        'splitByArticleWithHybridSearch',
    ),
    query,
    top_k: topK,
    vector_only: true,
    bm25_only: false,
    vector_weight: 1,
    bm25_weight: 0,
    bm25_params: config?.RAG?.Retrieval?.HybridSearch?.bm25_params || { k1: 1.8, b: 0.75 },
    embedding_model: embeddingModel,
    ...(Array.isArray(input.fileScopeIds) && input.fileScopeIds.length
      ? { candidate_file_ids: input.fileScopeIds }
      : {}),
    ...(input.metadataFilters ? { metadata_filters: input.metadataFilters } : {}),
  };

  const timeoutMs = Math.max(1000, Number(process.env.RAG_VECTOR_TIMEOUT_MS || 6000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${backendUrl}/search/hybrid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      log('vector_retrieval_error', { status: `http_${res.status}` });
      return { docs: [], similarityScores: [], embeddingModel };
    }
    const body = await res.json();
    const docs = normalizeVectorDocs(body, topK);
    const similarityScores = docs.slice(0, topK).map((doc, idx) => ({
      id: String(doc?.id || normalizeDocKey(doc, idx)),
      title: String((Array.isArray(doc?.title) ? doc.title[0] : doc?.title) || doc?.file_name_s || ''),
      vector_similarity: Number(doc?.vector_similarity || doc?.score || 0),
    }));
    return { docs, similarityScores, embeddingModel };
  } catch (error: any) {
    log('vector_retrieval_error', { status: String(error?.message || 'error') });
    return { docs: [], similarityScores: [], embeddingModel };
  } finally {
    clearTimeout(timer);
  }
};

export const mergeSolrAndVectorDocs = (solrDocs: any[], vectorDocs: any[]): any[] => {
  const solrList = Array.isArray(solrDocs) ? solrDocs : [];
  const vectorList = Array.isArray(vectorDocs) ? vectorDocs : [];
  const vectorByKey = new Map<string, any>();
  const mergedMap = new Map<string, any>();

  const solrWeightRaw = Math.max(0, readNumberEnv('RAG_HYBRID_SOLR_WEIGHT', 0.6));
  const vectorWeightRaw = Math.max(0, readNumberEnv('RAG_HYBRID_VECTOR_WEIGHT', 0.4));
  const weightTotal = Math.max(0.0001, solrWeightRaw + vectorWeightRaw);
  const solrWeight = solrWeightRaw / weightTotal;
  const vectorWeight = vectorWeightRaw / weightTotal;

  for (let idx = 0; idx < vectorList.length; idx += 1) {
    const doc = vectorList[idx];
    const key = normalizeDocKey(doc, idx);
    if (!vectorByKey.has(key)) vectorByKey.set(key, doc);
    if (!mergedMap.has(key)) mergedMap.set(key, doc);
  }
  for (let idx = 0; idx < solrList.length; idx += 1) {
    const doc = solrList[idx];
    const key = normalizeDocKey(doc, idx);
    if (!mergedMap.has(key)) mergedMap.set(key, doc);
  }

  const scored = Array.from(mergedMap.values()).map((doc, idx) => {
    const key = normalizeDocKey(doc, idx);
    const solrScore = Number(doc?.score || 0);
    const vectorSimilarity = Number(
      vectorByKey.get(key)?.vector_similarity ??
        vectorByKey.get(key)?.score ??
        doc?.vector_similarity ??
        0,
    );
    const retrievalScore = (solrScore * solrWeight) + (vectorSimilarity * vectorWeight);
    const importanceWeight = resolveDocumentImportanceWeight(doc);
    const finalScore = retrievalScore + importanceWeight;
    return {
      ...doc,
      importance_weight: Number(importanceWeight.toFixed(6)),
      solr_score: Number(solrScore.toFixed(6)),
      vector_similarity: Number(vectorSimilarity.toFixed(6)),
      final_score: Number(finalScore.toFixed(6)),
      score: Number(finalScore.toFixed(6)),
    };
  });

  scored.sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0));
  return scored.slice(0, 8);
};
