import ngWordsConfigRaw from '@config/ng-words.json';
import { ChatMessage, openaiClient } from '@/service/openai_client';

export type ModerationCategory =
  | 'abusive_language'
  | 'harassment_or_threat'
  | 'self_harm'
  | 'violence'
  | 'company_or_project_abuse'
  | 'hate_or_discrimination'
  | 'sexual_harassment_or_abuse';

export type ModerationDetector = 'rules' | 'vllm';

export type ModerationReason = {
  category: ModerationCategory;
  reason: string;
  matchedText: string;
  severity: number;
  source: 'query' | 'answer';
  detector?: ModerationDetector;
  confidence?: number;
};

export type ModerationAnalysis = {
  flagged: boolean;
  score: number;
  reasons: ModerationReason[];
  detectors: ModerationDetector[];
  llmAssisted: boolean;
};

type PatternDef = {
  category: ModerationCategory;
  reason: string;
  severity: number;
  patterns: RegExp[];
};

type NgWordSection = {
  phrases?: string[];
  regex?: string[];
};

type NgWordsConfig = {
  violence?: NgWordSection;
  selfHarm?: NgWordSection;
  harassment?: NgWordSection;
  abuse?: NgWordSection;
  hate?: NgWordSection;
  allowlist?: {
    phrases?: string[];
  };
};

const CATEGORY_SET = new Set<ModerationCategory>([
  'abusive_language',
  'harassment_or_threat',
  'self_harm',
  'violence',
  'company_or_project_abuse',
  'hate_or_discrimination',
  'sexual_harassment_or_abuse',
]);

const COMPANY_OR_PROJECT_TERMS = String.raw`\b(company|project|system|app|platform|service|portal|bot|assistant|qa bot)\b`;
const NEGATIVE_INSULT_TERMS = String.raw`\b(sucks?|stupid|trash|garbage|useless|worst|hate|idiot|dumb|fraud|scam|broken|pathetic|worthless|awful|terrible|joke)\b`;
const OBFUSCATED_ABUSE_TERMS = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'motherfucker',
  'bastard',
  'idiot',
  'moron',
  'dumb',
  'stupid',
  'cunt',
  'prick',
  'dickhead',
  'jackass',
  'loser',
  'scumbag',
  'bullshit',
];
const SUSPICIOUS_LLM_CUE_RE =
  /\b(fuck|shit|bitch|asshole|motherfucker|bastard|idiot|moron|dumb|stupid|trash|garbage|useless|worthless|pathetic|awful|terrible|joke|hate|kill|murder|suicide|die|attack|hurt|blackmail|harass|threat|go to hell|shut up|stfu|racist|sexist|slut|whore|pervert|rape)\b|(?:死ね|殺す|自殺|ゴミ|クソ|バカ|アホ|黙れ|消えろ|脅迫|差別|レイプ|セクハラ)/i;
const MODERATION_LLM_TIMEOUT_MS = Math.max(800, Number(process.env.MODERATION_VLLM_TIMEOUT_MS || 2500));
const MODERATION_LLM_MAX_TEXT_CHARS = Math.max(240, Number(process.env.MODERATION_VLLM_MAX_TEXT_CHARS || 900));
const MODERATION_LLM_MAX_REASONS = Math.max(1, Math.min(6, Number(process.env.MODERATION_VLLM_MAX_REASONS || 4)));
const MODERATION_LLM_MODEL = String(process.env.MODERATION_VLLM_MODEL || process.env.LLM_MODEL || 'openai/gpt-oss-20b').trim();
const MODERATION_LLM_ENABLED = (() => {
  const explicit = String(
    process.env.MODERATION_VLLM_ENABLED ||
    process.env.CONTENT_MODERATION_USE_LLM ||
    '',
  ).trim().toLowerCase();
  if (explicit) return !['0', 'false', 'off', 'no'].includes(explicit);
  return Boolean(String(process.env.LLM_BASE_URL || '').trim() && String(process.env.LLM_MODEL || '').trim());
})();
const ngWordsConfig = (ngWordsConfigRaw || {}) as NgWordsConfig;

