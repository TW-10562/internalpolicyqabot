import fs from 'node:fs';
import path from 'node:path';

export type QueryIntent = 'rag_query' | 'general_chat' | 'translation_request' | 'faq_lookup';

type IntentRuleSet = Record<Exclude<QueryIntent, 'rag_query'>, string[]>;

export type QueryIntentResult = {
  intent: QueryIntent;
  confidence: number;
  matchedRule?: string;
};

const AMBIGUOUS_GENERAL_CHAT_RULES = new Set([
  'time',
  'weather',
  'news',
]);

const EN_DOCUMENT_QUERY_RE =
  /\b(?:policy|policies|procedure|procedures|process|workflow|rule|rules|regulation|regulations|guideline|guidelines|manual|document|documents|company|companies|employee|employees|staff|benefit|benefits|insurance|commut(?:e|ing)|transport(?:ation)?|allowance|expense|expenses|salary|payroll|leave|attendance|overtime|housing|housing contract|housing contracts|company housing|client|clients|corporate client|accounts?\s+receivable|credit\s+limit|credit\s+control|credit\s+management|full[-\s]?time|part[-\s]?time|contract employee|contract employees|contract staff|paid|payment|payments|frequency|often|which company|who handles|handled|must be followed)\b/i;

const JA_DOCUMENT_QUERY_RE =
  /(規程|規則|手順|申請|就業|社宅|契約|通勤|交通費|保険|補償|給与|賃金|勤怠|残業|売掛|与信|正社員|契約社員|福利厚生|支給|頻度)/;

let cachedRules: IntentRuleSet | null = null;
let loadWarningLogged = false;

const normalizeText = (value: string): string =>
  String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();

const countVisibleTokens = (value: string): number =>
  normalizeText(value)
    .replace(/[“”"'`]/g, ' ')
    .replace(/[?？!！,，.:;；/／\\()[\]{}<>「」『』【】]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .length;

const hasDocumentQuerySignal = (normalizedQuery: string): boolean =>
  EN_DOCUMENT_QUERY_RE.test(normalizedQuery) || JA_DOCUMENT_QUERY_RE.test(normalizedQuery);

const shouldOverrideGeneralChatIntent = (normalizedQuery: string, matchedRule?: string): boolean => {
  const rule = normalizeText(matchedRule || '').toLowerCase();
  if (!rule) return false;
  if (!hasDocumentQuerySignal(normalizedQuery)) return false;

  const tokenCount = countVisibleTokens(normalizedQuery);
  if (AMBIGUOUS_GENERAL_CHAT_RULES.has(rule)) return true;

  const questionLike = /[?？]/.test(normalizedQuery);
  return questionLike && tokenCount >= 5;
};

const candidateRulePaths = (): string[] => [
  path.resolve(process.cwd(), 'config', 'query_intent_rules.json'),
  path.resolve(process.cwd(), 'api', 'config', 'query_intent_rules.json'),
  path.resolve(__dirname, '../../../config/query_intent_rules.json'),
];

const loadRules = (): IntentRuleSet => {
  if (cachedRules) return cachedRules;

  for (const rulePath of candidateRulePaths()) {
    try {
      if (!fs.existsSync(rulePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(rulePath, 'utf8'));
      cachedRules = {
        general_chat: Array.isArray(parsed?.general_chat) ? parsed.general_chat.map(String) : [],
        translation_request: Array.isArray(parsed?.translation_request)
          ? parsed.translation_request.map(String)
          : [],
        faq_lookup: Array.isArray(parsed?.faq_lookup) ? parsed.faq_lookup.map(String) : [],
      };
      return cachedRules;
    } catch (error) {
      if (!loadWarningLogged) {
        loadWarningLogged = true;
        console.warn(
          `[QueryIntentClassifier] failed to load query_intent_rules.json from "${rulePath}": ${(error as any)?.message || error}`,
        );
      }
    }
  }

  if (!loadWarningLogged) {
    loadWarningLogged = true;
    console.warn('[QueryIntentClassifier] query_intent_rules.json not found; defaulting all queries to rag_query.');
  }

  cachedRules = {
    general_chat: [],
    translation_request: [],
    faq_lookup: [],
  };
  return cachedRules;
};

const matchesRule = (normalizedQuery: string, rule: string): boolean => {
  const normalizedRule = normalizeText(rule).toLowerCase();
  if (!normalizedQuery || !normalizedRule) return false;
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(normalizedRule)) {
    return normalizedQuery.includes(normalizedRule);
  }
  const escaped = normalizedRule
    .split(/\s+/)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`, 'i').test(normalizedQuery);
};

const resolveIntentFromRules = (
  normalizedQuery: string,
  rules: IntentRuleSet,
): QueryIntentResult | null => {
  const orderedIntents: Array<Exclude<QueryIntent, 'rag_query'>> = [
    'translation_request',
    'faq_lookup',
    'general_chat',
  ];

  for (const intent of orderedIntents) {
    for (const rule of rules[intent]) {
      if (!matchesRule(normalizedQuery, rule)) continue;
      return {
        intent,
        confidence: 0.92,
        matchedRule: rule,
      };
    }
  }
  return null;
};

export const classifyQueryIntent = (query: string): QueryIntentResult => {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) {
    return {
      intent: 'general_chat',
      confidence: 0.9,
      matchedRule: 'empty_query',
    };
  }

  const matched = resolveIntentFromRules(normalizedQuery, loadRules());
  if (matched) {
    if (
      matched.intent === 'general_chat' &&
      shouldOverrideGeneralChatIntent(normalizedQuery, matched.matchedRule)
    ) {
      return {
        intent: 'rag_query',
        confidence: 0.78,
        matchedRule: `general_chat_override:${matched.matchedRule}`,
      };
    }
    return matched;
  }

  return {
    intent: 'rag_query',
    confidence: 0.64,
  };
};
