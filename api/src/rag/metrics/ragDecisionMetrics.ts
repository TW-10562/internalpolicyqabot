export type RagDecisionEvent =
  | 'query_classification'
  | 'early_exit'
  | 'rerank_policy'
  | 'domain_prefilter'
  | 'formatter_mode'
  | 'translation_cache';

export type RagDecisionPayload = Record<string, unknown>;

const DECISION_METRICS_ENABLED = String(process.env.RAG_DECISION_METRICS_ENABLED || '1') !== '0';

const safeSerialize = (payload: RagDecisionPayload): string => {
  try {
    return JSON.stringify(payload);
  } catch {
    return '{"serialize_error":true}';
  }
};

export const recordRagDecision = (
  event: RagDecisionEvent,
  payload: RagDecisionPayload,
  logger?: (line: string) => void,
) => {
  if (!DECISION_METRICS_ENABLED) return;
  const line = `[RAG_DECISION] event=${event} payload=${safeSerialize(payload)}`;
  if (typeof logger === 'function') {
    logger(line);
    return;
  }
  console.log(line);
};

