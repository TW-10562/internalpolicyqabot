import ngWordsConfigRaw from '@config/ng-words.json';
import { detectRagLanguage } from '@/rag/language/detectLanguage';
import { ChatMessage, openaiClient } from '@/service/openai_client';

export type ModerationCategory =
  | 'abusive_language'
  | 'abusive_harassment'
  | 'harassment_or_threat'
  | 'self_harm'
  | 'violence'
  | 'company_directed_abuse'
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
  ruleId?: string;
};

export type ModerationAnalysis = {
  flagged: boolean;
  score: number;
  reasons: ModerationReason[];
  detectors: ModerationDetector[];
  llmAssisted: boolean;
};

export type QueryModerationGateResult = ModerationAnalysis & {
  blocked: boolean;
  skipSearch: boolean;
  reply: string;
  language: 'ja' | 'en';
  categories: ModerationCategory[];
  matchedRuleIds: string[];
  normalizedText: string;
  compactText: string;
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
  sexual?: NgWordSection;
  companyAbuse?: NgWordSection;
  allowlist?: {
    phrases?: string[];
  };
};

type ModerationTextForms = {
  original: string;
  normalized: string;
  lower: string;
  compact: string;
  compactAscii: string;
  compactAsciiCollapsed: string;
  language: 'ja' | 'en';
  hasJapanese: boolean;
};

type RuleTarget = keyof Pick<ModerationTextForms, 'normalized' | 'lower' | 'compact' | 'compactAscii' | 'compactAsciiCollapsed'>;

type RuleDef = {
  id: string;
  category: ModerationCategory;
  reason: string;
  severity: number;
  patterns: RegExp[];
  target?: RuleTarget;
  sourceScope?: 'query' | 'answer' | 'both';
  blockEvenInReporterContext?: boolean;
};

type FindRuleOptions = {
  applyReporterExemption?: boolean;
};

type ConfigSectionRule = {
  category: ModerationCategory;
  reason: string;
  severity: number;
  phrases: string[];
  regex: RegExp[];
  rulePrefix: string;
};

const CATEGORY_SET = new Set<ModerationCategory>([
  'abusive_language',
  'abusive_harassment',
  'harassment_or_threat',
  'self_harm',
  'violence',
  'company_directed_abuse',
  'company_or_project_abuse',
  'hate_or_discrimination',
  'sexual_harassment_or_abuse',
]);

export const MODERATION_REPLY_EN =
  "I hear your frustration. I’m not able to help with abusive or harmful language here. If you want, you can rephrase your concern in a respectful way and I’ll help.";
export const MODERATION_REPLY_JA =
  'お気持ちは理解します。ただし、攻撃的または有害な表現には対応できません。よろしければ、落ち着いた表現で言い換えていただければお手伝いします。';

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
      .map((item) => normalizeComparableText(String(item || '')).toLowerCase())
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
      // Skip malformed regex in config instead of breaking moderation.
    }
  }
  return patterns;
};

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
    .replace(/!/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/\$/g, 's');

const collapseRepeatedLatin = (value: string) => value.replace(/([a-z])\1{1,}/g, '$1');

const countMatches = (value: string, pattern: RegExp) => {
  const matches = value.match(pattern);
  return matches ? matches.length : 0;
};

const buildTextForms = (value: string): ModerationTextForms => {
  const normalized = normalizeWhitespace(normalizeComparableText(value));
  const lower = normalized.toLowerCase();
  const compact = lower.replace(/[\s\p{P}\p{S}_]+/gu, '');
  const compactAscii = normalizeLeetspeak(lower).replace(/[^a-z]+/g, '');
  const compactAsciiCollapsed = collapseRepeatedLatin(compactAscii);
  const japaneseChars = countMatches(normalized, /[\u3040-\u30ff\u3400-\u9fff]/g);
  const latinChars = countMatches(normalized, /[a-z]/gi);
  const hasJapanese = japaneseChars > 0;
  const language =
    hasJapanese && (japaneseChars >= 2 || japaneseChars >= latinChars)
      ? 'ja'
      : (detectRagLanguage(normalized || value || '') === 'ja' ? 'ja' : 'en');

  return {
    original: String(value || ''),
    normalized,
    lower,
    compact,
    compactAscii,
    compactAsciiCollapsed,
    language,
    hasJapanese,
  };
};