const normalizePhraseList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean)
    : [];

const compileRegexList = (value: unknown): RegExp[] => {
  if (!Array.isArray(value)) return [];
  const patterns: RegExp[] = [];
  for (const item of value) {
    const source = String(item || '').trim();
    if (!source) continue;
    try {
      patterns.push(new RegExp(source, 'i'));
    } catch {
      // Skip malformed regex from config instead of breaking moderation.
    }
  }
  return patterns;
};

const NG_ALLOWLIST_PHRASES = normalizePhraseList(ngWordsConfig.allowlist?.phrases);
const NG_VIOLENCE_PHRASES = normalizePhraseList(ngWordsConfig.violence?.phrases);
const NG_SELF_HARM_PHRASES = normalizePhraseList(ngWordsConfig.selfHarm?.phrases);
const NG_HARASSMENT_PHRASES = normalizePhraseList(ngWordsConfig.harassment?.phrases);
const NG_ABUSE_PHRASES = normalizePhraseList(ngWordsConfig.abuse?.phrases);
const NG_HATE_PHRASES = normalizePhraseList(ngWordsConfig.hate?.phrases);
const NG_VIOLENCE_REGEX = compileRegexList(ngWordsConfig.violence?.regex);
const NG_SELF_HARM_REGEX = compileRegexList(ngWordsConfig.selfHarm?.regex);
const NG_HARASSMENT_REGEX = compileRegexList(ngWordsConfig.harassment?.regex);
const NG_ABUSE_REGEX = compileRegexList(ngWordsConfig.abuse?.regex);
const NG_HATE_REGEX = compileRegexList(ngWordsConfig.hate?.regex);

