export type QueryClass =
  | 'procedural'
  | 'policy'
  | 'factual'
  | 'comparison'
  | 'ambiguous'
  | 'follow_up';

export type QueryRoute = {
  klass: QueryClass;
  confidence: number;
  enableExpansion: boolean;
  maxExpansionVariants: number;
  allowEarlyExit: boolean;
  preferLexicalFirst: boolean;
  preferNarrowDomain: boolean;
};

export type QueryRouterInput = {
  query: string;
  language: 'ja' | 'en';
  hasHistory?: boolean;
};

export type EarlyExitThresholds = {
  minConfidence: number;
  minDocs: number;
  minScoreMargin: number;
  minTopTermHits: number;
  minSourceConsistency: number;
};

export type EarlyExitInput = {
  route: QueryRoute;
  retrievalConfidence: number;
  docCount: number;
  scoreMargin: number;
  topTermHits: number;
  sourceConsistency: number;
  thresholds: EarlyExitThresholds;
};

export type EarlyExitDecision = {
  apply: boolean;
  reason: string;
  requiredConfidence: number;
};

const PROCEDURAL_PATTERNS = [
  /\bwhat\s+should\b/i,
  /\bdo\s+if\b/i,
  /\bhow\s+to\b/i,
  /\bhow\s+do\s+i\b/i,
  /\bhow\s+can\s+i\b/i,
  /\bsteps?\s+to\b/i,
  /\bprocess\s+for\b/i,
  /\brequest\s+process\b/i,
  /\bapply\s+for\b/i,
  /\bsteps?\b/i,
  /\bprocedure\b/i,
  /\bprocedures?\s+for\b/i,
  /\bprocess\b/i,
  /\bworkflow\b/i,
  /\bapply\b/i,
  /\bapplication\b/i,
  /\brequest\b/i,
  /\bsubmit\b/i,
  /\bchange\b/i,
  /\bcorrect(?:ion)?\b/i,
  /\bforgot\b/i,
  /\bforget\b/i,
  /\bmiss(?:ed)?\b/i,
  /\bclock[\s-]?in\b/i,
  /\btime\s*card\b/i,
  /\battendance\b/i,
  /\bbreak\b/i,
  /\bno\s*break\b/i,
  /\bwithout\s+taking\s+a?\s*break\b/i,
  /打刻/,
  /打刻漏れ/,
  /勤怠修正/,
  /修正申請/,
  /休憩/,
  /休憩なし/,
  /無休憩/,
  /休憩を取らず/,
  /申請/,
  /手順/,
  /方法/,
  /やり方/,
  /流れ/,
];

const POLICY_PATTERNS = [
  /\bpolicy\b/i,
  /\brule(?:s)?\b/i,
  /\bregulation(?:s)?\b/i,
  /\bguideline(?:s)?\b/i,
  /\brequirement(?:s)?\b/i,
  /\beligibilit(?:y|ies)\b/i,
  /規程/,
  /規定/,
  /ルール/,
  /方針/,
  /条件/,
];

const FACTUAL_PATTERNS = [
  /\bwhat\s+is\b/i,
  /\bwhen\b/i,
  /\bwhere\b/i,
  /\bwho\b/i,
  /\bwhich\b/i,
  /\bdefinition\b/i,
  /とは/,
  /何/,
  /いつ/,
  /どこ/,
  /誰/,
];

const COMPARISON_PATTERNS = [
  /\bcompare\b/i,
  /\bdifference\b/i,
  /\bversus\b/i,
  /\bvs\.?\b/i,
  /比較/,
  /違い/,
  /どっち/,
];

const FOLLOW_UP_PATTERNS = [
  /^\s*(and|also|then|what\s+about)\b/i,
  /^(それ|その|この|あと|次)/,
];

