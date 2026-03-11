import { QueryClass } from '@/rag/query/queryRouter';

export type RerankPolicyInput = {
  routeClass: QueryClass;
  docCount: number;
  retrievalConfidence: number;
  scoreMargin: number;
  topTermHits: number;
  sourceConsistency: number;
  topScores: number[];
};

export type RerankPolicyDecision = {
  apply: boolean;
  reason: string;
  scoreEntropy: number;
};

const readNumber = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const toPositiveScores = (scores: number[]): number[] => {
  const cleaned = (Array.isArray(scores) ? scores : [])
    .map((score) => Number(score))
    .filter((score) => Number.isFinite(score) && score > 0)
    .slice(0, 6);
  if (cleaned.length > 0) return cleaned;
  return [1];
};

const computeNormalizedEntropy = (scores: number[]): number => {
  const values = toPositiveScores(scores);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total || values.length <= 1) return 0;
  const probs = values.map((value) => value / total);
  const entropy = -probs.reduce((sum, p) => sum + (p > 0 ? p * Math.log(p) : 0), 0);
  const maxEntropy = Math.log(values.length);
  if (maxEntropy <= 0) return 0;
  return clamp(entropy / maxEntropy, 0, 1);
};

const isAmbiguousClass = (klass: QueryClass): boolean =>
  klass === 'ambiguous' || klass === 'comparison' || klass === 'follow_up';

export const evaluateRerankPolicy = (input: RerankPolicyInput): RerankPolicyDecision => {
  const maxDocsSkip = Math.max(1, readNumber('RAG_SELECTIVE_RERANK_MAX_DOCS_SKIP', 4));
  const minConfidenceSkip = Math.max(0, readNumber('RAG_SELECTIVE_RERANK_MIN_CONFIDENCE_SKIP', 28));
  const minScoreMarginSkip = Math.max(0, readNumber('RAG_SELECTIVE_RERANK_MIN_SCORE_MARGIN_SKIP', 4));
  const minTopTermHitsSkip = Math.max(0, readNumber('RAG_SELECTIVE_RERANK_MIN_TOP_TERM_HITS_SKIP', 2));
  const minSourceConsistencySkip = clamp(
    readNumber('RAG_SELECTIVE_RERANK_MIN_SOURCE_CONSISTENCY_SKIP', 0.5),
    0,
    1,
  );
  const maxEntropySkip = clamp(readNumber('RAG_SELECTIVE_RERANK_MAX_ENTROPY_SKIP', 0.55), 0, 1);
  const minEntropyApply = clamp(readNumber('RAG_SELECTIVE_RERANK_MIN_ENTROPY_APPLY', 0.72), 0, 1);

  const scoreEntropy = computeNormalizedEntropy(input.topScores);
  const smallDocSet = input.docCount <= maxDocsSkip;
  const highConfidence = input.retrievalConfidence >= minConfidenceSkip;
  const strongMargin = input.scoreMargin >= minScoreMarginSkip;
  const strongTermSignal = input.topTermHits >= minTopTermHitsSkip;
  const consistentSources = input.sourceConsistency >= minSourceConsistencySkip;
  const lowEntropy = scoreEntropy <= maxEntropySkip;

  const skipRerank =
    smallDocSet &&
    highConfidence &&
    strongMargin &&
    strongTermSignal &&
    consistentSources &&
    lowEntropy &&
    !isAmbiguousClass(input.routeClass);

  if (skipRerank) {
    return {
      apply: false,
      reason: 'high_confidence_small_set_low_entropy',
      scoreEntropy: Number(scoreEntropy.toFixed(3)),
    };
  }

  if (isAmbiguousClass(input.routeClass) && input.docCount > 1) {
    return {
      apply: true,
      reason: 'ambiguous_route_requires_rerank',
      scoreEntropy: Number(scoreEntropy.toFixed(3)),
    };
  }

  if (scoreEntropy >= minEntropyApply) {
    return {
      apply: true,
      reason: 'high_entropy_requires_rerank',
      scoreEntropy: Number(scoreEntropy.toFixed(3)),
    };
  }

  return {
    apply: true,
    reason: 'default_rerank',
    scoreEntropy: Number(scoreEntropy.toFixed(3)),
  };
};

