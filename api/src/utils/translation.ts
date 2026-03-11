/**
 * Translation utility for dual-language chat pipeline
 * Flow: user_query → translate to JP → retrieve JP → generate JP → translate back
 */

import { openaiClient, ChatMessage } from '@/service/openai_client';
import { STRICT_OLLAMA_MODEL } from '@/constants/llm';
import { detectLanguage as detectSharedLanguage } from '@/utils/languageDetector';
import {
  buildTranslationCacheKey,
  getCachedTranslation,
  setCachedTranslation,
} from '@/rag/cache/translationCache';
import { recordRagDecision } from '@/rag/metrics/ragDecisionMetrics';

// Language detection patterns
const japanesePattern = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/;

export type LanguageCode = 'ja' | 'en' | 'unknown';

const isConnRefused = (error: unknown) => {
  const e = error as any;
  return (
    e?.cause?.code === 'ECONNREFUSED' ||
    e?.code === 'ECONNREFUSED' ||
    /ECONNREFUSED|connect/i.test(String(e?.message || error || ''))
  );
};

const DEFAULT_TRANSLATION_TIMEOUT_MS = 20000;
const TRANSLATION_REQUEST_TIMEOUT_MS = 20000;
const TRANSLATION_REFINE_TIMEOUT_MS = Math.max(
  1500,
  Number(process.env.TRANSLATION_REFINE_TIMEOUT_MS || 4500),
);
const TRANSLATION_MAX_TOKENS = 700;
const TRANSLATION_MAX_TIMEOUT_MS = 25000;
const TRANSLATION_TEMPERATURE = 0;
const TRANSLATION_TOP_P = 0.9;
const PRIMARY_LLM_MODEL = String(process.env.LLM_MODEL || 'openai/gpt-oss-20b').trim();
const TRANSLATION_LLM_REASONING_EFFORT = String(
  process.env.TRANSLATION_LLM_REASONING_EFFORT ||
  process.env.LLM_REASONING_EFFORT ||
  'low',
).trim();
const TRANSLATION_OPTIMIZED_PATH_ENABLED = String(process.env.TRANSLATION_OPTIMIZED_PATH_ENABLED || '0') === '1';
const TRANSLATION_PROMPT_VERSION = String(process.env.TRANSLATION_PROMPT_VERSION || 'v2');
const TRANSLATE_ON_DEMAND_FAIL_OPEN = String(process.env.TRANSLATE_ON_DEMAND_FAIL_OPEN || '1') !== '0';
const TRANSLATE_ON_DEMAND_SKIP_FINALIZE = String(process.env.TRANSLATE_ON_DEMAND_SKIP_FINALIZE || '1') !== '0';
const TRANSLATE_ON_DEMAND_ALLOW_LOCAL_MOCK = String(process.env.TRANSLATE_ON_DEMAND_ALLOW_LOCAL_MOCK || '0') === '1';
const TRANSLATE_ON_DEMAND_SECOND_PASS = String(process.env.TRANSLATE_ON_DEMAND_SECOND_PASS || '0') === '1';
const TRANSLATION_MIN_JA_RATIO = Math.max(
  0.2,
  Math.min(0.95, Number(process.env.TRANSLATION_MIN_JA_RATIO || 0.45)),
);
const TRANSLATION_MAX_JA_RATIO_FOR_EN = Math.max(
  0,
  Math.min(0.35, Number(process.env.TRANSLATION_MAX_JA_RATIO_FOR_EN || 0.35)),
);

const joinTextParts = (parts: string[]): string => {
  let out = '';
  for (const rawPart of parts) {
    const part = String(rawPart || '');
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    const prevChar = out.slice(-1);
    const nextChar = part[0];
    const needsSpace =
      !/\s/.test(prevChar) &&
      !/\s/.test(nextChar) &&
      /[A-Za-z0-9]$/.test(prevChar) &&
      /^[A-Za-z0-9]/.test(nextChar);
    out += needsSpace ? ` ${part}` : part;
  }
  return out;
};

const clampTranslationTimeoutMs = (timeoutMs?: number): number => {
  const parsed = Number(timeoutMs || TRANSLATION_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return TRANSLATION_REQUEST_TIMEOUT_MS;
  }
  return Math.max(1500, Math.min(TRANSLATION_MAX_TIMEOUT_MS, parsed));
};

type TranslationCompletionRequest = {
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  label: string;
};

const buildTranslationExtraBody = (): Record<string, any> | undefined => {
  const extraBody: Record<string, any> = {};
  if (TRANSLATION_LLM_REASONING_EFFORT) {
    extraBody.reasoning_effort = TRANSLATION_LLM_REASONING_EFFORT;
  }
  return Object.keys(extraBody).length > 0 ? extraBody : undefined;
};

const requestTranslationCompletion = async ({
  messages,
  temperature,
  maxTokens,
  timeoutMs,
  label: _label,
}: TranslationCompletionRequest): Promise<string> => {
  const effectiveTimeoutMs = clampTranslationTimeoutMs(timeoutMs);
  const response = await openaiClient.generate(messages, {
    model: PRIMARY_LLM_MODEL,
    stream: false,
    temperature,
    top_p: TRANSLATION_TOP_P,
    max_tokens: maxTokens,
    timeout_ms: effectiveTimeoutMs,
    retry_on_empty: false,
    allow_reasoning_fallback: false,
    extra_body: buildTranslationExtraBody(),
  });
  return sanitizeTranslationOutput(String(response?.content || '').trim());
};

const candidateToText = (candidate: any): string => {
  if (candidate == null) return '';
  if (typeof candidate === 'string') return candidate.trim();
  if (Array.isArray(candidate)) {
    const parts = candidate
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          return String(item.text || item.content || item.value || '');
        }
        return '';
      })
      .filter(Boolean);
    return joinTextParts(parts).trim();
  }
  if (typeof candidate === 'object') {
    return String(candidate.text || candidate.content || candidate.value || '').trim();
  }
  return String(candidate).trim();
};

const extractTranslationContent = (payload: any): string => {
  if (!payload) return '';
  const candidates = [
    payload?.message?.content,
    payload?.response,
    payload?.result?.content,
    payload?.output?.text,
    payload?.choices?.[0]?.message?.content,
    payload?.choices?.[0]?.text,
    payload?.text,
  ];
  for (const candidate of candidates) {
    const text = candidateToText(candidate);
    if (text) return text;
  }
  return '';
};