const MODERATION_PATTERNS: PatternDef[] = [
  {
    category: 'abusive_language',
    reason: 'Contains abusive or profane language',
    severity: 3,
    patterns: [
      /\b(fuck|shit|bitch|asshole|motherfucker|bastard|cunt|prick|dickhead|jackass)\b/i,
      /\b(piece\s+of\s+shit|fuck\s+off|shut\s+the\s+fuck\s+up|stfu|go\s+to\s+hell)\b/i,
      /\b(idiot|moron|dumb|stupid|loser|scumbag|bullshit)\b/i,
      /\b(don'?t\s+you\s+have\s+(a\s+)?(mind|brain))\b/i,
      /\b(why\s+don'?t\s+you\s+answer\s+(properly|correctly))\b/i,
      /(?:くそ|クソ|死ね|しね|バカ|馬鹿|アホ|無能|役立たず|うるさい|カス|ゴミ|きもい|消えろ|黙れ)/,
    ],
  },
  {
    category: 'harassment_or_threat',
    reason: 'Contains harassment or threatening language',
    severity: 4,
    patterns: [
      /\b(you\s+are\s+(an?\s+)?(idiot|moron|stupid|dumb|loser|scumbag))\b/i,
      /\b(i('ll| will)\s+(hurt|kill|beat|attack|destroy)\s+you)\b/i,
      /\b(threat|harass|blackmail)\b/i,
      /\b(your\s+(service|system|app|assistant)\s+is\s+(trash|garbage|useless|pathetic|a joke))\b/i,
      /(?:脅す|脅迫|殺してやる|ぶっ殺す|消えろ|黙れ)/,
    ],
  },
  {
    category: 'self_harm',
    reason: 'Contains potential self-harm language',
    severity: 5,
    patterns: [
      /\b(kill myself|suicide|end my life|self harm)\b/i,
      /(?:自殺|死にたい|消えたい|自傷)/,
    ],
  },
  {
    category: 'violence',
    reason: 'Contains violent intent language',
    severity: 4,
    patterns: [
      /\b(shoot|stab|bomb|attack|murder|poison)\b/i,
      /(?:殴る|刺す|爆破|攻撃|殺す)/,
    ],
  },
  {
    category: 'company_or_project_abuse',
    reason: 'Contains targeted abuse against company/project',
    severity: 3,
    patterns: [
      new RegExp(`${COMPANY_OR_PROJECT_TERMS}[\\s\\S]{0,24}${NEGATIVE_INSULT_TERMS}`, 'i'),
      new RegExp(`${NEGATIVE_INSULT_TERMS}[\\s\\S]{0,24}${COMPANY_OR_PROJECT_TERMS}`, 'i'),
      /\b(this\s+(company|project|system|app|bot|assistant)\s+is\s+(trash|garbage|useless|a joke|pathetic|awful|terrible))\b/i,
      /(?:この会社|このプロジェクト|このシステム|このアプリ|このボット).{0,20}(最悪|クソ|ゴミ|使えない|嫌い|ひどい)/,
    ],
  },
];

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const normalizeComparableText = (value: string) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();

const normalizeLeetspeak = (value: string) =>
  value
    .replace(/@/g, 'a')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/\$/g, 's');

const toAsciiCompact = (value: string) =>
  normalizeLeetspeak(value.toLowerCase()).replace(/[^a-z]+/g, '');

const clipReasonText = (value: unknown) => String(value || '').trim().slice(0, 120);

const isAllowlistedText = (lowerText: string) =>
  NG_ALLOWLIST_PHRASES.some((phrase) => phrase && lowerText.includes(phrase));

const collectNgMatches = (
  normalized: string,
  lowerText: string,
  phrases: string[],
  regexPatterns: RegExp[],
): string[] => {
  const matches = new Set<string>();
  for (const phrase of phrases) {
    if (phrase && lowerText.includes(phrase)) {
      matches.add(clipReasonText(phrase));
    }
  }
  for (const pattern of regexPatterns) {
    const match = normalized.match(pattern);
    if (match?.[0]) {
      matches.add(clipReasonText(match[0]));
    }
  }
  return Array.from(matches);
};

const collectCompactTermMatches = (compactText: string, terms: string[]): string[] => {
  const matches = new Set<string>();
  for (const term of terms) {
    if (term && compactText.includes(term)) matches.add(term);
  }
  return Array.from(matches);
};

const dedupeReasons = (items: ModerationReason[]): ModerationReason[] => {
  const seen = new Set<string>();
  const out: ModerationReason[] = [];
  for (const item of items) {
    const key = [
      item.source,
      item.category,
      item.detector || 'rules',
      String(item.matchedText || '').toLowerCase(),
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) =>
    (Number(b.severity || 0) - Number(a.severity || 0)) ||
    String(a.source).localeCompare(String(b.source)) ||
    String(a.category).localeCompare(String(b.category)),
  );
};

function findRuleReasons(text: string, source: 'query' | 'answer'): ModerationReason[] {
  const normalized = normalizeWhitespace(normalizeComparableText(text));
  if (!normalized) return [];

  const normalizedLower = normalized.toLowerCase();
  const compactAscii = toAsciiCompact(normalizedLower);
  const reasons: ModerationReason[] = [];

  if (!isAllowlistedText(normalizedLower)) {
    const ngSections: Array<{
      category: ModerationCategory;
      reason: string;
      severity: number;
      phrases: string[];
      regex: RegExp[];
    }> = [
      {
        category: 'violence',
        reason: 'Matched NG violence blocklist',
        severity: 5,
        phrases: NG_VIOLENCE_PHRASES,
        regex: NG_VIOLENCE_REGEX,
      },
      {
        category: 'self_harm',
        reason: 'Matched NG self-harm blocklist',
        severity: 5,
        phrases: NG_SELF_HARM_PHRASES,
        regex: NG_SELF_HARM_REGEX,
      },
      {
        category: 'harassment_or_threat',
        reason: 'Matched NG harassment blocklist',
        severity: 4,
        phrases: NG_HARASSMENT_PHRASES,
        regex: NG_HARASSMENT_REGEX,
      },
      {
        category: 'abusive_language',
        reason: 'Matched NG abuse blocklist',
        severity: 4,
        phrases: NG_ABUSE_PHRASES,
        regex: NG_ABUSE_REGEX,
      },
      {
        category: 'hate_or_discrimination',
        reason: 'Matched NG hate-speech blocklist',
        severity: 5,
        phrases: NG_HATE_PHRASES,
        regex: NG_HATE_REGEX,
      },
    ];

    for (const section of ngSections) {
      const matches = collectNgMatches(normalized, normalizedLower, section.phrases, section.regex);
      for (const matchedText of matches) {
        reasons.push({
          category: section.category,
          reason: section.reason,
          matchedText,
          severity: section.severity,
          source,
          detector: 'rules',
          confidence: 0.98,
        });
      }
    }

    const obfuscatedMatches = collectCompactTermMatches(compactAscii, OBFUSCATED_ABUSE_TERMS);
    for (const matchedText of obfuscatedMatches) {
      reasons.push({
        category: 'abusive_language',
        reason: 'Contains obfuscated abusive language',
        matchedText,
        severity: 3,
        source,
        detector: 'rules',
        confidence: 0.86,
      });
    }
  }

  for (const rule of MODERATION_PATTERNS) {
    for (const pattern of rule.patterns) {
      const match = normalized.match(pattern);
      if (!match) continue;
      reasons.push({
        category: rule.category,
        reason: rule.reason,
        matchedText: clipReasonText(match[0]),
        severity: rule.severity,
        source,
        detector: 'rules',
        confidence: 0.95,
      });
      break;
    }
  }

  return dedupeReasons(reasons);
}

const tryParseAnyJsonObject = (value: string): Record<string, any> | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const unfenced = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(unfenced);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
  } catch {
    const firstBrace = unfenced.indexOf('{');
    const lastBrace = unfenced.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(unfenced.slice(firstBrace, lastBrace + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, any>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
};

const normalizeCategory = (value: unknown): ModerationCategory | null => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (CATEGORY_SET.has(raw as ModerationCategory)) return raw as ModerationCategory;
  if (/(abuse|profan|toxic|insult)/.test(raw)) return 'abusive_language';
  if (/(harass|threat|intimidat|bully)/.test(raw)) return 'harassment_or_threat';
  if (/(self.?harm|suicid)/.test(raw)) return 'self_harm';
  if (/(violence|violent|attack|murder|kill)/.test(raw)) return 'violence';
  if (/(company|project|system|product|service)/.test(raw)) return 'company_or_project_abuse';
  if (/(hate|discriminat|racis|sexis|slur)/.test(raw)) return 'hate_or_discrimination';
  if (/(sexual|sex|harass|rape|molest)/.test(raw)) return 'sexual_harassment_or_abuse';
  return null;
};

const normalizeSource = (value: unknown): 'query' | 'answer' => {
  const raw = String(value || '').trim().toLowerCase();
  if (/(answer|assistant|response|output)/.test(raw)) return 'answer';
  return 'query';
};

const normalizeConfidence = (value: unknown): number | undefined => {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, Number(n.toFixed(3))));
};

const clampSeverity = (value: unknown, fallback: number = 3): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n)));
};