const countPatternHits = (value: string, patterns: RegExp[]): number =>
  patterns.reduce((sum, pattern) => sum + (pattern.test(value) ? 1 : 0), 0);

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export const routeQuery = ({
  query,
  language: _language,
  hasHistory = false,
}: QueryRouterInput): QueryRoute => {
  const text = String(query || '').trim();
  const lowered = text.toLowerCase();
  const tokens = lowered.split(/\s+/).filter(Boolean);

  const proceduralHits = countPatternHits(lowered, PROCEDURAL_PATTERNS);
  const policyHits = countPatternHits(lowered, POLICY_PATTERNS);
  const factualHits = countPatternHits(lowered, FACTUAL_PATTERNS);
  const comparisonHits = countPatternHits(lowered, COMPARISON_PATTERNS);
  const followUpHits = countPatternHits(lowered, FOLLOW_UP_PATTERNS);
  const shortQuery = tokens.length <= 2 || text.length <= 12;

  let klass: QueryClass = 'ambiguous';
  let confidence = 0.45;

  if (followUpHits > 0 && hasHistory) {
    klass = 'follow_up';
    confidence = 0.7;
  } else if (proceduralHits > 0) {
    klass = 'procedural';
    confidence = clamp01(0.62 + Math.min(0.24, proceduralHits * 0.08));
  } else if (comparisonHits > 0) {
    klass = 'comparison';
    confidence = clamp01(0.62 + Math.min(0.2, comparisonHits * 0.1));
  } else if (policyHits > 0) {
    klass = 'policy';
    confidence = clamp01(0.58 + Math.min(0.24, policyHits * 0.08));
  } else if (factualHits > 0) {
    klass = 'factual';
    confidence = clamp01(0.56 + Math.min(0.2, factualHits * 0.08));
  } else if (shortQuery) {
    klass = 'ambiguous';
    confidence = 0.4;
  } else {
    klass = 'factual';
    confidence = 0.52;
  }

  const clearIntent = confidence >= 0.72 && (klass === 'procedural' || klass === 'factual');
  const enableExpansion = !clearIntent && klass !== 'follow_up';
  const maxExpansionVariants = clearIntent ? 3 : (klass === 'ambiguous' ? 7 : 6);
  const allowEarlyExit = clearIntent || (klass === 'procedural' && confidence >= 0.64);
  const preferNarrowDomain = klass === 'procedural' || klass === 'policy' || klass === 'factual';

  return {
    klass,
    confidence,
    enableExpansion,
    maxExpansionVariants,
    allowEarlyExit,
    preferLexicalFirst: true,
    preferNarrowDomain,
  };
};

const confidenceOffsetByClass = (klass: QueryClass): number => {
  switch (klass) {
    case 'procedural':
      return -2;
    case 'factual':
      return -1;
    case 'policy':
      return 1;
    case 'comparison':
      return 2;
    case 'follow_up':
      return 2;
    case 'ambiguous':
    default:
      return 3;
  }
};

export const evaluateEarlyExit = (input: EarlyExitInput): EarlyExitDecision => {
  const requiredConfidence = Math.max(
    0,
    input.thresholds.minConfidence + confidenceOffsetByClass(input.route.klass),
  );

  if (!input.route.allowEarlyExit) {
    return { apply: false, reason: 'route_disallows_early_exit', requiredConfidence };
  }
  if (input.docCount < input.thresholds.minDocs) {
    return { apply: false, reason: 'insufficient_docs', requiredConfidence };
  }
  if (input.retrievalConfidence < requiredConfidence) {
    return { apply: false, reason: 'low_retrieval_confidence', requiredConfidence };
  }
  if (input.scoreMargin < input.thresholds.minScoreMargin) {
    return { apply: false, reason: 'low_score_margin', requiredConfidence };
  }
  if (input.topTermHits < input.thresholds.minTopTermHits) {
    return { apply: false, reason: 'low_term_hits', requiredConfidence };
  }
  if (input.sourceConsistency < input.thresholds.minSourceConsistency) {
    return { apply: false, reason: 'low_source_consistency', requiredConfidence };
  }
  return { apply: true, reason: 'high_confidence_sufficient_evidence', requiredConfidence };
};