const getTranslationModelName = () =>
  process.env.OLLAMA_TRANSLATION_MODEL ||
  process.env.OLLAMA_MODEL ||
  STRICT_OLLAMA_MODEL;
const normalizeOllamaGenerateUrl = (raw: string): string => {
  const base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/api\/generate$/i.test(base)) return base;
  if (/\/api$/i.test(base)) return `${base}/generate`;
  return `${base}/api/generate`;
};

const buildGeneratePrompt = (systemPrompt: string, text: string): string => {
  return `${systemPrompt}\n\nINPUT:\n${text}\n\nOUTPUT:`;
};

const requestOllamaGenerate = async (
  baseUrl: string,
  model: string,
  prompt: string,
  estimatedPredict: number,
  timeoutMs: number,
): Promise<string> => {
  const generateUrl = normalizeOllamaGenerateUrl(baseUrl);
  if (!generateUrl) return '';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(generateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream: false,
        model,
        prompt,
        options: { temperature: TRANSLATION_TEMPERATURE, top_p: TRANSLATION_TOP_P, num_predict: estimatedPredict },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return '';
    }
    const data = await response.json().catch(() => null);
    return extractTranslationContent(data);
  } catch {
    return '';
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Detect the primary language of the input text
 * Uses character ratio to determine dominant language
 */
export function detectLanguage(text: string): LanguageCode {
  return detectSharedLanguage(text);
}

/**
 * Get language name for prompts
 */
export function getLanguageName(code: LanguageCode): string {
  const names: Record<LanguageCode, string> = {
    ja: 'Japanese',
    en: 'English',
    unknown: 'English',
  };
  return names[code];
}

export async function simpleTranslate(
  text: string,
  targetLanguage: 'ja' | 'en',
): Promise<string> {
  if (!text || text.trim().length === 0) {
    return text;
  }

  const sourceTextRaw = String(text || '').trim();
  const { body: sourceBody, footer: sourceFooter } = splitSourceFooter(sourceTextRaw);
  const body = String(sourceBody || sourceTextRaw).trim();
  if (!body) return sourceTextRaw;

  const targetLangName = targetLanguage === 'ja' ? 'Japanese' : 'English';
  const sourceDetected = detectLanguage(stripCitationLines(body));
  const normalizeComparable = (value: string): string =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const japaneseRatioIn = (value: string): number => {
    const s = stripCitationLines(String(value || ''));
    const total = s.replace(/\s/g, '').length;
    if (!total) return 0;
    const ja = (s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    return ja / total;
  };
  const isLikelyPartial = (value: string): boolean => {
    const out = String(value || '').trim();
    if (!out) return true;
    if (body.length < 240) return false;
    return out.length < Math.floor(body.length * 0.38);
  };
  const isLikelyUntranslated = (value: string): boolean => {
    const out = String(value || '').trim();
    if (!out) return true;
    if (normalizeComparable(out) === normalizeComparable(body)) return true;
    const outJaRatio = japaneseRatioIn(out);
    if (targetLanguage === 'ja' && sourceDetected === 'en' && outJaRatio < 0.18) return true;
    return false;
  };
  const renderFinal = (translatedBody: string): string => {
    const cleanedBody = sanitizeTranslationOutput(String(translatedBody || '').trim());
    const footer = String(sourceFooter || '').trim();
    if (!footer) return cleanedBody;
    return [cleanedBody, footer].filter(Boolean).join('\n\n');
  };

  if (TRANSLATION_OPTIMIZED_PATH_ENABLED) {
    const cacheKey = buildTranslationCacheKey({
      body,
      sourceLanguage: sourceDetected,
      targetLanguage,
      model: PRIMARY_LLM_MODEL,
      promptVersion: TRANSLATION_PROMPT_VERSION,
    });
    const cached = getCachedTranslation(cacheKey);
    if (cached) {
      recordRagDecision('translation_cache', {
        enabled: 1,
        hit: 1,
        source_language: sourceDetected,
        target_language: targetLanguage,
        model: PRIMARY_LLM_MODEL,
        prompt_version: TRANSLATION_PROMPT_VERSION,
      });
      return renderFinal(cached);
    }
    recordRagDecision('translation_cache', {
      enabled: 1,
      hit: 0,
      source_language: sourceDetected,
      target_language: targetLanguage,
      model: PRIMARY_LLM_MODEL,
      prompt_version: TRANSLATION_PROMPT_VERSION,
    });

    const optimizedSystemPrompt = [
      `You are a professional translator to ${targetLangName}.`,
      `Translate the text fully into ${targetLangName}.`,
      `The output MUST be entirely in ${targetLangName}.`,
      'Do not return the original language.',
      'Preserve numbering, lists, URLs, and formatting.',
      'Return only the translated text.',
    ].join(' ');

    const requestOptimized = async (
      temperature: number,
      maxTokens: number,
      suffix: string,
    ): Promise<string> => {
      const systemPrompt = suffix ? `${optimizedSystemPrompt} ${suffix}` : optimizedSystemPrompt;
      const translated = await requestTranslationCompletion({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: body },
        ],
        temperature,
        maxTokens,
        timeoutMs: TRANSLATION_REQUEST_TIMEOUT_MS,
        label: 'simple_translate_optimized',
      });
      return sanitizeTranslationOutput(String(translated || '').trim());
    };

    let translatedBody = '';
    try {
      translatedBody = await requestOptimized(0, Math.max(700, TRANSLATION_MAX_TOKENS), '');
      if (!translatedBody || isLikelyPartial(translatedBody) || isLikelyUntranslated(translatedBody)) {
        translatedBody = await requestOptimized(
          0.1,
          Math.max(700, TRANSLATION_MAX_TOKENS),
          `Translate this text into ${targetLangName}. Do not repeat the original text.`,
        );
      }
    } catch (error) {
      throw new Error((error as any)?.message || 'translation_request_failed');
    }

    if (translatedBody && translatedBody.trim().length > 0) {
      setCachedTranslation(cacheKey, translatedBody);
      return renderFinal(translatedBody);
    }
    throw new Error('translation_incomplete_or_untranslated');
  }

  const requestTranslation = async (
    promptSuffix: string,
    temperature: number,
    maxTokens: number,
  ): Promise<string> => {
    const systemPrompt = [
      `You are a professional translator to ${targetLangName}.`,
      `Translate the text fully into ${targetLangName}.`,
      'Return only the translated text.',
      'Do not explain.',
      'Do not summarize.',
      'Preserve list structure and numbering.',
      'Do not remove any procedural steps.',
      promptSuffix,
    ].filter(Boolean).join(' ');
    const response = await openaiClient.generate(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: body },
      ],
      {
        model: process.env.LLM_MODEL || 'openai/gpt-oss-20b',
        temperature,
        top_p: TRANSLATION_TOP_P,
        max_tokens: maxTokens,
        stream: false,
        timeout_ms: TRANSLATION_REQUEST_TIMEOUT_MS,
      },
    );
    return sanitizeTranslationOutput(String(response?.content || '').trim());
  };

  const primary = await requestTranslation('', TRANSLATION_TEMPERATURE, Math.max(800, TRANSLATION_MAX_TOKENS));
  if (primary && !isLikelyPartial(primary) && !isLikelyUntranslated(primary)) {
    return renderFinal(primary);
  }

  const retry = await requestTranslation(
    'Translate the complete text. Do not leave parts untranslated.',
    0.1,
    Math.max(1000, TRANSLATION_MAX_TOKENS),
  );
  if (retry && !isLikelyPartial(retry) && !isLikelyUntranslated(retry)) {
    return renderFinal(retry);
  }

  if (retry && retry.trim().length > 0) {
    return renderFinal(retry);
  }
  if (primary && primary.trim().length > 0) {
    return renderFinal(primary);
  }

  throw new Error('translation_incomplete_or_untranslated');
}