const normalizeLlmReasons = (value: unknown): ModerationReason[] => {
  if (!Array.isArray(value)) return [];
  const reasons: ModerationReason[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const category = normalizeCategory((item as any).category);
    if (!category) continue;
    const reasonText = clipReasonText((item as any).reason);
    const matchedText = clipReasonText((item as any).matchedText || (item as any).quote);
    reasons.push({
      category,
      reason: reasonText || 'Flagged by vLLM moderation',
      matchedText,
      severity: clampSeverity((item as any).severity, 3),
      source: normalizeSource((item as any).source),
      detector: 'vllm',
      confidence: normalizeConfidence((item as any).confidence) ?? 0.75,
    });
  }
  return dedupeReasons(reasons.slice(0, MODERATION_LLM_MAX_REASONS));
};

const truncateForModeration = (value: string) =>
  normalizeWhitespace(normalizeComparableText(value)).slice(0, MODERATION_LLM_MAX_TEXT_CHARS);

const shouldRunLlmModeration = (
  queryText: string,
  answerText: string,
  ruleReasons: ModerationReason[],
): boolean => {
  if (!MODERATION_LLM_ENABLED) return false;

  const query = truncateForModeration(queryText);
  const answer = truncateForModeration(answerText);
  const combined = [query, answer].filter(Boolean).join('\n');
  if (!combined) return false;

  if (ruleReasons.some((reason) => Number(reason.severity || 0) >= 5)) {
    return false;
  }

  const suspiciousInputs = [
    query.toLowerCase(),
    answer.toLowerCase(),
    toAsciiCompact(query),
    toAsciiCompact(answer),
  ].join('\n');

  if (ruleReasons.length > 0) return true;
  return SUSPICIOUS_LLM_CUE_RE.test(suspiciousInputs);
};