const clipReasonText = (value: unknown) => String(value || '').trim().slice(0, 160);

const getStaticModerationReply = (language: 'ja' | 'en') =>
  language === 'ja' ? MODERATION_REPLY_JA : MODERATION_REPLY_EN;

const NARROW_ALLOWLIST_PATTERNS = [
  /\bkill\s+-?9\b/i,
  /\bkill\s+process(?:es)?\b/i,
  /\bkiller\s+feature\b/i,
  /\bkill\s+the\s+job\b/i,
  /\bslap\s+function\b/i,
];

const REPORT_CONTEXT_PATTERNS_EN = [
  /\b(i want to|i need to|can i|how do i|please|need help to)\s+(report|raise|file|submit|discuss|consult about)\b/i,
  /\b(report|complain about|consult about|discuss|talk about)\s+(harassment|abuse|sexual harassment|threats?|bullying|discrimination|hate speech)\b/i,
  /\b(i was|i've been|i have been|i got|i feel|someone|my (boss|manager|coworker|co-worker|team lead|hr))\b[\s\S]{0,40}\b(threatened|harassed|bullied|abused|assaulted|told me|called me|said to me|forced)\b/i,
  /\b(i want to|i need to|can you help me)\b[\s\S]{0,24}\b(report|consult|discuss)\b/i,
  /\b(sexual harassment|harassment|bullying|threats?|abuse|discrimination)\b[\s\S]{0,24}\b(report|consult|support|help|complaint)\b/i,
];

const REPORT_CONTEXT_PATTERNS_JA = [
  /(相談したい|相談できますか|相談したいです|報告したい|報告できますか|通報したい|申告したい|相談窓口|相談先)/,
  /(受けた|された|言われた|脅された|怒鳴られた|被害にあった|被害を受けた|被害です|言動があった)/,
  /(セクハラ|パワハラ|嫌がらせ|脅迫|暴言|差別|レイプ|性的なことを強要).{0,16}(受けた|された|相談|報告|被害)/,
  /(上司|同僚|部下|マネージャー|人事|HR).{0,16}(に|から).{0,16}(言われた|された|受けた)/,
];

const DIRECT_SELF_HARM_PATTERNS = [
  /\b(i want to|i'm going to|i will|i should|i might)\s+(kill myself|end my life|commit suicide|hurt myself)\b/i,
  /\bkill\s+myself\b/i,
  /(自殺したい|死にたい|消えたい|自分を傷つけたい|自分を殺したい)/,
];

const CONFIG_SECTION_RULES: ConfigSectionRule[] = [
  {
    category: 'violence',
    reason: 'Matched configured violence blocklist',
    severity: 5,
    phrases: normalizePhraseList(ngWordsConfig.violence?.phrases),
    regex: compileRegexList(ngWordsConfig.violence?.regex),
    rulePrefix: 'cfg_violence',
  },
  {
    category: 'self_harm',
    reason: 'Matched configured self-harm blocklist',
    severity: 5,
    phrases: normalizePhraseList(ngWordsConfig.selfHarm?.phrases),
    regex: compileRegexList(ngWordsConfig.selfHarm?.regex),
    rulePrefix: 'cfg_self_harm',
  },
  {
    category: 'harassment_or_threat',
    reason: 'Matched configured threat/harassment blocklist',
    severity: 4,
    phrases: normalizePhraseList(ngWordsConfig.harassment?.phrases),
    regex: compileRegexList(ngWordsConfig.harassment?.regex),
    rulePrefix: 'cfg_threat',
  },
  {
    category: 'abusive_language',
    reason: 'Matched configured abusive-language blocklist',
    severity: 4,
    phrases: normalizePhraseList(ngWordsConfig.abuse?.phrases),
    regex: compileRegexList(ngWordsConfig.abuse?.regex),
    rulePrefix: 'cfg_abuse',
  },
  {
    category: 'hate_or_discrimination',
    reason: 'Matched configured hate/discrimination blocklist',
    severity: 5,
    phrases: normalizePhraseList(ngWordsConfig.hate?.phrases),
    regex: compileRegexList(ngWordsConfig.hate?.regex),
    rulePrefix: 'cfg_hate',
  },
  {
    category: 'sexual_harassment_or_abuse',
    reason: 'Matched configured sexual-harassment blocklist',
    severity: 5,
    phrases: normalizePhraseList(ngWordsConfig.sexual?.phrases),
    regex: compileRegexList(ngWordsConfig.sexual?.regex),
    rulePrefix: 'cfg_sexual',
  },
  {
    category: 'company_directed_abuse',
    reason: 'Matched configured company-directed abuse blocklist',
    severity: 4,
    phrases: normalizePhraseList(ngWordsConfig.companyAbuse?.phrases),
    regex: compileRegexList(ngWordsConfig.companyAbuse?.regex),
    rulePrefix: 'cfg_company',
  },
];

const NG_ALLOWLIST_PHRASES = normalizePhraseList(ngWordsConfig.allowlist?.phrases);

const RULES: RuleDef[] = [
  {
    id: 'abuse_en_profanity',
    category: 'abusive_language',
    reason: 'Contains abusive or profane language',
    severity: 3,
    target: 'lower',
    patterns: [
      /\bf[\W_]*(?:u|v|\*+)?[\W_]*c[\W_]*k(?:[\W_]*off)?\b/i,
      /\bsh[\W_]*i[\W_]*t\b/i,
      /\ba[\W_]*s[\W_]*s[\W_]*h[\W_]*o[\W_]*l[\W_]*e\b/i,
      /\bb(?:i|!|1)[\W_]*t[\W_]*c[\W_]*h\b/i,
      /\bmother[\W_]*f[\W_]*u[\W_]*c[\W_]*k[\W_]*e[\W_]*r\b/i,
      /\b(cunt|prick|dickhead|jackass|bullshit)\b/i,
    ],
  },
  {
    id: 'abuse_en_compact',
    category: 'abusive_language',
    reason: 'Contains obfuscated abusive language',
    severity: 3,
    target: 'compactAsciiCollapsed',
    patterns: [
      /fuck/,
      /shit/,
      /asshole/,
      /bitch/,
      /motherfucker/,
      /bastard/,
      /idiot/,
      /moron/,
      /stupid/,
      /dumb/,
      /loser/,
      /scumbag/,
      /trash/,
      /garbage/,
    ],
  },
  {
    id: 'abuse_ja_direct',
    category: 'abusive_language',
    reason: 'Contains Japanese abusive or insulting language',
    severity: 3,
    target: 'compact',
    patterns: [
      /(?:くそ|クソ|ばか|バカ|馬鹿|あほ|アホ|かす|カス|ごみ|ゴミ|無能|役立たず|きもい|うざい|黙れ|消えろ|くたばれ)/,
      /(?:ばー?か|ばぁ?か|ばかやろう|バカヤロー)/,
      /(?:baka|aho|kuso|gomi|kasu)/,
    ],
  },
  {
    id: 'abusive_harassment_en',
    category: 'abusive_harassment',
    reason: 'Contains direct abusive harassment toward a person',
    severity: 4,
    target: 'lower',
    patterns: [
      /\b(fuck you|fuck off|go to hell|shut up|stfu)\b/i,
      /\byou('?re| are)\s+(an?\s+)?(idiot|moron|stupid|dumb|loser|scumbag|bitch|worthless|pathetic)\b/i,
      /\bthat\s+(manager|boss|coworker|co-worker|hr|team lead)\s+is\s+(a\s+)?(bitch|idiot|moron|trash|garbage|useless)\b/i,
    ],
  },
  {
    id: 'abusive_harassment_ja',
    category: 'abusive_harassment',
    reason: 'Contains direct Japanese abusive harassment',
    severity: 4,
    target: 'compact',
    patterns: [
      /(?:死ね|しね|シネ|消えろ|黙れ|ぶさいく|ブス|役立たず)/,
      /(?:あいつ|その上司|その同僚|あの人).{0,10}(バカ|アホ|クソ|ゴミ|無能)/,
      /(?:omae|teme[e]*).{0,8}(baka|aho|kuso)/,
    ],
  },
  {
    id: 'threat_en_direct',
    category: 'harassment_or_threat',
    reason: 'Contains a direct threat, coercion, or intimidation',
    severity: 5,
    target: 'lower',
    patterns: [
      /\b(i('| a)?m going to|i will|i'll)\s+(kill|hurt|beat|attack|destroy|ruin|slap|punch|stab)\s+(you|him|her|them|my (boss|manager|coworker|co-worker|hr|team))\b/i,
      /\b(do it or else|or i'll ruin you|or i will ruin you|i'll make you pay)\b/i,
      /\b(threaten|blackmail|coerce|intimidate|bully)\b/i,
    ],
  },
  {
    id: 'threat_en_selfharm_command_compact',
    category: 'harassment_or_threat',
    reason: 'Contains a self-harm command directed at someone else',
    severity: 5,
    target: 'compactAscii',
    patterns: [
      /gokillyourself/,
      /killyourself/,
    ],
  },
  {
    id: 'threat_ja_direct',
    category: 'harassment_or_threat',
    reason: 'Contains a direct Japanese threat or intimidation',
    severity: 5,
    target: 'compact',
    patterns: [
      /(?:殺してやる|ぶっ殺す|痛い目にあわせる|殴ってやる|脅してやる|言うことを聞け|従わないと)/,
      /(?:死ね|しね|消えろ|黙れ)/,
      /(?:脅迫|脅す|強要する|言うことを聞かなければ)/,
      /(?:korosu|bukkorosu|shineyo)/,
    ],
  },
  {
    id: 'self_harm_en',
    category: 'self_harm',
    reason: 'Contains self-harm or suicide intent',
    severity: 5,
    target: 'lower',
    blockEvenInReporterContext: true,
    patterns: [
      /\b(i want to|i'm going to|i will|i should|i might)\s+(kill myself|end my life|commit suicide|hurt myself)\b/i,
      /\b(kill myself|commit suicide|end my life|self harm)\b/i,
    ],
  },
  {
    id: 'self_harm_ja',
    category: 'self_harm',
    reason: 'Contains Japanese self-harm or suicide intent',
    severity: 5,
    target: 'compact',
    blockEvenInReporterContext: true,
    patterns: [
      /(?:自殺したい|死にたい|消えたい|自傷したい|自分を殺したい)/,
    ],
  },
  {
    id: 'violence_en',
    category: 'violence',
    reason: 'Contains violent intent or instruction',
    severity: 5,
    target: 'lower',
    patterns: [
      /\b(i want to|i'm going to|i will)\s+(slap|hit|beat|punch|stab|shoot|murder|poison|attack)\s+(him|her|them|my (boss|manager|coworker|co-worker|team))\b/i,
      /\bhow\s+to\s+(kill|murder|assassinate|poison|stab|shoot|attack)\b/i,
      /\bi want to slap my coworker\b/i,
    ],
  },
  {
    id: 'violence_ja',
    category: 'violence',
    reason: 'Contains Japanese violent intent or instruction',
    severity: 5,
    target: 'compact',
    patterns: [
      /(?:殴る|刺す|殺す|攻撃する|爆破する|毒を盛る).{0,8}(方法|やり方)?/,
      /(?:人を|あいつを|上司を|同僚を).{0,8}(殴る|刺す|殺す|攻撃する)/,
      /(?:ころす|なぐる|さす)/,
    ],
  },
  {
    id: 'company_abuse_en',
    category: 'company_directed_abuse',
    reason: 'Contains hostile abuse directed at company, HR, or workplace',
    severity: 4,
    target: 'lower',
    patterns: [
      /\b(hr|human resources|company|organization|manager|boss|coworker|co-worker|team|system|app|assistant|qa bot)\b[\s\S]{0,24}\b(garbage|trash|useless|idiots?|morons?|bitches?|pathetic|worthless|awful|terrible|joke)\b/i,
      /\b(garbage|trash|useless|idiots?|morons?|pathetic|worthless|awful|terrible|joke)\b[\s\S]{0,24}\b(hr|human resources|company|organization|manager|boss|coworker|co-worker|team|system|app|assistant|qa bot)\b/i,
    ],
  },
  {
    id: 'company_abuse_ja',
    category: 'company_directed_abuse',
    reason: 'Contains hostile abuse directed at company, HR, or workplace in Japanese',
    severity: 4,
    target: 'compact',
    patterns: [
      /(?:人事|hr|会社|組織|上司|部長|同僚|チーム|システム|アプリ|ボット).{0,12}(クソ|ゴミ|最悪|使えない|無能|嫌い|ひどい)/,
      /(?:クソ|ゴミ|最悪|使えない|無能|ひどい).{0,12}(人事|hr|会社|組織|上司|部長|同僚|チーム|システム|アプリ|ボット)/,
    ],
  },
  {
    id: 'hate_en',
    category: 'hate_or_discrimination',
    reason: 'Contains hateful or discriminatory language',
    severity: 5,
    target: 'lower',
    patterns: [
      /\bi hate\s+(women|men|foreigners|immigrants|jews|muslims|christians|asians|blacks?|whites?|gays?|lesbians?|trans people|disabled people)\b/i,
      /\b(women|men|foreigners|immigrants|jews|muslims|christians|asians|blacks?|whites?|gays?|lesbians?|trans people|disabled people)\s+are\s+(useless|inferior|disgusting|stupid|worthless)\b/i,
      /\b(racist|sexist|homophobic)\s+(slur|garbage|idiots?)\b/i,
    ],
  },
  {
    id: 'hate_ja',
    category: 'hate_or_discrimination',
    reason: 'Contains hateful or discriminatory language in Japanese',
    severity: 5,
    target: 'compact',
    patterns: [
      /(?:女|男|外国人|障害者|ゲイ|レズ|在日).{0,10}(嫌い|嫌だ|役に立たない|いらない|劣っている|気持ち悪い)/,
      /(?:在日だから嫌い|女は役に立たない|男は役に立たない)/,
      /(?:差別してやる|差別すべき)/,
    ],
  },
  {
    id: 'sexual_en',
    category: 'sexual_harassment_or_abuse',
    reason: 'Contains sexual harassment, coercion, or abuse',
    severity: 5,
    target: 'lower',
    patterns: [
      /\b(send me sexual favors|do sexual favors for me|sleep with me|have sex with me)\b/i,
      /\b(i want to rape|rape (him|her|them)|molest (him|her|them))\b/i,
      /\b(show me (your )?(body|breasts|nudes)|send nudes)\b/i,
      /\b(sexual favors?|sexual acts?)\b[\s\S]{0,16}\b(or else|must|need to|now)\b/i,
    ],
  },
  {
    id: 'sexual_ja',
    category: 'sexual_harassment_or_abuse',
    reason: 'Contains Japanese sexual harassment, coercion, or abuse',
    severity: 5,
    target: 'compact',
    patterns: [
      /(?:性的なこと|体を触らせろ|裸を見せろ|性的サービス).{0,10}(しろ|して|要求|強要)/,
      /(?:レイプする|犯してやる|性的な関係を強要)/,
      /(?:セックスしろ|裸の写真を送れ)/,
    ],
  },
];

const isAllowlistedText = (forms: ModerationTextForms) =>
  NARROW_ALLOWLIST_PATTERNS.some((pattern) => pattern.test(forms.normalized)) ||
  NG_ALLOWLIST_PHRASES.some((phrase) => phrase && forms.lower.includes(phrase));

const dedupeReasons = (items: ModerationReason[]): ModerationReason[] => {
  const seen = new Set<string>();
  const out: ModerationReason[] = [];
  for (const item of items) {
    const key = [
      item.source,
      item.category,
      item.detector || 'rules',
      item.ruleId || '',
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

const looksLikeReporterContext = (forms: ModerationTextForms) =>
  REPORT_CONTEXT_PATTERNS_EN.some((pattern) => pattern.test(forms.normalized)) ||
  REPORT_CONTEXT_PATTERNS_JA.some((pattern) => pattern.test(forms.normalized));

const isDirectSelfHarmIntent = (forms: ModerationTextForms) =>
  DIRECT_SELF_HARM_PATTERNS.some((pattern) => pattern.test(forms.normalized));

const collectConfigReasons = (
  forms: ModerationTextForms,
  source: 'query' | 'answer',
): ModerationReason[] => {
  if (!forms.normalized || isAllowlistedText(forms)) return [];
  const reasons: ModerationReason[] = [];

  for (const section of CONFIG_SECTION_RULES) {
    section.phrases.forEach((phrase, index) => {
      if (!phrase) return;
      const phraseCompact = phrase.replace(/[\s\p{P}\p{S}_]+/gu, '');
      const matched =
        forms.lower.includes(phrase) ||
        (phraseCompact.length >= 2 && forms.compact.includes(phraseCompact));
      if (!matched) return;
      reasons.push({
        category: section.category,
        reason: section.reason,
        matchedText: clipReasonText(phrase),
        severity: section.severity,
        source,
        detector: 'rules',
        confidence: 0.98,
        ruleId: `${section.rulePrefix}_phrase_${index + 1}`,
      });
    });

    section.regex.forEach((pattern, index) => {
      const match = forms.normalized.match(pattern);
      if (!match?.[0]) return;
      reasons.push({
        category: section.category,
        reason: section.reason,
        matchedText: clipReasonText(match[0]),
        severity: section.severity,
        source,
        detector: 'rules',
        confidence: 0.97,
        ruleId: `${section.rulePrefix}_regex_${index + 1}`,
      });
    });
  }

  return reasons;
};

const collectRuleReasons = (
  forms: ModerationTextForms,
  source: 'query' | 'answer',
): ModerationReason[] => {
  if (!forms.normalized || isAllowlistedText(forms)) return [];
  const reasons: ModerationReason[] = [];

  for (const rule of RULES) {
    const scope = rule.sourceScope || 'both';
    if (scope !== 'both' && scope !== source) continue;
    const target = rule.target || 'normalized';
    const haystack = forms[target];
    if (!haystack) continue;

    for (const pattern of rule.patterns) {
      const match = haystack.match(pattern);
      if (!match?.[0]) continue;
      reasons.push({
        category: rule.category,
        reason: rule.reason,
        matchedText: clipReasonText(match[0]),
        severity: rule.severity,
        source,
        detector: 'rules',
        confidence: 0.95,
        ruleId: rule.id,
      });
      break;
    }
  }

  return reasons;
};

const filterReporterContextReasons = (
  reasons: ModerationReason[],
  forms: ModerationTextForms,
): ModerationReason[] => {
  if (!looksLikeReporterContext(forms) || isDirectSelfHarmIntent(forms)) {
    return reasons;
  }

  const blockedRuleIds = new Set(
    RULES
      .filter((rule) => rule.blockEvenInReporterContext)
      .map((rule) => rule.id),
  );

  return reasons.filter((reason) => blockedRuleIds.has(String(reason.ruleId || '')));
};

function findRuleReasons(
  text: string,
  source: 'query' | 'answer',
  options: FindRuleOptions = {},
): ModerationReason[] {
  const forms = buildTextForms(text);
  if (!forms.normalized) return [];

  const reasons = dedupeReasons([
    ...collectConfigReasons(forms, source),
    ...collectRuleReasons(forms, source),
  ]);

  if (source !== 'query' || !options.applyReporterExemption) {
    return reasons;
  }

  return dedupeReasons(filterReporterContextReasons(reasons, forms));
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
  if (/(abusive.?harass|bully)/.test(raw)) return 'abusive_harassment';
  if (/(abuse|profan|toxic|insult)/.test(raw)) return 'abusive_language';
  if (/(harass|threat|intimidat|blackmail|coerc)/.test(raw)) return 'harassment_or_threat';
  if (/(self.?harm|suicid)/.test(raw)) return 'self_harm';
  if (/(violence|violent|attack|murder|kill)/.test(raw)) return 'violence';
  if (/(company|project|system|product|service|hr|organization|manager|boss)/.test(raw)) return 'company_directed_abuse';
  if (/(hate|discriminat|racis|sexis|slur)/.test(raw)) return 'hate_or_discrimination';
  if (/(sexual|sex|rape|molest)/.test(raw)) return 'sexual_harassment_or_abuse';
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
      ruleId: String((item as any).ruleId || '').trim() || undefined,
    });
  }
  return dedupeReasons(reasons.slice(0, MODERATION_LLM_MAX_REASONS));
};

const truncateForModeration = (value: string) =>
  normalizeWhitespace(normalizeComparableText(value)).slice(0, MODERATION_LLM_MAX_TEXT_CHARS);

const SUSPICIOUS_LLM_CUE_RE =
  /\b(fuck|shit|bitch|asshole|motherfucker|bastard|idiot|moron|dumb|stupid|trash|garbage|useless|worthless|pathetic|hate|kill|murder|suicide|die|attack|hurt|blackmail|harass|threat|racist|sexist|rape|molest)\b|(?:死ね|殺す|自殺|ゴミ|クソ|バカ|アホ|黙れ|消えろ|脅迫|差別|レイプ|セクハラ)/i;

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
    buildTextForms(query).compactAsciiCollapsed,
    buildTextForms(answer).compactAsciiCollapsed,
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
        '{"flagged":boolean,"reasons":[{"category":"...","reason":"...","matchedText":"...","source":"query|answer","severity":1-5,"confidence":0-1,"ruleId":"optional"}]}',
        'Valid categories: abusive_language, abusive_harassment, harassment_or_threat, self_harm, violence, company_directed_abuse, hate_or_discrimination, sexual_harassment_or_abuse.',
        'Flag only when the text itself contains abusive, threatening, self-harm, violent, hateful, discriminatory, sexually abusive, coercive, or targeted hostile language.',
        'Do not flag neutral reporting or consultation requests about harassment or abuse unless the user is directly using the abusive language.',
        'Do not flag harmless technical phrases like "kill process", "kill -9", or neutral policy discussion.',
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

const buildAnalysis = (reasons: ModerationReason[]): ModerationAnalysis => {
  const deduped = dedupeReasons(reasons);
  const score = deduped.reduce((acc, item) => acc + Math.max(0, Number(item.severity || 0)), 0);
  const detectors = Array.from(new Set(deduped.map((item) => item.detector || 'rules')));

  return {
    flagged: deduped.length > 0,
    score,
    reasons: deduped,
    detectors,
    llmAssisted: detectors.includes('vllm'),
  };
};

export function moderateUserQuery(queryText?: string): QueryModerationGateResult {
  const forms = buildTextForms(String(queryText || ''));
  const reasons = findRuleReasons(forms.normalized, 'query', { applyReporterExemption: true });
  const analysis = buildAnalysis(reasons);
  const categories = Array.from(new Set(analysis.reasons.map((reason) => reason.category)));
  const matchedRuleIds = Array.from(
    new Set(
      analysis.reasons
        .map((reason) => String(reason.ruleId || '').trim())
        .filter(Boolean),
    ),
  );

  return {
    ...analysis,
    blocked: analysis.flagged,
    skipSearch: analysis.flagged,
    reply: getStaticModerationReply(forms.language),
    language: forms.language,
    categories,
    matchedRuleIds,
    normalizedText: forms.normalized,
    compactText: forms.compact,
  };
}

export async function analyzeModeration(queryText?: string, answerText?: string): Promise<ModerationAnalysis> {
  const queryReasons = findRuleReasons(String(queryText || ''), 'query', { applyReporterExemption: true });
  const answerReasons = findRuleReasons(String(answerText || ''), 'answer');
  const ruleReasons = dedupeReasons([...queryReasons, ...answerReasons]);
  const llmReasons = shouldRunLlmModeration(String(queryText || ''), String(answerText || ''), ruleReasons)
    ? await runLlmModeration(String(queryText || ''), String(answerText || ''))
    : [];
  return buildAnalysis([...ruleReasons, ...llmReasons]);
}

export function analyzeModerationRulesOnly(queryText?: string, answerText?: string): ModerationAnalysis {
  const queryReasons = findRuleReasons(String(queryText || ''), 'query', { applyReporterExemption: true });
  const answerReasons = findRuleReasons(String(answerText || ''), 'answer');
  return buildAnalysis([...queryReasons, ...answerReasons]);
}