export type TranslationStatus = 'translated' | 'fallback_used' | 'error';
export type TranslationDirectionResult = {
  status: TranslationStatus;
  content: string;
  translation_status: TranslationStatus;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  outputLanguage: LanguageCode;
};

const toDirectionalLanguage = (lang: LanguageCode): LanguageCode => {
  if (lang === 'ja' || lang === 'en') return lang;
  return 'unknown';
};

const normalizeForDirectionCompare = (value: string): string =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const detectDirectionalLanguageByMix = (text: string): LanguageCode => {
  const body = stripCitationLines(String(text || ''));
  const latinChars = (body.match(/[A-Za-z]/g) || []).length;
  const japaneseChars = (body.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;

  if (latinChars >= 18 && latinChars >= japaneseChars * 1.2) return 'en';
  if (japaneseChars >= 12 && japaneseChars >= latinChars * 1.05) return 'ja';
  return 'unknown';
};

const detectDirectionalLanguage = (text: string): LanguageCode => {
  const byMix = detectDirectionalLanguageByMix(text);
  if (byMix !== 'unknown') return byMix;
  return toDirectionalLanguage(detectLanguage(stripCitationLines(text)));
};

const isTargetLanguageOutput = (text: string, targetLanguage: LanguageCode): boolean => {
  const body = stripCitationLines(String(text || ''));
  const detected = detectDirectionalLanguage(body);
  const latinChars = (body.match(/[A-Za-z]/g) || []).length;
  const japaneseChars = (body.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  if (targetLanguage === 'ja') {
    if (detected === 'ja') return true;
    return japaneseChars >= 10;
  }
  if (targetLanguage === 'en') {
    if (detected === 'en') return true;
    return latinChars >= 20;
  }
  return detected === targetLanguage;
};

/**
 * Translate text using Ollama LLM with retry logic and fallback
 */
export async function translateText(
  text: string,
  targetLang: LanguageCode,
  preserveCitations: boolean = false,
  maxRetries: number = 1,
  timeoutMs: number = DEFAULT_TRANSLATION_TIMEOUT_MS,
): Promise<string> {
  void maxRetries;
  const sourceText = String(text || '').trim();
  if (!sourceText) return sourceText;

  const targetLangName = getLanguageName(targetLang);
  const systemPrompt = buildTranslationSystemPrompt(targetLangName, preserveCitations);
  const effectiveTimeoutMs = clampTranslationTimeoutMs(timeoutMs);
  const baseMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Text:\n${sourceText}` },
  ];

  const requestTranslation = async (
    requestMessages: ChatMessage[],
    temperature: number,
    maxTokens: number,
    label: string,
  ): Promise<string> => {
    try {
      return await requestTranslationCompletion({
        messages: requestMessages,
        temperature,
        maxTokens,
        timeoutMs: effectiveTimeoutMs,
        label: `translate_${label}`,
      });
    } catch (error) {
      if (!isConnRefused(error)) {
        console.warn(
          `[translateText] non-stream translation failed (${label}):`,
          (error as any)?.message || error,
        );
      }
      return '';
    }
  };

  const primary = await requestTranslation(
    baseMessages,
    TRANSLATION_TEMPERATURE,
    TRANSLATION_MAX_TOKENS,
    'primary',
  );
  if (!primary || primary.trim().length < 5) {
    throw new Error('Empty translation result');
  }
  return primary;
}
function buildTranslationSystemPrompt(targetLangName: string, preserveCitations: boolean) {
  let systemPrompt = `You are a professional translator.

Translate the text into ${targetLangName}.

Rules:
- Translate the text fully into ${targetLangName}.
- Do not return the original language.
- Preserve bullet points and formatting.
- Do not add explanations.
- Do not summarize.
- Return only the translated text.`;

  if (preserveCitations) {
    systemPrompt += `
IMPORTANT: Keep all citation strings exactly as they are (document names, page numbers, file references like "Document: xxx", "Page: xxx", "出典:", "ページ:"). 
Do NOT translate citation markers or document names.`;
  }
  return systemPrompt;
}

function normalizeTranslationText(content: string): string {
  return String(content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/\[EN\]\s*/gi, '')
    .replace(/\[JA\]\s*/gi, '')
    .replace(/\[\/EN\]\s*/gi, '')
    .replace(/\[\/JA\]\s*/gi, '')
    .replace(/^(English|Japanese|Translation):\s*/gim, '')
    .replace(/- Source:.*$/gm, '')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/\n\n\n+/g, '\n\n')
    .trim();
}

const SOURCE_LINE_PATTERN = /^\s*SOURCE\s*:/i;
const BULLET_LINE_PATTERN = /^\s*[-*•]\s+/;
const NUMBERED_LINE_PATTERN = /^\s*\d+[\).]\s+/;
const META_PREAMBLE_PATTERNS = [
  /^\s*(we|i)\s+need\s+to\b/i,
  /^\s*the\s+text\s+(includes|contains)\b/i,
  /^\s*(translate|translation)\b/i,
  /^\s*(preserve|preserving)\s+(citations?|citation markers?)\b/i,
  /^\s*(output|return)\s+only\b/i,
  /^\s*so\s+we\b/i,
  /^\s*must\s+keep\b/i,
  /^\s*here(?:'s| is)\s+(the\s+)?translation\b/i,
  /^\s*then\s+list\s*[:：]?\s*$/i,
  /^\s*the\s+following\s+instructions?\s*[:：]?\s*$/i,
  /^\s*but\s+maybe\b/i,
  /^\s*wait\s+numbering\b/i,
  /^\s*the\s+original\s+had\b/i,
  /^\s*so\s+keep\b/i,
  /^\s*(analysis|reasoning|thought process)\s*[:\-]/i,
];
const REASONING_NOISE_PATTERN = /\b(?:then\s+list|but\s+maybe|wait\s+numbering|the\s+original\s+had|so\s+keep|the\s+following\s+instructions?)\b/i;
const SO_QUOTED_PATTERN = /\bso\s*:\s*["'“”『「](.+?)["'“”』」]/i;

const isLikelyMetaLine = (line: string): boolean => {
  const value = String(line || '').trim();
  if (!value) return false;
  if (SOURCE_LINE_PATTERN.test(value)) return false;
  if (BULLET_LINE_PATTERN.test(value) || NUMBERED_LINE_PATTERN.test(value)) return false;
  return META_PREAMBLE_PATTERNS.some((p) => p.test(value));
};

function sanitizeTranslationOutput(content: string): string {
  const normalized = normalizeTranslationText(content);
  if (!normalized) return '';

  const extractMappedTranslation = (text: string): string => {
    const lines = String(text || '').split('\n');
    const outputLines: string[] = [];
    let mappingCount = 0;
    const unquote = (value: string): string =>
      String(value || '')
        .trim()
        .replace(/^["'“”『「]+/, '')
        .replace(/["'“”』」]+$/, '')
        .trim();
    const withPrefixIfNeeded = (value: string, prefix: string): string => {
      const candidate = String(value || '').trim();
      if (!candidate) return '';
      if (!prefix) return candidate;
      if (/^\d+\s*[\).]/.test(candidate) || /^[①-⑳⑴-⒇⓪⓫-⓴]/.test(candidate) || /^[\-*•]/.test(candidate)) {
        return candidate;
      }
      return `${prefix}${candidate}`.trim();
    };
    const extractBestQuotedFragment = (lineValue: string, prefix: string): string => {
      const matches = Array.from(String(lineValue || '').matchAll(/["'“”『「](.+?)["'“”』」]/g))
        .map((match) => unquote(match[1]))
        .filter(Boolean);
      if (!matches.length) return '';

      let selected = matches[matches.length - 1];
      for (let i = matches.length - 1; i >= 0; i -= 1) {
        const candidate = matches[i];
        if (/[A-Za-z\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(candidate)) {
          selected = candidate;
          break;
        }
      }
      const cleaned = String(selected || '')
        .replace(/^[-–—:]\s*/, '')
        .replace(/`+/g, '')
        .trim();
      return withPrefixIfNeeded(cleaned, prefix);
    };

    for (const rawLine of lines) {
      const line = String(rawLine || '');
      const lineNoTicks = line.replace(/`+/g, '');
      const trimmed = lineNoTicks.trim();
      if (!trimmed) {
        outputLines.push('');
        continue;
      }
      const prefix = String(trimmed.match(/^(\d+\s*[\).]?\s*)/)?.[1] || '');

      const numberedQuotedMatch = trimmed.match(
        /^(\d+\s*[\).]?\s*)?["'“”『「].*?["'“”』」]\s*(?:=>|->|→|⇒)\s*(.+)$/,
      );
      if (numberedQuotedMatch) {
        const prefix = String(numberedQuotedMatch[1] || '');
        const rhs = unquote(numberedQuotedMatch[2]);
        if (rhs) {
          outputLines.push(`${prefix}${rhs}`.trim());
          mappingCount += 1;
          continue;
        }
      }

      const soQuotedMatch = trimmed.match(SO_QUOTED_PATTERN);
      if (soQuotedMatch) {
        const rhs = withPrefixIfNeeded(unquote(soQuotedMatch[1]), prefix);
        if (rhs) {
          outputLines.push(rhs);
          mappingCount += 1;
          continue;
        }
      }

      if (REASONING_NOISE_PATTERN.test(trimmed) || isLikelyMetaLine(trimmed)) {
        const quoted = extractBestQuotedFragment(trimmed, prefix);
        if (quoted) {
          outputLines.push(quoted);
          mappingCount += 1;
        }
        continue;
      }

      const withoutCommentary = trimmed
        .replace(/\bwait\s+numbering\b[\s\S]*$/i, '')
        .replace(/\bthe\s+original\s+had\b[\s\S]*$/i, '')
        .replace(/\bso\s+keep\b[\s\S]*$/i, '')
        .trim();
      if (!withoutCommentary) {
        continue;
      }

      const arrowParts = trimmed.split(/\s*(?:=>|->|→|⇒)\s*/);
      if (arrowParts.length >= 2) {
        const rhs = unquote(arrowParts.slice(1).join(' '));
        if (rhs) {
          outputLines.push(rhs);
          mappingCount += 1;
          continue;
        }
      }

      outputLines.push(withoutCommentary);
    }

    if (mappingCount >= 2) {
      return outputLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    return text;
  };

  const normalizedMapped = extractMappedTranslation(normalized);
  const normalizedInput = normalizedMapped || normalized;

  const lines = normalizedInput.split('\n');
  let startIndex = 0;
  while (startIndex < lines.length) {
    const line = String(lines[startIndex] || '').trim();
    if (!line) {
      startIndex += 1;
      continue;
    }
    if (isLikelyMetaLine(line)) {
      startIndex += 1;
      continue;
    }
    break;
  }

  const trimmedHead = lines.slice(startIndex).join('\n').trim() || normalizedInput;
  const filtered = trimmedHead
    .split('\n')
    .filter((line) => {
      const v = String(line || '').trim();
      if (!v) return true;
      if (SOURCE_LINE_PATTERN.test(v)) return true;
      if (REASONING_NOISE_PATTERN.test(v)) return false;
      return !isLikelyMetaLine(v);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return filtered || trimmedHead || normalizedInput;
}

function stripCitationLines(text: string): string {
  const lines = String(text || '').split('\n');
  return lines.filter((line) => {
    const s = line.trim();
    if (!s) return true;
    if (/^(sources?|出典)\s*:/i.test(s)) return false;
    if (
      /^\d+\.\s/.test(s) &&
      (
        /(?:^|\s)(?:page|pages|document|documents|matched query|出典|ページ)\b/i.test(s) ||
        /\.pdf\b|\.docx?\b|\.xlsx?\b|\.txt\b/i.test(s)
      )
    ) {
      return false;
    }
    if (/\.pdf\b|\.docx?\b|\.xlsx?\b|\.txt\b/i.test(s)) return false;
    return true;
  }).join('\n');
}

function splitSourceFooter(text: string): { body: string; footer: string } {
  const lines = String(text || '').split('\n');
  if (!lines.length) return { body: '', footer: '' };

  let sourceStart = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = String(lines[i] || '').trim();
    if (!line) continue;
    if (/^SOURCE\s*:/i.test(line) || /^SOURCES\s*:/i.test(line)) {
      sourceStart = i;
      break;
    }
    if (line.length > 0) break;
  }

  if (sourceStart < 0) {
    return { body: String(text || '').trim(), footer: '' };
  }

  const body = lines.slice(0, sourceStart).join('\n').trim();
  const footer = lines.slice(sourceStart).join('\n').trim();
  return { body, footer };
}

function japaneseRatio(text: string): number {
  const body = stripCitationLines(text);
  const total = body.replace(/\s/g, '').length;
  if (!total) return 1;
  const ja = (body.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  return ja / total;
}

async function refineToJapaneseIfNeeded(text: string, preserveCitations: boolean): Promise<string> {
  const cleaned = sanitizeTranslationOutput(text);
  if (japaneseRatio(cleaned) >= 0.62) return cleaned;

  const systemPrompt = `Rewrite into natural Japanese only.
Keep policy meaning, numbers, and bullet structure exactly.
Do not leave English sentence fragments.`
    + (preserveCitations ? ` Keep citation labels and file names unchanged.` : '');

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: cleaned },
    ];
    const rewritten = await requestTranslationCompletion({
      messages,
      temperature: 0.0,
      maxTokens: TRANSLATION_MAX_TOKENS,
      timeoutMs: TRANSLATION_REFINE_TIMEOUT_MS,
      label: 'refine_japanese',
    });
    return japaneseRatio(rewritten) >= japaneseRatio(cleaned) ? rewritten : cleaned;
  } catch {
    return cleaned;
  }
}

export async function finalizeTranslationForTarget(
  text: string,
  targetLang: LanguageCode,
  preserveCitations: boolean = false,
): Promise<string> {
  let out = sanitizeTranslationOutput(text);
  if (targetLang === 'ja') {
    out = await refineToJapaneseIfNeeded(out, preserveCitations);
    // Hard retry once if still not Japanese enough.
    const detected = detectLanguage(stripCitationLines(out));
    if (detected !== 'ja') {
      const retried = await translateText(out, 'ja', preserveCitations, 1);
      let normalizedRetry = sanitizeTranslationOutput(retried);
      normalizedRetry = await refineToJapaneseIfNeeded(normalizedRetry, preserveCitations);
      if (detectLanguage(stripCitationLines(normalizedRetry)) === 'ja') {
        out = normalizedRetry;
      }
    }
  }
  return out;
}

export async function* translateTextStream(
  text: string,
  targetLang: LanguageCode,
  preserveCitations: boolean = false,
): AsyncGenerator<string, void, void> {
  const translated = await translateText(text, targetLang, preserveCitations, 0, TRANSLATION_REQUEST_TIMEOUT_MS);
  yield translated;
}

/**
 * Create a mock translation when Ollama is unavailable
 */
function createMockTranslation(text: string, targetLang: LanguageCode): string {
  // For development/testing, create a more realistic mock translation
  // that actually changes the content based on target language
  
  if (targetLang === 'ja') {
    // Simple mock Japanese translation
    // In production, this would use a real translation API
    const translations: { [key: string]: string } = {
      'hello': 'こんにちは',
      'thank you': 'ありがとう',
      'yes': 'はい',
      'no': 'いいえ',
      'please': 'お願いします',
      'question': '質問',
      'answer': '答え',
      'help': '助け',
      'information': '情報',
      'document': 'ドキュメント',
      'policy': 'ポリシー',
      'company': 'サードウェーブ',
      'employee': '従業員',
      'work': '仕事',
      'leave': '休暇',
      'salary': '給与',
      'benefits': '福利厚生',
      'the': 'その',
      'is': 'です',
      'are': 'です',
      'according': 'によると',
      'based': 'に基づいて',
      'can': 'ことができます',
      'should': 'べきです',
    };
    
    let translated = text.toLowerCase();
    // Apply simple word replacements
    for (const [en, ja] of Object.entries(translations)) {
      translated = translated.replace(new RegExp(`\\b${en}\\b`, 'gi'), ja);
    }
    
    // If translation didn't change much, add a prefix to make it visually different
    if (translated === text.toLowerCase()) {
      return `【日本語訳】\n${text}\n\n（自動翻訳: ${text.substring(0, 50)}...）`;
    }
    
    return translated;
  } else if (targetLang === 'en') {
    // Mock English translation
    // In a real scenario, this would translate FROM Japanese TO English
    const translations: { [key: string]: string } = {
      'こんにちは': 'hello',
      'ありがとう': 'thank you',
      'はい': 'yes',
      'いいえ': 'no',
      'お願い': 'please',
      '質問': 'question',
      '答え': 'answer',
      '助け': 'help',
      '情報': 'information',
      'ドキュメント': 'document',
      'ポリシー': 'policy',
      '会社': 'Thirdwave',
      '従業員': 'employee',
      '仕事': 'work',
      '休暇': 'leave',
      '給与': 'salary',
      '福利厚生': 'benefits',
      'です': 'is',
      'ます': 'does',
      'ました': 'was',
      'います': 'have',
      'あります': 'exists',
      'べき': 'should',
      'できます': 'can',
      'なければならない': 'must',
      'について': 'regarding',
      'における': 'in',
      'により': 'by',
      'ために': 'for',
      'として': 'as',
      'までに': 'by',
      'にとって': 'for',
    };
    
    let translated = text;
    // Apply simple word replacements for Japanese words
    for (const [ja, en] of Object.entries(translations)) {
      translated = translated.replace(new RegExp(ja, 'g'), en);
    }
    
    // If the text contains Japanese characters and we did replacements
    if (text.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/)) {
      // This is Japanese text being translated to English
      // Add some structure to make it look like a translation
      if (translated === text) {
        // No words found in dictionary, create a simple English representation
        return `[English Translation - Auto Generated]\n${text}`;
      }
      return translated;
    } else {
      // This is English text (shouldn't happen normally)
      // Just return with a marker
      return `[English Version]\n${text}`;
    }
  } else {
    // Fallback for unknown target language
    return `[${targetLang.toUpperCase()} Translation]\n${text}`;
  }
}

/**
 * Translate query to Japanese for RAG retrieval
 */
export async function translateQueryToJapanese(query: string): Promise<{ 
  originalQuery: string;
  translatedQuery: string;
  sourceLanguage: LanguageCode;
}> {
  const sourceLanguage = detectLanguage(query);
  
  if (sourceLanguage === 'ja') {
    return {
      originalQuery: query,
      translatedQuery: query,
      sourceLanguage: 'ja',
    };
  }

  const translatedQuery = await translateText(query, 'ja');
  
  return {
    originalQuery: query,
    translatedQuery,
    sourceLanguage,
  };
}

/**
 * Translate content on-demand (when user clicks dual response button)
 * This replaces the old createDualLanguageResponse for lazy translation
 */
export async function translateContentOnDemand(
  content: string,
  currentLanguage: LanguageCode,
  targetLanguage: LanguageCode
): Promise<string> {
  if (currentLanguage === targetLanguage) {
    return content;
  }

  // On-demand UI translation should be fast and deterministic:
  // avoid long retry chains; caller can retry via button.
  const ON_DEMAND_TIMEOUT_MS = Math.max(
    25000,
    Math.min(60000, Number(process.env.TRANSLATE_ON_DEMAND_TIMEOUT_MS || 45000)),
  );
  const sourceTextRaw = String(content || '').trim();
  const { body: sourceBody, footer: sourceFooter } = splitSourceFooter(sourceTextRaw);
  const sourceText = sourceBody || sourceTextRaw;
  if (!sourceText) return sourceText;
  const normalizeForCompare = (v: string) =>
    String(v || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const looksValidForTarget = (translated: string): boolean => {
    const out = String(translated || '').trim();
    if (!out) return false;
    if (normalizeForCompare(out) === normalizeForCompare(sourceText)) return false;

    const body = stripCitationLines(out);
    const jaRatio = japaneseRatio(body);
    if (targetLanguage === 'ja') {
      if (!japanesePattern.test(body)) return false;
      return jaRatio >= TRANSLATION_MIN_JA_RATIO;
    }
    if (targetLanguage === 'en') {
      return jaRatio <= TRANSLATION_MAX_JA_RATIO_FOR_EN;
    }
    return true;
  };

  const renderWithFooter = (translatedBody: string): string => {
    const body = String(translatedBody || '').trim();
    const footer = String(sourceFooter || '').trim();
    if (!footer) return body;
    return [body, footer].filter(Boolean).join('\n\n');
  };

  const primaryBody = sanitizeTranslationOutput(
    await translateText(sourceText, targetLanguage, false, 0, ON_DEMAND_TIMEOUT_MS),
  );
  const primary = renderWithFooter(primaryBody);
  if (looksValidForTarget(primary)) {
    return primary;
  }

  let recovery = '';
  if (TRANSLATE_ON_DEMAND_SECOND_PASS) {
    // Optional recovery path for models that intermittently return empty/unchanged content.
    const retryTimeout = Math.max(6000, Math.min(45000, ON_DEMAND_TIMEOUT_MS + 6000));
    const recoveryBody = sanitizeTranslationOutput(
      await translateText(sourceText, targetLanguage, false, 0, retryTimeout),
    );
    recovery = renderWithFooter(recoveryBody);
    if (looksValidForTarget(recovery)) {
      return recovery;
    }
  }

  if (!TRANSLATE_ON_DEMAND_SKIP_FINALIZE) {
    const finalized = await finalizeTranslationForTarget(
      recovery || primary || sourceText,
      targetLanguage,
      true,
    );
    const finalText = sanitizeTranslationOutput(finalized);
    if (looksValidForTarget(finalText)) {
      return finalText;
    }
  }

  if (TRANSLATE_ON_DEMAND_ALLOW_LOCAL_MOCK) {
    const localFallback = sanitizeTranslationOutput(createMockTranslation(sourceText, targetLanguage));
    if (looksValidForTarget(localFallback)) {
      console.warn(
        `[translateContentOnDemand] using local fallback translation (target=${targetLanguage}, source_len=${sourceText.length})`,
      );
      return localFallback;
    }
  }

  console.warn(
    `TRANSLATION_FALLBACK_USED target=${targetLanguage} source_len=${sourceText.length} mode=translate_on_demand`,
  );
  if (TRANSLATE_ON_DEMAND_FAIL_OPEN) {
    const preface = targetLanguage === 'ja'
      ? '【翻訳を取得できなかったため、原文を表示しています】'
      : '[Translation unavailable; showing original text]';
    return `${preface}\n\n${sourceTextRaw}`.trim();
  }
  return sourceTextRaw;
}

const validateDirectionalTranslation = (
  sourceText: string,
  translatedText: string,
  targetLanguage: LanguageCode,
): boolean => {
  const source = String(sourceText || '').trim();
  const translated = String(translatedText || '').trim();
  if (!translated) return false;
  if (normalizeForDirectionCompare(source) === normalizeForDirectionCompare(translated)) return false;

  const body = stripCitationLines(translated);
  const jaRatio = japaneseRatio(body);
  if (targetLanguage === 'en') {
    const latinChars = (body.match(/[A-Za-z]/g) || []).length;
    if (detectDirectionalLanguage(body) === 'en') return true;
    const japaneseChars = (body.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    return latinChars >= 16 && (jaRatio <= 0.55 || latinChars >= japaneseChars * 0.75);
  }
  if (targetLanguage === 'ja') {
    const japaneseChars = (body.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    if (detectDirectionalLanguage(body) === 'ja') return true;
    const latinChars = (body.match(/[A-Za-z]/g) || []).length;
    return japaneseChars >= 12 && (jaRatio >= 0.30 || japaneseChars >= latinChars * 0.75);
  }
  return isTargetLanguageOutput(translated, targetLanguage);
};

const TRANSLATION_ARTIFACT_PATTERN = /\b(?:then\s+list|but\s+maybe|wait\s+numbering|the\s+original\s+had|actually\s+the\s+original\s+numbering|so\s*:\s*["'“”『「])/i;
const TRANSLATION_METADATA_LINE_PATTERN =
  /(https?:\/\/|www\.|table_\d+|twave\.co\.jp|\.pdf\b|\.docx?\b|\.xlsx?\b|\.txt\b|\bID\s*\d+\b|\d{4}\/\d{2}\/\d{2}|\bQ\s*&\s*A\b)/i;
const TRANSLATION_METADATA_SYMBOL_PATTERN = /[|~_=\[\]{}<>]/g;

const isLikelyMetadataLine = (line: string): boolean => {
  const value = String(line || '').trim();
  if (!value) return false;
  if (SOURCE_LINE_PATTERN.test(value) || /^(sources?|出典)\s*:/i.test(value)) return false;

  const hasMetadataPattern = TRANSLATION_METADATA_LINE_PATTERN.test(value);
  const symbolCount = (value.match(TRANSLATION_METADATA_SYMBOL_PATTERN) || []).length;
  const jaEnChars = (value.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fffA-Za-z]/g) || []).length;
  const symbolDensity = value.length > 0 ? symbolCount / value.length : 0;
  const mostlyIdentifiers = jaEnChars > 0 && jaEnChars <= 10 && symbolDensity >= 0.12;

  return hasMetadataPattern || mostlyIdentifiers;
};

const extractMeaningfulTranslationLines = (text: string): string[] => {
  return String(text || '')
    .split('\n')
    .map((line) => String(line || '').trim())
    .filter((line) => {
      if (!line) return false;
      if (SOURCE_LINE_PATTERN.test(line) || /^(sources?|出典)\s*:/i.test(line)) return false;
      if (isLikelyMetadataLine(line)) return false;
      return true;
    });
};

const hasSufficientTranslationCoverage = (
  sourceText: string,
  translatedText: string,
  targetLanguage: LanguageCode,
): boolean => {
  const sourceLines = extractMeaningfulTranslationLines(sourceText);
  const outputLines = extractMeaningfulTranslationLines(translatedText);
  if (!sourceLines.length) return true;
  const lineCoverage = outputLines.length / sourceLines.length;

  const sourceChars = stripCitationLines(sourceText).replace(/\s/g, '').length;
  const outputChars = stripCitationLines(translatedText).replace(/\s/g, '').length;
  const charCoverage = sourceChars > 0 ? outputChars / sourceChars : 1;
  const hasArtifacts = TRANSLATION_ARTIFACT_PATTERN.test(translatedText);
  const outputJaRatio = japaneseRatio(translatedText);

  const minLineCoverage = sourceLines.length >= 5 ? 0.72 : 0.6;
  const minCharCoverage = targetLanguage === 'en' ? 0.35 : 0.45;
  const langCoverageOk =
    targetLanguage === 'en'
      ? outputJaRatio <= 0.48
      : outputJaRatio >= 0.22;
  return lineCoverage >= minLineCoverage && charCoverage >= minCharCoverage && langCoverageOk && !hasArtifacts;
};

const normalizeForTranslationCompare = (text: string): string =>
  stripCitationLines(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const countLatinChars = (text: string): number =>
  (String(text || '').match(/[A-Za-z]/g) || []).length;

const countJapaneseChars = (text: string): number =>
  (String(text || '').match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;

const isLikelyUntranslatedOutput = (
  sourceText: string,
  translatedText: string,
  targetLanguage: LanguageCode,
): boolean => {
  const sourceComparable = normalizeForTranslationCompare(sourceText);
  const outputComparable = normalizeForTranslationCompare(translatedText);
  if (!outputComparable) return true;
  if (sourceComparable && sourceComparable === outputComparable) return true;

  const sourceBody = stripCitationLines(sourceText);
  const outputBody = stripCitationLines(translatedText);
  const sourceLatin = countLatinChars(sourceBody);
  const outputLatin = countLatinChars(outputBody);
  const sourceJapanese = countJapaneseChars(sourceBody);
  const outputJapanese = countJapaneseChars(outputBody);

  if (targetLanguage === 'ja') {
    const mostlyStillEnglish = sourceLatin >= 40 && outputLatin >= sourceLatin * 0.7;
    const lacksJapaneseShift = outputJapanese <= Math.max(8, Math.floor(outputBody.length * 0.06));
    return mostlyStillEnglish && lacksJapaneseShift;
  }

  if (targetLanguage === 'en') {
    const mostlyStillJapanese = sourceJapanese >= 20 && outputJapanese >= sourceJapanese * 0.7;
    const lacksEnglishShift = outputLatin < Math.max(18, Math.floor(outputBody.length * 0.08));
    return mostlyStillJapanese && lacksEnglishShift;
  }

  return false;
};

export async function translateContentOnDemandWithStatus(
  content: string,
  currentLanguage: LanguageCode,
  targetLanguage: LanguageCode,
): Promise<TranslationDirectionResult> {
  const sourceTextRaw = String(content || '').trim();
  if (!sourceTextRaw) {
    return {
      status: 'error',
      content: '',
      translation_status: 'error',
      sourceLanguage: 'unknown',
      targetLanguage,
      outputLanguage: 'unknown',
    };
  }

  const { body: sourceBody, footer: sourceFooter } = splitSourceFooter(sourceTextRaw);
  const sourceText = String(sourceBody || sourceTextRaw).trim();
  const detectedSourceLang = detectDirectionalLanguage(sourceText);
  const declaredSourceLang = toDirectionalLanguage(currentLanguage);
  const effectiveSourceLang = detectedSourceLang !== 'unknown' ? detectedSourceLang : declaredSourceLang;
  const renderWithFooter = (translatedBody: string): string => {
    const body = String(translatedBody || '').trim();
    const footer = String(sourceFooter || '').trim();
    if (!footer) return body;
    return [body, footer].filter(Boolean).join('\n\n');
  };

  if (
    (targetLanguage === 'ja' || targetLanguage === 'en') &&
    effectiveSourceLang === targetLanguage &&
    isTargetLanguageOutput(sourceText, targetLanguage)
  ) {
    return {
      status: 'translated',
      content: sourceTextRaw,
      translation_status: 'translated',
      sourceLanguage: effectiveSourceLang,
      targetLanguage,
      outputLanguage: effectiveSourceLang,
    };
  }

  const translationTimeoutMs = TRANSLATION_REQUEST_TIMEOUT_MS;
  const tryReturnTranslation = (translatedBody: string): TranslationDirectionResult | null => {
    const body = sanitizeTranslationOutput(translatedBody);
    if (!body) return null;
    if (isLikelyUntranslatedOutput(sourceText, body, targetLanguage)) return null;
    const rendered = renderWithFooter(body);
    return {
      status: 'translated',
      content: rendered,
      translation_status: 'translated',
      sourceLanguage: effectiveSourceLang,
      targetLanguage,
      outputLanguage: detectDirectionalLanguage(body),
    };
  };

  try {
    const translatedBody = await translateText(sourceText, targetLanguage, false, 0, translationTimeoutMs);
    if (!translatedBody || translatedBody.trim().length < 5) {
      throw new Error('Empty translation result');
    }
    const primaryBody = sanitizeTranslationOutput(translatedBody);
    const primaryResult = tryReturnTranslation(primaryBody);
    if (primaryResult) return primaryResult;
  } catch (error) {
    console.warn('[translateContentOnDemandWithStatus] primary translation failed:', (error as any)?.message || error);
  }

  const fallbackContent = targetLanguage === 'ja'
    ? `【翻訳を取得できなかったため、原文を表示しています】\n\n${sourceTextRaw}`
    : `[Translation unavailable; showing original text]\n\n${sourceTextRaw}`;
  console.warn(
    `TRANSLATION_FALLBACK_USED target=${targetLanguage} source_len=${sourceText.length} mode=direction_enforced`,
  );
  return {
    status: 'fallback_used',
    content: fallbackContent,
    translation_status: 'fallback_used',
    sourceLanguage: effectiveSourceLang,
    targetLanguage,
    outputLanguage: detectDirectionalLanguage(sourceTextRaw),
  };
}

/**
 * Format single-language output for storage
 * Returns a structured JSON that can be parsed by the frontend
 * The translation will happen on-demand when user clicks the dual response button
 * 
 * @param content The response content in the user's language
 * @param language The language of the content (user's language)
 */
export function formatSingleLanguageOutput(
  content: string,
  language: LanguageCode,
  generationMeta?: {
    generation_status?: string;
    used_fallback?: boolean;
  },
): string {
  const output = {
    dualLanguage: false,
    content: content,
    language: language,
    translationPending: true, // Flag for frontend: translation available on-demand
    generation_status: String(generationMeta?.generation_status || 'ok'),
    used_fallback: Boolean(generationMeta?.used_fallback),
    formattedAt: new Date().toISOString(),
    contentLength: content.length,
  };
  
  console.log(`[formatSingleLanguageOutput] Creating JSON with:`);
  console.log(`  - language: ${language}`);
  console.log(`  - content length: ${content.length}`);
  console.log(`  - translationPending: true`);
  console.log(`  - generation_status: ${output.generation_status}`);
  console.log(`  - used_fallback: ${output.used_fallback}`);
  
  // Use pretty-print (2-space indent) for better readability
  const jsonString = JSON.stringify(output, null, 2);
  const result = `<!--SINGLE_LANG_START-->\n${jsonString}\n<!--SINGLE_LANG_END-->`;
  
  console.log(`[formatSingleLanguageOutput] Final output length: ${result.length}`);
  
  return result;
}

/**
 * Format dual-language output for storage
 * Returns a structured JSON that can be parsed by the frontend
 * DEPRECATED: This is now only used for backwards compatibility and on-demand translation responses
 */
export function formatDualLanguageOutput(
  japaneseAnswer: string,
  translatedAnswer: string,
  targetLanguage: LanguageCode
): string {
  const output = {
    dualLanguage: true,
    japanese: japaneseAnswer,
    translated: translatedAnswer,
    targetLanguage,
    formattedAt: new Date().toISOString(),
    japaneseContentLength: japaneseAnswer.length,
    translatedContentLength: translatedAnswer.length,
  };
  
  console.log(`[formatDualLanguageOutput] Creating JSON with:`);
  console.log(`  - targetLanguage: ${targetLanguage}`);
  console.log(`  - japanese length: ${japaneseAnswer.length}`);
  console.log(`  - translated length: ${translatedAnswer.length}`);
  
  // Use pretty-print (2-space indent) for better readability
  const jsonString = JSON.stringify(output, null, 2);
  const result = `<!--DUAL_LANG_START-->\n${jsonString}\n<!--DUAL_LANG_END-->`;
  
  console.log(`[formatDualLanguageOutput] Final output length: ${result.length}`);
  
  return result;
}

/**
 * Parse output from stored content (handles both single and dual language formats)
 */
export function parseDualLanguageOutput(content: string): {
  isDualLanguage: boolean;
  japanese?: string;
  translated?: string;
  targetLanguage?: LanguageCode;
  singleContent?: string;
  language?: LanguageCode;
  translationPending?: boolean;
  rawContent: string;
} {
  // First try to parse single-language format
  const singleLangMatch = content.match(/<!--SINGLE_LANG_START-->(.+?)<!--SINGLE_LANG_END-->/s);
  if (singleLangMatch) {
    try {
      const parsed = JSON.parse(singleLangMatch[1]);
      return {
        isDualLanguage: false,
        singleContent: parsed.content,
        language: parsed.language,
        translationPending: parsed.translationPending,
        rawContent: content,
      };
    } catch {
      return { isDualLanguage: false, rawContent: content };
    }
  }
  
  // Then try dual-language format (backwards compatibility)
  const dualLangMatch = content.match(/<!--DUAL_LANG_START-->(.+?)<!--DUAL_LANG_END-->/s);
  
  if (dualLangMatch) {
    try {
      const parsed = JSON.parse(dualLangMatch[1]);
      return {
        isDualLanguage: true,
        japanese: parsed.japanese,
        translated: parsed.translated,
        targetLanguage: parsed.targetLanguage,
        rawContent: content,
      };
    } catch {
      return { isDualLanguage: false, rawContent: content };
    }
  }
  
  return { isDualLanguage: false, rawContent: content };
}