const buildModerationMessages = (queryText: string, answerText: string): ChatMessage[] => {
  const query = truncateForModeration(queryText);
  const answer = truncateForModeration(answerText);
  return [
    {
      role: 'system',
      content: [
        'You are a strict moderation classifier for enterprise chat analytics.',
        'Return JSON only with this schema:',
        '{"flagged":boolean,"reasons":[{"category":"...","reason":"...","matchedText":"...","source":"query|answer","severity":1-5,"confidence":0-1}]}',
        'Valid categories: abusive_language, harassment_or_threat, self_harm, violence, company_or_project_abuse, hate_or_discrimination, sexual_harassment_or_abuse.',
        'Flag only when the text itself contains abusive, threatening, self-harm, violent, hateful, discriminatory, sexually abusive, or targeted hostile language.',
        'Do not flag harmless technical phrases like "kill process", "kill -9", "killer feature", or neutral policy discussion.',
        'If not flagged, return {"flagged":false,"reasons":[]}.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        'Classify the following chat content.',
        `User query:\n${query || '(empty)'}`,
        `Assistant answer:\n${answer || '(empty)'}`,
      ].join('\n\n'),
    },
  ];
};

const runLlmModeration = async (
  queryText: string,
  answerText: string,
): Promise<ModerationReason[]> => {
  try {
    const response = await openaiClient.generate(buildModerationMessages(queryText, answerText), {
      model: MODERATION_LLM_MODEL,
      temperature: 0,
      max_tokens: 260,
      timeout_ms: MODERATION_LLM_TIMEOUT_MS,
      response_format: { type: 'json_object' },
      retry_on_empty: false,
    });
    const parsed = tryParseAnyJsonObject(response.content || '');
    if (!parsed) return [];
    const flagged = Boolean(parsed.flagged);
    const reasons = normalizeLlmReasons(parsed.reasons);
    if (!flagged && reasons.length === 0) return [];
    return reasons;
  } catch (error: any) {
    console.warn('[Moderation] vLLM moderation skipped:', String(error?.message || error));
    return [];
  }
};

export async function analyzeModeration(queryText?: string, answerText?: string): Promise<ModerationAnalysis> {
  const queryReasons = findRuleReasons(String(queryText || ''), 'query');
  const answerReasons = findRuleReasons(String(answerText || ''), 'answer');
  const ruleReasons = dedupeReasons([...queryReasons, ...answerReasons]);
  const llmReasons = shouldRunLlmModeration(String(queryText || ''), String(answerText || ''), ruleReasons)
    ? await runLlmModeration(String(queryText || ''), String(answerText || ''))
    : [];
  const reasons = dedupeReasons([...ruleReasons, ...llmReasons]);
  const score = reasons.reduce((acc, item) => acc + Math.max(0, Number(item.severity || 0)), 0);
  const detectors = Array.from(new Set(reasons.map((item) => item.detector || 'rules')));

  return {
    flagged: reasons.length > 0,
    score,
    reasons,
    detectors,
    llmAssisted: detectors.includes('vllm'),
  };
}
