import { retrieveVectorDocuments, VectorSimilarityScore } from './vectorRetriever';
import { resolveDocumentImportanceWeight } from './importanceWeight';

const normalizeDocKey = (doc: any, fallbackIndex = 0): string => {
  const id = String(doc?.id || '').trim();
  if (id) return id;
  const title = String((Array.isArray(doc?.title) ? doc.title[0] : doc?.title) || '').trim();
  const fileName = String(doc?.file_name_s || '').trim();
  const key = `${title}|${fileName}`.trim();
  return key || `doc_${fallbackIndex + 1}`;
};

export type HybridRetrievalInput = {
  query: string;
  queries?: string[];
  solrDocs: any[];
  ragBackendUrl?: string;
  ragBackendCollectionName?: string;
  fileScopeIds?: string[];
  metadataFilters?: Record<string, any>;
  onLog?: (event: string, payload?: Record<string, any>) => void;
};

export type HybridMergedScore = {
  id: string;
  title: string;
  solr_score: number;
  vector_similarity: number;
  importance_weight: number;
  final_score: number;
};

export type HybridRetrievalResult = {
  docs: any[];
  vectorDocs: any[];
  vectorSimilarityScores: VectorSimilarityScore[];
  mergedScores: HybridMergedScore[];
};

export const retrieveDocumentsWithHybrid = async (
  input: HybridRetrievalInput,
): Promise<HybridRetrievalResult> => {
  const log = input.onLog || (() => undefined);
  const query = String(input.query || '').trim();
  const queries = Array.from(
    new Set(
      [query, ...(Array.isArray(input.queries) ? input.queries : [])]
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  ).slice(0, 4);
  const solrDocs = (Array.isArray(input.solrDocs) ? input.solrDocs : []).slice(0, 20);

  if (!query) {
    return {
      docs: solrDocs.slice(0, 8),
      vectorDocs: [],
      vectorSimilarityScores: [],
      mergedScores: [],
    };
  }

  log('hybrid_retrieval_enabled', {
    query,
    queries,
    solr_candidate_docs: solrDocs.length,
  });

  const vectorResults = await Promise.all(
    queries.map(async (candidate) => ({
      query: candidate,
      result: await retrieveVectorDocuments({
        query: candidate,
        ragBackendUrl: input.ragBackendUrl,
        ragBackendCollectionName: input.ragBackendCollectionName,
        fileScopeIds: input.fileScopeIds,
        metadataFilters: input.metadataFilters,
        onLog: log,
      }),
    })),
  );
  const vectorByKey = new Map<string, any>();
  for (const { result } of vectorResults) {
    const docs = Array.isArray(result.docs) ? result.docs : [];
    for (let idx = 0; idx < docs.length; idx += 1) {
      const doc = docs[idx];
      const key = normalizeDocKey(doc, idx);
      const existing = vectorByKey.get(key);
      const nextSimilarity = Number(doc?.vector_similarity ?? doc?.score ?? 0);
      const existingSimilarity = Number(existing?.vector_similarity ?? existing?.score ?? 0);
      if (!existing || nextSimilarity > existingSimilarity) {
        vectorByKey.set(key, doc);
      }
    }
  }
  const vectorDocs = Array.from(vectorByKey.values())
    .sort((left, right) => Number(right?.vector_similarity || right?.score || 0) - Number(left?.vector_similarity || left?.score || 0))
    .slice(0, 20);

  const solrWeight = Math.max(0, Number(process.env.RAG_HYBRID_SOLR_WEIGHT || 0.6));
  const vectorWeight = Math.max(0, Number(process.env.RAG_HYBRID_VECTOR_WEIGHT || 0.4));
  const totalWeight = Math.max(0.0001, solrWeight + vectorWeight);
  const normalizedSolrWeight = solrWeight / totalWeight;
  const normalizedVectorWeight = vectorWeight / totalWeight;

  const mergedMap = new Map<string, any>();
  for (let idx = 0; idx < solrDocs.length; idx += 1) {
    const doc = solrDocs[idx];
    const key = normalizeDocKey(doc, idx);
    if (!mergedMap.has(key)) mergedMap.set(key, doc);
  }
  for (let idx = 0; idx < vectorDocs.length; idx += 1) {
    const doc = vectorDocs[idx];
    const key = normalizeDocKey(doc, idx);
    if (!mergedMap.has(key)) mergedMap.set(key, doc);
  }

  const merged = Array.from(mergedMap.values()).map((doc, idx) => {
    const key = normalizeDocKey(doc, idx);
    const solrScore = Number(doc?.score || 0);
    const vectorSimilarity = Number(
      vectorByKey.get(key)?.vector_similarity ??
        vectorByKey.get(key)?.score ??
        doc?.vector_similarity ??
        0,
    );
    const retrievalScore =
      (solrScore * normalizedSolrWeight) +
      (vectorSimilarity * normalizedVectorWeight);
    const importanceWeight = resolveDocumentImportanceWeight(doc);
    const finalScore = retrievalScore + importanceWeight;

    return {
      ...doc,
      importance_weight: Number(importanceWeight.toFixed(6)),
      solr_score: Number(solrScore.toFixed(6)),
      vector_similarity: Number(vectorSimilarity.toFixed(6)),
      retrieval_score: Number(retrievalScore.toFixed(6)),
      final_score: Number(finalScore.toFixed(6)),
      score: Number(finalScore.toFixed(6)),
    };
  });

  merged.sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0));

  const mergedScores: HybridMergedScore[] = merged.slice(0, 8).map((doc, idx) => ({
    id: String(doc?.id || `merged_${idx + 1}`),
    title: String((Array.isArray(doc?.title) ? doc.title[0] : doc?.title) || doc?.file_name_s || ''),
    solr_score: Number(doc?.solr_score || 0),
    vector_similarity: Number(doc?.vector_similarity || 0),
    importance_weight: Number(doc?.importance_weight || 0),
    final_score: Number(doc?.final_score || doc?.score || 0),
  }));

  return {
    docs: merged.slice(0, 8),
    vectorDocs,
    vectorSimilarityScores: vectorDocs.slice(0, 20).map((doc, idx) => ({
      id: String(doc?.id || `vector_${idx + 1}`),
      title: String((Array.isArray(doc?.title) ? doc.title[0] : doc?.title) || doc?.file_name_s || ''),
      vector_similarity: Number(doc?.vector_similarity || doc?.score || 0),
    })),
    mergedScores,
  };
};
