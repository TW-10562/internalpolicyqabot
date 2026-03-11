import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import {
  Send, Bot, User, Globe, Languages, Copy, ThumbsUp, ThumbsDown,
  RefreshCw, Check, Plus, Trash2, StopCircle,
  Download
} from 'lucide-react';
import { Message } from '../../types';
import { useLang } from '../../context/LanguageContext';
import { listTask, listTaskOutput, addTask, deleteTaskOutput, sendFeedbackToCache } from '../../api/task';
import { getToken } from '../../api/auth';
import { listTriageAssignees } from '../../api/triage';
import ChatExport from './ChatExport';
import { ConfirmDialog } from '../ui/FeedbackComponents';
import { useToast } from '../../context/ToastContext';
import PDFPreview, { SourceCitation } from './PDFPreview';

interface ChatInterfaceProps {
  focusSignal?: number;
  onUserTyping?: (typing: boolean) => void;
}

interface ChatTask {
  id: string;
  title: string;
  createdAt: string;
}

interface TaskOutput {
  id: number;
  metadata: string;
  content: string;
  status: string;
  feedback?: { emoji?: string };
  sort: number;
}

type RagTraceStage = { name: string; ms: number };
type RagTraceRecent = {
  traceId: string;
  name: string;
  totalMs: number;
  ttftMs?: number;
  meta?: Record<string, any>;
  stages?: RagTraceStage[];
};
type RagKpiFallback = {
  totalMs?: number;
  ragMs?: number;
  llmMs?: number;
  retrievalMs?: number;
  titleMs?: number;
};

interface TriageDraft {
  messageId: string;
  taskOutputId?: number;
  assistantAnswer: string;
  userQuery: string;
}

const formatMs = (ms?: number) => {
  if (ms == null || !Number.isFinite(ms)) return '-';
  return `${(ms / 1000).toFixed(2)}s`;
};

const stageValue = (stages: RagTraceStage[] | undefined, name: string) =>
  stages?.find((s) => s.name === name)?.ms;
const stagePrefixSum = (stages: RagTraceStage[] | undefined, prefix: string) => {
  const vals = (stages || [])
    .filter((s) => String(s.name || '').startsWith(prefix))
    .map((s) => Number(s.ms || 0))
    .filter((n) => Number.isFinite(n));
  if (!vals.length) return undefined;
  return vals.reduce((a, b) => a + b, 0);
};
const TERMINAL_OUTPUT_STATUS = new Set(['FINISHED', 'FAILED', 'CANCEL']);
const TERMINAL_GENERATION_STATUS = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED OUT']);
const isTerminalBotMessage = (message?: Message): boolean => {
  if (!message || message.type !== 'bot') return false;
  const outputStatus = String(message.status || '').toUpperCase();
  const generationStatus = String(message.generationStatus || '').toUpperCase();
  return TERMINAL_OUTPUT_STATUS.has(outputStatus) || TERMINAL_GENERATION_STATUS.has(generationStatus);
};
const SMOOTH_FLUSH_MS = 120;
const SMOOTH_MIN_CHARS = 24;
const shouldSmoothFlush = (next: string, current: string, lastFlushAt: number) => {
  const now = Date.now();
  const deltaChars = Math.max(0, next.length - current.length);
  if (deltaChars <= 0) return false;
  if (deltaChars >= SMOOTH_MIN_CHARS) return true;
  if (/[.!?。！？\n]\s*$/.test(next)) return true;
  return now - lastFlushAt >= SMOOTH_FLUSH_MS;
};

const JA_CHAR_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

const detectDisplayLanguage = (text: string): 'ja' | 'en' => {
  const value = String(text || '');
  const nonSpaceChars = value.replace(/\s/g, '');
  if (!nonSpaceChars) return 'en';
  const japaneseChars = (nonSpaceChars.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  return japaneseChars / Math.max(nonSpaceChars.length, 1) >= 0.2 ? 'ja' : 'en';
};
const GREETING_PATTERNS = [
  /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening|how are you)[!. ]*$/i,
  /^(こんにちは|こんばんは|おはよう|やあ|もしもし)[!！。 ]*$/,
];
const ELONGATED_GREETING_PATTERNS = [
  /^(h+e+l*o+|h+i+|h+e+y+|y+o+|s+u+p+)[!. ]*$/i,
  /^(こ+ん+に+ち+は+|こ+ん+ば+ん+は+|お+は+よ+う+)[!！。 ]*$/,
];

const levenshteinDistance = (a: string, b: string): number => {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
};

const isNearEnglishGreeting = (query: string): boolean => {
  const cleaned = query
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ');
  if (!cleaned) return false;
  const tokens = cleaned.split(' ').filter(Boolean);
  if (!tokens.length || tokens.length > 2) return false;
  const baseGreetings = ['hi', 'hey', 'hello', 'yo', 'sup'];
  const normalizeToken = (s: string) => s.replace(/(.)\1+/g, '$1');
  return tokens.some((t) => {
    if (t.length > 12) return false;
    const normalized = normalizeToken(t);
    return baseGreetings.some((b) => {
      const threshold = b.length <= 3 ? 1 : 2;
      return (
        levenshteinDistance(t, b) <= threshold ||
        levenshteinDistance(normalized, b) <= 1
      );
    });
  });
};

const isGreetingOnlyQuery = (query: string): boolean => {
  const q = String(query || '').trim();
  if (!q || q.length > 40) return false;
  return (
    GREETING_PATTERNS.some((p) => p.test(q)) ||
    ELONGATED_GREETING_PATTERNS.some((p) => p.test(q)) ||
    isNearEnglishGreeting(q)
  );
};

const localGreetingReply = (query: string): string =>
  JA_CHAR_REGEX.test(String(query || ''))
    ? 'こんにちは。ご質問ありがとうございます。就業規則・福利厚生・通勤費など、社内制度について何でも聞いてください。'
    : 'Hello. Happy to help. Ask me anything about company policies, benefits, commuting expenses, leave, or HR rules.';

// Dual language output interface
interface DualLanguageContent {
  isDualLanguage: boolean;
  isSingleLanguage?: boolean;
  japanese?: string;
  translated?: string;
  targetLanguage?: string;
  content?: string;
  language?: 'ja' | 'en';
  translationPending?: boolean;
  rawContent: string;
}

function normalizeAiText(input: string): string {
  const text = String(input || '');
  if (!text) return '';

  let cleaned = text.replace(/<br\s*\/?>/gi, '\n');
  cleaned = cleaned.replace(/<\/?[^>]+>/g, '');
  cleaned = cleaned
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = cleaned.split('\n');
  const normalizedLines: string[] = [];
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) {
      normalizedLines.push('');
      continue;
    }
    const pipeCount = (raw.match(/\|/g) || []).length;
    const isTableDivider = /^[:\-\|\s]+$/.test(raw);
    if (isTableDivider) {
      continue;
    }
    if (pipeCount >= 2 && !isTableDivider) {
      const cells = raw
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length >= 2) {
        normalizedLines.push(`• ${cells[0]}: ${cells.slice(1).join(' | ')}`);
      } else {
        normalizedLines.push(raw);
      }
      continue;
    }
    normalizedLines.push(raw);
  }

  return normalizedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const ORDERED_LIST_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const UNORDERED_LIST_RE = /^\s*[-*•]\s+(.*)$/;
const SOURCE_LINE_RE = /^\s*SOURCES?\s*:/i;

const looksCollapsedEnglishForDisplay = (value: string): boolean => {
  const body = String(value || '')
    .split('\n')
    .filter((line) => !SOURCE_LINE_RE.test(line))
    .join('\n')
    .trim();
  if (!body) return false;
  const letters = (body.match(/[A-Za-z]/g) || []).length;
  const spaces = (body.match(/\s/g) || []).length;
  const longRuns = body.match(/[A-Za-z]{18,}/g) || [];
  if (letters < 90) return false;
  return spaces / Math.max(letters, 1) < 0.09 || longRuns.length >= 2;
};

const repairCollapsedEnglishForDisplay = (value: string): string => {
  return String(value || '')
    .replace(/([,;:!?])([A-Za-z])/g, '$1 $2')
    .replace(/([A-Za-z])([,;:!?])/g, '$1$2 ')
    .replace(/\)\(/g, ') (')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([.!?。！？])\s*(\d+[.)]\s+)/g, '$1\n$2')
    .replace(/(\*\*[^*]+\*\*)\s*(\d+[.)]\s+)/g, '$1\n$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
    .trim();
};

const normalizeReplyForDisplay = (value: string): string => {
  let normalized = normalizeAiText(value)
    .replace(/([^\n])\s*(SOURCES?:\s*)/gi, '$1\n\n$2')
    .replace(/([.!?。！？])\s*(\d+[.)]\s+)/g, '$1\n$2')
    .trim();
  if (looksCollapsedEnglishForDisplay(normalized)) {
    normalized = repairCollapsedEnglishForDisplay(normalized);
  }
  return normalized;
};

type MarkdownBlock =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'ul'; items: Array<{ text: string }> }
  | { type: 'ol'; items: Array<{ text: string; order: number }> };

function parseMarkdownBlocks(value: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = String(value || '').split('\n');
  let paragraphLines: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let listItems: Array<{ text: string; order?: number }> = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    blocks.push({ type: 'paragraph', lines: [...paragraphLines] });
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listType || !listItems.length) return;
    if (listType === 'ul') {
      blocks.push({ type: 'ul', items: listItems.map((item) => ({ text: item.text })) });
    } else {
      blocks.push({
        type: 'ol',
        items: listItems.map((item, idx) => ({
          text: item.text,
          order: Number(item.order || idx + 1),
        })),
      });
    }
    listType = null;
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = String(rawLine || '');
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const ordered = trimmed.match(ORDERED_LIST_RE);
    if (ordered) {
      flushParagraph();
      if (listType !== 'ol') {
        flushList();
        listType = 'ol';
      }
      listItems.push({
        text: String(ordered[2] || '').trim(),
        order: Number(ordered[1] || 1),
      });
      continue;
    }

    const unordered = trimmed.match(UNORDERED_LIST_RE);
    if (unordered) {
      flushParagraph();
      if (listType !== 'ul') {
        flushList();
        listType = 'ul';
      }
      listItems.push({ text: String(unordered[1] || '').trim() });
      continue;
    }

    flushList();
    paragraphLines.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function renderInlineMarkdown(value: string, keyPrefix: string): ReactNode[] {
  const parts = String(value || '')
    .split(/(\*\*[^*]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g)
    .filter(Boolean);

  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (/^`[^`\n]+`$/.test(part)) {
      return (
        <code
          key={key}
          className="rounded px-1 py-0.5 bg-slate-200/80 dark:bg-slate-700/70 text-[0.9em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (/^\*[^*\n]+\*$/.test(part)) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <span key={key}>{part}</span>;
  });
}

function RichMessageText({ text }: { text: string }) {
  const normalized = normalizeReplyForDisplay(text);
  const blocks = parseMarkdownBlocks(normalized);
  if (!blocks.length) return null;

  return (
    <div className="space-y-2 text-sm leading-relaxed break-words text-slate-900 dark:text-slate-100">
      {blocks.map((block, blockIndex) => {
        if (block.type === 'paragraph') {
          return (
            <p key={`p-${blockIndex}`}>
              {block.lines.map((line, lineIndex) => (
                <span key={`p-${blockIndex}-line-${lineIndex}`}>
                  {renderInlineMarkdown(line, `p-${blockIndex}-line-${lineIndex}`)}
                  {lineIndex < block.lines.length - 1 ? <br /> : null}
                </span>
              ))}
            </p>
          );
        }

        if (block.type === 'ul') {
          return (
            <ul key={`ul-${blockIndex}`} className="list-disc pl-5 space-y-1">
              {block.items.map((item, itemIndex) => (
                <li key={`ul-${blockIndex}-item-${itemIndex}`}>
                  {renderInlineMarkdown(item.text, `ul-${blockIndex}-item-${itemIndex}`)}
                </li>
              ))}
            </ul>
          );
        }

        const start = block.items[0]?.order || 1;
        return (
          <ol key={`ol-${blockIndex}`} start={start} className="list-decimal pl-5 space-y-1">
            {block.items.map((item, itemIndex) => (
              <li key={`ol-${blockIndex}-item-${itemIndex}`}>
                {renderInlineMarkdown(item.text, `ol-${blockIndex}-item-${itemIndex}`)}
              </li>
            ))}
          </ol>
        );
      })}
    </div>
  );
}

function tryParseEmbeddedJsonObject(text: string): any | null {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidateText = fenced?.[1]?.trim() || raw;

  try {
    return JSON.parse(candidateText);
  } catch {
    const first = candidateText.indexOf('{');
    const last = candidateText.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(candidateText.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseDualLanguageContent(content: string): DualLanguageContent {
  if (!content || typeof content !== 'string') {
    console.warn('[parseDualLanguageContent] Invalid content:', content);
    return {
      isDualLanguage: false,
      isSingleLanguage: false,
      rawContent: String(content || ''),
      content: String(content || ''),
    };
  }

  const singleLangMatch = content.match(/<!--SINGLE_LANG_START-->([\s\S]*?)<!--SINGLE_LANG_END-->/);
  if (singleLangMatch && singleLangMatch[1]) {
    try {
      const jsonStr = singleLangMatch[1].trim();
      if (!jsonStr || jsonStr.length === 0) throw new Error('Empty JSON between markers');
      if (!jsonStr.includes('{') && !jsonStr.includes('}')) throw new Error('Invalid JSON format');

      const parsed = JSON.parse(jsonStr);
      const normalized = normalizeAiText(parsed.content || '');
      return {
        isDualLanguage: false,
        isSingleLanguage: true,
        content: normalized,
        language: parsed.language,
        translationPending: parsed.translationPending === true,
        rawContent: normalized,
        targetLanguage: parsed.language,
        translated: normalized,
      };
    } catch (e) {
      console.error('[parseDualLanguageContent] Single-language JSON parse error:', e);
    }
  }

  let cleanContent = content
    .replace(/<[^>]*>/g, '')
    .replace(/<!--SINGLE_LANG_START-->/g, '')
    .replace(/<!--SINGLE_LANG_END-->/g, '')
    .replace(/<!--DUAL_LANG_START-->/g, '')
    .replace(/<!--DUAL_LANG_END-->/g, '')
    .trim();
  cleanContent = normalizeAiText(cleanContent);

  const jsonMatch = cleanContent.match(/\{[\s\S]*?"dualLanguage"\s*:\s*true[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.dualLanguage) {
        let jaText = parsed.japanese || '';
        let enText = parsed.translated || '';
        jaText = normalizeAiText(String(jaText).replace(/\{[\s\S]*?"dualLanguage"[\s\S]*?\}/g, '').trim());
        enText = normalizeAiText(String(enText).replace(/\{[\s\S]*?"dualLanguage"[\s\S]*?\}/g, '').trim());
        return {
          isDualLanguage: true,
          isSingleLanguage: false,
          japanese: jaText,
          translated: enText,
          targetLanguage: parsed.targetLanguage || 'en',
          rawContent: enText || jaText,
        };
      }
    } catch (e) {
      console.error('[parseDualLanguageContent] JSON parse error:', e);
    }
  }

  const enMatch = cleanContent.match(/\[EN\]\s*([\s\S]*?)(?=\[JA\]|$)/i);
  const jaMatch = cleanContent.match(/\[JA\]\s*([\s\S]*?)(?=\[EN\]|$)/i);
  if (enMatch && jaMatch) {
    const englishText = enMatch[1].trim();
    const japaneseText = jaMatch[1].trim();
    if (englishText && japaneseText) {
      const enIndex = cleanContent.indexOf('[EN]');
      const jaIndex = cleanContent.indexOf('[JA]');
      const userLangFirst = enIndex < jaIndex ? 'en' : 'ja';
      return {
        isDualLanguage: true,
        isSingleLanguage: false,
        japanese: japaneseText,
        translated: englishText,
        targetLanguage: userLangFirst,
        rawContent: content,
      };
    }
  }

  const parts = cleanContent.split(/\n---+\n/);
  if (parts.length >= 2) {
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(parts[1]);
    if (hasJapanese) {
      return {
        isDualLanguage: true,
        isSingleLanguage: false,
        japanese: parts[1].trim(),
        translated: parts[0].trim(),
        targetLanguage: 'en',
        rawContent: content,
      };
    }
  }

  const parsedAny = tryParseEmbeddedJsonObject(cleanContent);
  if (parsedAny && typeof parsedAny === 'object' && typeof parsedAny.content === 'string') {
    return {
      isDualLanguage: false,
      isSingleLanguage: true,
      content: normalizeAiText(parsedAny.content),
      language: parsedAny.language || 'en',
      translationPending: parsedAny.translationPending === true,
      rawContent: normalizeAiText(parsedAny.content),
      targetLanguage: parsedAny.language || 'en',
      translated: normalizeAiText(parsedAny.content),
    };
  }

  return {
    isDualLanguage: false,
    isSingleLanguage: false,
    rawContent: normalizeAiText(cleanContent),
    content: normalizeAiText(cleanContent),
    japanese: undefined,
    translated: undefined,
    targetLanguage: undefined,
  };
}

// Action buttons component for bot messages
interface MessageActionsProps {
  content: string;
  messageId: string;
  onFeedback?: (messageId: string, feedback: 'like' | 'dislike') => void;
  onRegenerate?: () => void;
  onEditResend?: () => void;
}

function MessageActions({ content, messageId, onFeedback, onRegenerate, onEditResend }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<'like' | 'dislike' | null>(null);
  const { t } = useLang();

  const handleCopy = async () => {
    const parsed = parseDualLanguageContent(content);
    let textToCopy = parsed.rawContent;
    if (parsed.isDualLanguage && parsed.translated && parsed.japanese) {
      textToCopy = `${parsed.translated}\n\n---\n\n${parsed.japanese}`;
    }
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFeedback = (type: 'like' | 'dislike') => {
    setFeedback(type);
    onFeedback?.(messageId, type);
  };

  return (
    <>
      <div className="flex items-center gap-1 mt-2 pt-2 border-t border-black/10 dark:border-white/10">
        <button onClick={handleCopy} className="mac-iconbtn" title={t('chatActions.copy')}>
          {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
        </button>

        <button
          onClick={() => handleFeedback('like')}
          className={`mac-iconbtn ${feedback === 'like' ? 'mac-iconbtn-active-good' : ''}`}
          title={t('chatActions.good')}
        >
          <ThumbsUp className="w-4 h-4" />
        </button>

        <button
          onClick={() => handleFeedback('dislike')}
          className={`mac-iconbtn ${feedback === 'dislike' ? 'mac-iconbtn-active-bad' : ''}`}
          title={t('chatActions.bad')}
        >
          <ThumbsDown className="w-4 h-4" />
        </button>

        <button onClick={onRegenerate} className="mac-iconbtn" title={t('chatActions.regenerate')}>
          <RefreshCw className="w-4 h-4" />
        </button>

        <button onClick={onEditResend} className="mac-iconbtn" title={t('chat.editResend')}>
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
    </>
  );
}

// Component for displaying dual-language content
// CHANGE: Added isInitialMessage prop to suppress translation button on welcome message
function DualLanguageMessage({
  content,
  taskOutputId,
  isInitialMessage,
}: {
  content: DualLanguageContent;
  taskOutputId?: number;
  isInitialMessage?: boolean;
}) {
  const [translation, setTranslation] = useState<string | null>(null);
  const [loadingTranslation, setLoadingTranslation] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translationMs, setTranslationMs] = useState<number | null>(null);
  const { t } = useLang();
  const toast = useToast();

  let sourceLanguage: 'ja' | 'en' = 'en';
  let targetLanguage: 'ja' | 'en' = 'ja';
  let displayText = '';

  if (content.isSingleLanguage && content.language) {
    sourceLanguage = content.language;
    targetLanguage = content.language === 'ja' ? 'en' : 'ja';
    displayText = content.content || '';
  } else if (content.isDualLanguage) {
    sourceLanguage = content.targetLanguage === 'ja' ? 'ja' : 'en';
    targetLanguage = sourceLanguage === 'ja' ? 'en' : 'ja';
    displayText = sourceLanguage === 'ja' ? (content.japanese || '') : (content.translated || '');
  } else {
    displayText = content.content || content.rawContent || '';
    sourceLanguage = detectDisplayLanguage(displayText);
    targetLanguage = sourceLanguage === 'ja' ? 'en' : 'ja';
  }

  const normalizedOutputId = Number(taskOutputId);
  const canTranslate = !isInitialMessage
    && displayText.trim().length > 0
    && Number.isFinite(normalizedOutputId)
    && normalizedOutputId > 0;
  const targetLanguageName = targetLanguage === 'ja' ? '日本語' : 'English';

  const handleTranslate = async () => {
    if (translation !== null && !loadingTranslation) {
      setTranslation(null);
      setTranslationMs(null);
      return;
    }

    const translateStartAt = Date.now();
    setTranslation('');
    setLoadingTranslation(true);
    setTranslationError(null);
    setTranslationMs(null);

    const translationTimeoutId = setTimeout(() => {
      setLoadingTranslation(false);
      const errorMsg = sourceLanguage === 'ja'
        ? '翻訳タイムアウト(5分以上かかりました。サーバーが忙しい可能性があります。)'
        : 'Translation timeout (took more than 5 minutes). Please try again.';
      setTranslationError(errorMsg);
    }, 300000);

    try {
      if (!Number.isFinite(normalizedOutputId) || normalizedOutputId <= 0) {
        const errorMsg = sourceLanguage === 'ja'
          ? 'メッセージIDが見つかりません'
          : 'Unable to find message ID for translation';
        setTranslationError(errorMsg);
        clearTimeout(translationTimeoutId);
        return;
      }

      const token = getToken();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch('/dev-api/api/gen-task/translate-on-demand', {
        method: 'POST',
        headers,
        body: JSON.stringify({ outputId: normalizedOutputId, targetLanguage }),
      });

      if (!response.ok) {
        const responseText = await response.text();
        let errorMessage = response.statusText;
        try {
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.message || errorData.error || response.statusText;
        } catch {
          errorMessage = responseText || response.statusText;
        }
        throw new Error(`API Error [${response.status}]: ${errorMessage}`);
      }

      const responseText = await response.text();
      if (!responseText || responseText.trim().length === 0) throw new Error('Server returned empty response');
      const data = JSON.parse(responseText);
      const translatedText = String(data?.result?.content || data?.content || '').trim();
      if (!translatedText) throw new Error(`No translation content in response. Got: ${JSON.stringify(data)}`);
      setTranslation(normalizeAiText(translatedText));
      setTranslationMs(Date.now() - translateStartAt);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setTranslation(null);
      setTranslationError(errorMsg);
      toast.error(errorMsg);
    } finally {
      clearTimeout(translationTimeoutId);
      setLoadingTranslation(false);
    }
  };

  return (
    <div className="w-full space-y-3">
      <div className="space-y-2">
        {/* CHANGE: Only show language label when it's a dual-language message (not initial/single-lang) */}
        {content.isDualLanguage && (
          <div className="flex items-center gap-2 pb-2">
            <Globe className="w-3.5 h-3.5 text-blue-500" />
            <span className="text-xs font-semibold text-blue-600 dark:text-blue-300">
              {sourceLanguage === 'ja' ? '日本語' : 'English'}
            </span>
          </div>
        )}

        <RichMessageText text={displayText || ''} />
      </div>

      {/* CHANGE: Translation button is hidden on the initial welcome message */}
      {canTranslate && (
        <div>
          {translation === null ? (
            <button onClick={handleTranslate} disabled={loadingTranslation} className="mac-secondary">
              <Languages className="w-3.5 h-3.5" />
              <span>{loadingTranslation ? t('chat.translating') : t('chat.showTranslation', { lang: targetLanguageName })}</span>
            </button>
          ) : (
            <>
              <div className="mt-3 mac-panel p-4">
                <div className="flex items-center gap-2 mb-2 pb-2 border-b border-black/10 dark:border-white/10">
                  <Globe className="w-4 h-4 text-blue-500" />
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    {targetLanguageName}
                  </span>
                  {translationMs != null && !loadingTranslation && (
                    <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400">
                      Translation: {(translationMs / 1000).toFixed(2)}s
                    </span>
                  )}
                </div>
                <RichMessageText text={`${translation || ''}${loadingTranslation ? '...' : ''}`} />
              </div>

              <button onClick={handleTranslate} disabled={loadingTranslation} className="mt-2 mac-secondary">
                <Globe className="w-3.5 h-3.5" />
                <span>{loadingTranslation ? t('chat.translating') : t('chat.hideTranslation')}</span>
              </button>
            </>
          )}

          {translationError && (
            <div className="mt-2 p-2 rounded-lg bg-red-900/10 dark:bg-red-900/30 border border-red-700/20 dark:border-red-700/50 text-xs text-red-600 dark:text-red-300">
              {translationError}
              <button onClick={handleTranslate} className="ml-2 underline hover:no-underline">
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ChatInterface({ focusSignal, onUserTyping }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      type: 'bot',
      content:
        "Hello! I'm your QA Policy Assistant. I can help you with questions about company policies, benefits, leave, remote work, and more. You can ask in English or Japanese (日本語でも質問できます).",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [chatList, setChatList] = useState<ChatTask[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [fieldSort, setFieldSort] = useState(0);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);
  const [pdfPreview, setPdfPreview] = useState<{ filename: string; page: number; highlight?: string } | null>(null);
  const [triageDraft, setTriageDraft] = useState<TriageDraft | null>(null);
  const [triageIssueType, setTriageIssueType] = useState('incorrectAnswer');
  const [triageComment, setTriageComment] = useState('');
  const [triageExpectedAnswer, setTriageExpectedAnswer] = useState('');
  const [triageRoutingMode, setTriageRoutingMode] = useState<'AUTO' | 'SUPER_ADMIN' | 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN'>('AUTO');
  const [triageLoadingAssignees, setTriageLoadingAssignees] = useState(false);
  const [triageSubmitting, setTriageSubmitting] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { t } = useLang();
  const toast = useToast();

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    if (type === 'success') toast.success(message);
    else if (type === 'error') toast.error(message);
    else toast.info(message);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => { scrollToBottom(); }, [messages]);

  useEffect(() => {
    if (typeof focusSignal !== 'undefined') inputRef.current?.focus();
  }, [focusSignal]);

  useEffect(() => {
    loadChatList();
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadChatList = async () => {
    try {
      const response = await listTask({ pageNum: 1, pageSize: 100 });
      if (response.code === 200 && response.result?.rows) {
        const chats = response.result.rows.map((task: any) => ({
          id: task.id,
          title: task.formData || task.form_data || t('chat.newChat'),
          createdAt: task.createdAt,
        }));
        setChatList(chats);
      }
    } catch (error) {
      console.error('Failed to load chat list:', error);
    }
  };

  const fetchTraceForOutput = useCallback(async (taskId: string, outputId: number): Promise<RagTraceRecent | null> => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const token = getToken();
        const headers: HeadersInit = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const direct = await fetch(
          `/dev-api/api/rag/trace?taskId=${encodeURIComponent(taskId)}&outputId=${encodeURIComponent(String(outputId))}`,
          { headers },
        );
        if (direct.ok) {
          const directData = await direct.json();
          if (directData?.ok && directData?.data) return directData.data as RagTraceRecent;
        }
        const res = await fetch('/dev-api/api/rag/metrics', { headers });
        if (!res.ok) return null;
        const data = await res.json();
        const recent: RagTraceRecent[] = data?.data?.recent || [];
        for (let i = recent.length - 1; i >= 0; i -= 1) {
          const r = recent[i];
          if (
            r?.name === 'rag_chat_pipeline' &&
            String(r?.meta?.task_id || '') === String(taskId) &&
            String(r?.meta?.output_id || '') === String(outputId)
          ) return r;
        }
        if (attempt < 3) await sleep(250);
      } catch { return null; }
    }
    return null;
  }, []);

  const fetchKpiFallback = useCallback(async (outputId: number): Promise<RagKpiFallback | null> => {
    try {
      const token = getToken();
      const headers: HeadersInit = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`/dev-api/api/rag/kpi?outputId=${encodeURIComponent(String(outputId))}`, { headers });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.ok || !data?.data) return null;
      return {
        totalMs: data.data.totalMs, ragMs: data.data.ragMs, llmMs: data.data.llmMs,
        retrievalMs: data.data.retrievalMs, titleMs: data.data.titleMs,
      };
    } catch { return null; }
  }, []);

  const fetchStoredTaskOutput = useCallback(async (
    taskId: string,
    outputId?: number,
    sortHint?: number,
  ): Promise<{ id?: number; status?: string; content?: string } | null> => {
    try {
      const response = await listTaskOutput({ pageNum: 1, pageSize: 1000, taskId });
      const rows = Array.isArray(response?.result?.rows) ? response.result.rows : [];
      if (!rows.length) return null;

      let selected = outputId
        ? rows.find((row: any) => Number(row?.id) === Number(outputId))
        : null;

      if (!selected && Number.isFinite(Number(sortHint))) {
        selected = rows.find((row: any) => Number(row?.sort) === Number(sortHint));
      }

      if (!selected) {
        selected = [...rows].sort((a: any, b: any) => Number(b?.sort || 0) - Number(a?.sort || 0))[0];
      }

      if (!selected) return null;
      return {
        id: Number(selected?.id || 0) || undefined,
        status: String(selected?.status || ''),
        content: String(selected?.content || ''),
      };
    } catch {
      return null;
    }
  }, []);

  const startNewChat = () => {
    setCurrentChatId(null);
    setMessages([{ id: '1', type: 'bot', content: t('chat.welcomeMessage'), timestamp: new Date() }]);
    setFieldSort(0);
  };

  const pollForResponse = useCallback((taskId: string, newFieldSort: number) => {
    let attempts = 0;
    let totalPollCycles = 0;
    let lastContentLength = 0;
    const requestStartedAt = Date.now();
    let firstTokenAt: number | null = null;
    let firstInProcessAt: number | null = null;
    let renderedContentText = '';
    let lastSmoothFlushAt = Date.now();
    const progressSteps = ['Analyzing your question', 'Searching documents', 'Building answer'];
    const pollIntervalMs = 200;
    const pollTimeoutMs = Math.max(
      60_000,
      Number((import.meta as any)?.env?.VITE_CHAT_POLL_TIMEOUT_MS || 240_000),
    );
    const maxAttempts = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs));

    pollingRef.current = setInterval(async () => {
      attempts++;
      totalPollCycles++;
      try {
        const response = await listTaskOutput({ pageNum: 1, pageSize: 1000, taskId });
        if (response.code === 200 && response.result?.rows) {
          const latestOutput = response.result.rows.find(
            (o: TaskOutput) => o.sort === newFieldSort || o.sort === newFieldSort + 1
          ) || response.result.rows
            .filter((o: TaskOutput) => o.sort >= newFieldSort)
            .sort((a: TaskOutput, b: TaskOutput) => b.sort - a.sort)[0];

          if (latestOutput) {
            const contentText = latestOutput.content || '';
            const contentLen = contentText.length;
            const statusTextRaw = String(latestOutput.status || 'WAIT').toUpperCase();
            if ((statusTextRaw === 'IN_PROCESS' || statusTextRaw === 'PROCESSING') && firstInProcessAt == null) firstInProcessAt = Date.now();
            if (contentLen > 0 && firstTokenAt == null) firstTokenAt = Date.now();

            let generationStatus = t('chat.queuedProcessing');
            if (statusTextRaw === 'WAIT') generationStatus = t('chat.queuedProcessing');
            else if (statusTextRaw === 'IN_PROCESS' || statusTextRaw === 'PROCESSING') {
              if (contentLen > 0) generationStatus = t('chat.generatingAnswer');
              else generationStatus = progressSteps[Math.floor(((Date.now() - requestStartedAt) / 1500) % progressSteps.length)];
            } else if (statusTextRaw === 'FINISHED') generationStatus = t('chat.completed');
            else if (statusTextRaw === 'FAILED') generationStatus = t('chat.failed');
            else if (statusTextRaw === 'CANCEL') generationStatus = t('chat.cancelled');

            const terminal = latestOutput.status === 'FINISHED' || latestOutput.status === 'FAILED' || latestOutput.status === 'CANCEL';
            const canFlush = terminal || shouldSmoothFlush(contentText, renderedContentText, lastSmoothFlushAt);
            if (canFlush) {
              renderedContentText = contentText;
              lastSmoothFlushAt = Date.now();
              setMessages(prev => {
                const updated = [...prev];
                const lastIndex = updated.length - 1;
                const current = updated[lastIndex];
                if (current?.type === 'bot') {
                  const canAdoptThisOutput = !current.taskOutputId
                    || current.taskOutputId === latestOutput.id
                    || !isTerminalBotMessage(current);
                  if (canAdoptThisOutput) {
                    updated[lastIndex] = {
                      ...current,
                      content: contentText,
                      status: latestOutput.status,
                      taskOutputId: latestOutput.id,
                      generationStatus,
                    };
                  }
                }
                return updated;
              });
            }

            if (contentLen > lastContentLength) { lastContentLength = contentLen; attempts = 0; }

            if (latestOutput.status === 'FINISHED' || latestOutput.status === 'FAILED' || latestOutput.status === 'CANCEL') {
              setIsTyping(false);
              if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
              const finishedAt = Date.now();
              const clientKpi = {
                totalMs: finishedAt - requestStartedAt,
                ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
                queueMs: firstInProcessAt ? firstInProcessAt - requestStartedAt : undefined,
                pollCycles: totalPollCycles,
              };
              const trace = await fetchTraceForOutput(taskId, latestOutput.id);
              const backendFromTrace = trace ? {
                totalMs: trace.totalMs, ttftMs: trace.ttftMs,
                ragMs: Number(trace?.meta?.rag_ms || 0) || undefined,
                llmMs: stageValue(trace.stages, 'llm.generate'),
                titleMs: stageValue(trace.stages, 'history.create_chat_title'),
                retrievalMs: stagePrefixSum(trace.stages, 'retrieval.'),
              } : undefined;
              const backendFromKpi = await fetchKpiFallback(latestOutput.id);
              const backend = backendFromTrace
                ? { ...backendFromTrace, totalMs: backendFromTrace.totalMs ?? backendFromKpi?.totalMs, ragMs: backendFromTrace.ragMs ?? backendFromKpi?.ragMs, llmMs: backendFromTrace.llmMs ?? backendFromKpi?.llmMs, titleMs: backendFromTrace.titleMs ?? backendFromKpi?.titleMs, retrievalMs: backendFromTrace.retrievalMs ?? backendFromKpi?.retrievalMs }
                : (backendFromKpi || undefined);
              setMessages(prev => {
                const updated = [...prev];
                const lastIndex = updated.length - 1;
                const current = updated[lastIndex];
                if (current?.type === 'bot') {
                  const canAdoptThisOutput = !current.taskOutputId
                    || current.taskOutputId === latestOutput.id
                    || !isTerminalBotMessage(current);
                  if (canAdoptThisOutput) {
                    updated[lastIndex] = {
                      ...current,
                      generationStatus: latestOutput.status === 'FINISHED' ? 'Completed' : current.generationStatus,
                      status: latestOutput.status,
                      taskOutputId: latestOutput.id,
                      kpi: { ...clientKpi, backend },
                    };
                  }
                }
                return updated;
              });
            }
          }
        }
      } catch (error) { console.error('Polling error:', error); }

      if (attempts >= maxAttempts) {
        setIsTyping(false);
        if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
        if (lastContentLength === 0) {
          setMessages(prev => {
            const updated = [...prev];
            const lastIndex = updated.length - 1;
            if (updated[lastIndex]?.type === 'bot' && !updated[lastIndex].content) {
              updated[lastIndex] = { ...updated[lastIndex], content: '⏱️ Response timeout. Please try again.', generationStatus: 'Timed out', kpi: { totalMs: Date.now() - requestStartedAt, ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined, queueMs: firstInProcessAt ? firstInProcessAt - requestStartedAt : undefined, pollCycles: totalPollCycles } };
            }
            return updated;
          });
        } else {
          setMessages(prev => {
            const updated = [...prev];
            const lastIndex = updated.length - 1;
            if (updated[lastIndex]?.type === 'bot') {
              updated[lastIndex] = {
                ...updated[lastIndex],
                generationStatus: 'Timed out',
                kpi: {
                  totalMs: Date.now() - requestStartedAt,
                  ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined,
                  queueMs: firstInProcessAt ? firstInProcessAt - requestStartedAt : undefined,
                  pollCycles: totalPollCycles,
                },
              };
            }
            return updated;
          });
        }
      }
    }, pollIntervalMs);
  }, [fetchKpiFallback, fetchTraceForOutput]);

  const streamForResponse = useCallback(async (taskId: string, newFieldSort: number): Promise<boolean> => {
    const requestStartedAt = Date.now();
    let totalPollCycles = 0;
    let firstTokenAt: number | null = null;
    let firstInProcessAt: number | null = null;
    let lastRenderableEventAt = Date.now();
    let lastStatusEventAt = Date.now();
    const STREAM_IDLE_FALLBACK_MS = 9000;
    let lastContent = '';
    let renderedContent = '';
    let pendingDelta = '';
    let smoothTicker: ReturnType<typeof setInterval> | null = null;
    const progressSteps = ['Analyzing your question', 'Searching documents', 'Building answer'];

    const updateBotMessage = (content: string, generationStatus = 'Generating answer', outputId?: number) => {
      setMessages(prev => {
        const updated = [...prev];
        const lastIndex = updated.length - 1;
        if (updated[lastIndex]?.type === 'bot') {
          updated[lastIndex] = {
            ...updated[lastIndex],
            content,
            generationStatus,
            taskOutputId: outputId || updated[lastIndex].taskOutputId,
          };
        }
        return updated;
      });
    };

    const flushAllPending = (outputId?: number) => {
      if (pendingDelta.length > 0) {
        renderedContent += pendingDelta;
        pendingDelta = '';
      }
      lastContent = renderedContent;
      if (lastContent) updateBotMessage(lastContent, 'Generating answer', outputId);
    };

    const stopSmoothTicker = () => {
      if (smoothTicker) {
        clearInterval(smoothTicker);
        smoothTicker = null;
      }
    };

    const ensureSmoothTicker = (outputId?: number) => {
      if (smoothTicker) return;
      smoothTicker = setInterval(() => {
        if (!pendingDelta.length) return;
        // letter-like smoothness while keeping UI updates bounded
        const take = Math.min(4, pendingDelta.length);
        renderedContent += pendingDelta.slice(0, take);
        pendingDelta = pendingDelta.slice(take);
        lastContent = renderedContent;
        updateBotMessage(lastContent, 'Generating answer', outputId);
      }, 18);
    };
    const waitForPendingDrain = async (outputId?: number) => {
      if (!pendingDelta.length) return;
      ensureSmoothTicker(outputId);
      const startedAt = Date.now();
      while (pendingDelta.length > 0 && Date.now() - startedAt < 1800) {
        await new Promise((resolve) => setTimeout(resolve, 18));
      }
      // Safety flush if ticker did not fully drain in time.
      if (pendingDelta.length > 0) {
        flushAllPending(outputId);
      }
    };

    try {
      const token = getToken();
      const headers: HeadersInit = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(
        `/dev-api/api/gen-task-output/stream?taskId=${encodeURIComponent(taskId)}&sort=${encodeURIComponent(String(newFieldSort))}`,
        { headers },
      );
      if (!res.ok || !res.body) return false;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentOutputId: number | undefined;
      let sawDoneEvent = false;

      const finalize = async (status: string) => {
        flushAllPending(currentOutputId);
        stopSmoothTicker();
        setIsTyping(false);
        const finishedAt = Date.now();
        const clientKpi = { totalMs: finishedAt - requestStartedAt, ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : undefined, queueMs: firstInProcessAt ? firstInProcessAt - requestStartedAt : undefined, pollCycles: totalPollCycles };
        const trace = currentOutputId ? await fetchTraceForOutput(taskId, currentOutputId) : null;
        const backendFromTrace = trace ? { totalMs: trace.totalMs, ttftMs: trace.ttftMs, ragMs: Number(trace?.meta?.rag_ms || 0) || undefined, llmMs: stageValue(trace.stages, 'llm.generate'), titleMs: stageValue(trace.stages, 'history.create_chat_title'), retrievalMs: stagePrefixSum(trace.stages, 'retrieval.') } : undefined;
        const backendFromKpi = currentOutputId ? await fetchKpiFallback(currentOutputId) : null;
        const storedOutput = await fetchStoredTaskOutput(taskId, currentOutputId, newFieldSort);
        const backend = backendFromTrace ? { ...backendFromTrace, totalMs: backendFromTrace.totalMs ?? backendFromKpi?.totalMs, ragMs: backendFromTrace.ragMs ?? backendFromKpi?.ragMs, llmMs: backendFromTrace.llmMs ?? backendFromKpi?.llmMs, titleMs: backendFromTrace.titleMs ?? backendFromKpi?.titleMs, retrievalMs: backendFromTrace.retrievalMs ?? backendFromKpi?.retrievalMs } : (backendFromKpi || undefined);
        const finalizedContent = String(storedOutput?.content || lastContent || renderedContent || '');
        const finalizedStatus = String(storedOutput?.status || status || '').toUpperCase();
        setMessages(prev => {
          const updated = [...prev];
          const lastIndex = updated.length - 1;
          if (updated[lastIndex]?.type === 'bot') {
            updated[lastIndex] = {
              ...updated[lastIndex],
              content: finalizedContent,
              generationStatus:
                finalizedStatus === 'FINISHED'
                  ? 'Completed'
                  : finalizedStatus === 'FAILED'
                    ? 'Failed'
                    : finalizedStatus === 'CANCEL'
                      ? 'Cancelled'
                      : updated[lastIndex].generationStatus,
              taskOutputId:
                storedOutput?.id || currentOutputId || updated[lastIndex].taskOutputId,
              kpi: { ...clientKpi, backend },
            };
          }
          return updated;
        });
      };

      const processSseEvent = async (evt: string): Promise<'continue' | 'done' | 'fallback'> => {
        const lines = evt.split('\n');
        const eventName = (lines.find((l) => l.startsWith('event:')) || '').replace('event:', '').trim();
        const dataLine = (lines.find((l) => l.startsWith('data:')) || '').replace('data:', '').trim();
        if (!dataLine) return 'continue';
        let payload: any = null;
        try { payload = JSON.parse(dataLine); } catch { payload = null; }
        if (!payload) return 'continue';
        if (payload.outputId) currentOutputId = Number(payload.outputId);
        if (eventName === 'status') {
          const st = String(payload.status || 'WAIT').toUpperCase();
          const statusMessage = String(payload.message || '').trim();
          lastStatusEventAt = Date.now();
          if ((st === 'IN_PROCESS' || st === 'PROCESSING') && firstInProcessAt == null) firstInProcessAt = Date.now();
          setMessages(prev => {
            const updated = [...prev];
            const lastIndex = updated.length - 1;
            if (updated[lastIndex]?.type === 'bot') {
              const hasVisibleContent = String(renderedContent || pendingDelta || lastContent).trim().length > 0;
              const staleProcessingStatusMessage =
                (st === 'IN_PROCESS' || st === 'PROCESSING') &&
                Boolean(statusMessage) &&
                !hasVisibleContent &&
                (Date.now() - requestStartedAt > 5000);
              const generationStatus = (!staleProcessingStatusMessage ? statusMessage : '')
                || (st === 'WAIT'
                  ? 'Queued for processing'
                  : st === 'IN_PROCESS' || st === 'PROCESSING'
                    ? (lastContent ? 'Generating answer' : progressSteps[Math.floor(((Date.now() - requestStartedAt) / 1500) % progressSteps.length)])
                    : st === 'FINISHED'
                      ? 'Completed'
                      : st === 'FAILED'
                        ? 'Failed'
                        : st === 'CANCEL'
                          ? 'Cancelled'
                          : updated[lastIndex].generationStatus);
              updated[lastIndex] = { ...updated[lastIndex], generationStatus, taskOutputId: currentOutputId || updated[lastIndex].taskOutputId };
            }
            return updated;
          });
        } else if (eventName === 'chunk' && payload.delta) {
          if (firstTokenAt == null) firstTokenAt = Date.now();
          pendingDelta += String(payload.delta);
          lastRenderableEventAt = Date.now();
          ensureSmoothTicker(currentOutputId);
        } else if (eventName === 'replace') {
          const nextContent = String(payload.content || '');
          if (nextContent && firstTokenAt == null) firstTokenAt = Date.now();
          if (nextContent) lastRenderableEventAt = Date.now();
          const currentVisible = renderedContent + pendingDelta;
          if (nextContent.startsWith(currentVisible)) {
            pendingDelta += nextContent.slice(currentVisible.length);
            ensureSmoothTicker(currentOutputId);
          } else {
            pendingDelta = '';
            renderedContent = nextContent;
            lastContent = nextContent;
            updateBotMessage(nextContent, 'Generating answer', currentOutputId);
          }
        } else if (eventName === 'done') {
          sawDoneEvent = true;
          await waitForPendingDrain(currentOutputId);
          await finalize(String(payload.status || 'FINISHED').toUpperCase());
          return 'done';
        } else if (eventName === 'error' || eventName === 'timeout') {
          return 'fallback';
        }
        return 'continue';
      };

      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          totalPollCycles += 1;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';
          for (const evt of events) {
            const action = await processSseEvent(evt);
            if (action === 'done') return true;
            if (action === 'fallback') return false;
          }
        }
        if (done) break;

        if (
          !sawDoneEvent &&
          Date.now() - lastRenderableEventAt > STREAM_IDLE_FALLBACK_MS &&
          Date.now() - lastStatusEventAt > Math.min(3500, STREAM_IDLE_FALLBACK_MS / 2)
        ) {
          stopSmoothTicker();
          return false;
        }
      }

      if (buffer.trim()) {
        const action = await processSseEvent(buffer.trim());
        if (action === 'done') return true;
        if (action === 'fallback') return false;
      }

      if (!sawDoneEvent && String(lastContent || renderedContent || pendingDelta).trim().length > 0) {
        flushAllPending(currentOutputId);
        stopSmoothTicker();
        setMessages(prev => {
          const updated = [...prev];
          const lastIndex = updated.length - 1;
          if (updated[lastIndex]?.type === 'bot') {
            updated[lastIndex] = {
              ...updated[lastIndex],
              content: lastContent || renderedContent,
              generationStatus: 'Generating answer',
              taskOutputId: currentOutputId || updated[lastIndex].taskOutputId,
            };
          }
          return updated;
        });
      }
      stopSmoothTicker();
      return false;
    } catch {
      stopSmoothTicker();
      return false;
    }
  }, [fetchKpiFallback, fetchStoredTaskOutput, fetchTraceForOutput]);

  const handleSend = async (overrideInput?: string) => {
    const payload = (overrideInput ?? input).trim();
    if (!payload || isTyping) return;
    const greetingFastPath = isGreetingOnlyQuery(payload);

    const userMessage: Message = { id: Date.now().toString(), type: 'user', content: payload, timestamp: new Date() };
    const botPlaceholder: Message = { id: (Date.now() + 1).toString(), type: 'bot', content: greetingFastPath ? localGreetingReply(payload) : '', timestamp: new Date(), generationStatus: greetingFastPath ? 'Completed' : 'Queued for processing' };

    setMessages(prev => [...prev, userMessage, botPlaceholder]);
    const currentInput = payload;
    if (overrideInput === undefined) setInput('');
    setIsTyping(!greetingFastPath);
    onUserTyping?.(false);

    try {
      let taskId = currentChatId;
      if (!taskId) {
        const createResponse = await addTask({ type: 'CHAT', formData: {} });
        if (createResponse.code === 200 && createResponse.result?.taskId) {
          taskId = createResponse.result.taskId;
          setCurrentChatId(taskId);
          setFieldSort(0);
        } else throw new Error(t('chat.failedCreateChat'));
      }

      const newFieldSort = fieldSort + 1;
      setFieldSort(newFieldSort);

      const response = await addTask({
        type: 'CHAT',
        formData: { prompt: currentInput, fieldSort: newFieldSort, fileId: [], allFileSearch: true, useMcp: false, taskId: taskId },
      });

      if (response.code === 200 && response.result?.taskId) {
        const taskId2 = response.result.taskId;
        if (!currentChatId) { setCurrentChatId(taskId2); loadChatList(); }
        if (!greetingFastPath) {
          const streamed = await streamForResponse(taskId2, newFieldSort);
          if (!streamed) pollForResponse(taskId2, newFieldSort);
        }
      } else {
        setIsTyping(false);
        setMessages(prev => { const updated = [...prev]; updated[updated.length - 1].content = 'Sorry, there was an error processing your request.'; updated[updated.length - 1].generationStatus = 'Failed'; return updated; });
      }
    } catch (error) {
      console.error('Send error:', error);
      setIsTyping(false);
      setMessages(prev => { const updated = [...prev]; updated[updated.length - 1].content = 'Sorry, there was an error connecting to the server.'; updated[updated.length - 1].generationStatus = 'Failed'; return updated; });
    }
  };

  const handleFeedback = async (messageId: string, feedbackType: 'like' | 'dislike', taskOutputId?: number) => {
    if (!taskOutputId) return;
    const message = messages.find(m => m.id === messageId);
    if (!message) return;
    const messageIndex = messages.findIndex((m) => m.id === messageId);
    const prevUser = messageIndex >= 0 ? [...messages].slice(0, messageIndex).reverse().find((m) => m.type === 'user') : null;
    const cacheSignal = feedbackType === 'like' ? 1 : 0;
    const emoji = feedbackType === 'like' ? '👍' : '👎';
    try {
      await sendFeedbackToCache({ taskOutputId, cache_signal: cacheSignal, query: prevUser?.content || '', answer: message.content || '' });
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, feedback: { emoji } } : m));
    } catch (error) { console.error('Feedback error:', error); }
  };

  const openTriageForMessage = (botMessageId: string, taskOutputId: number | undefined, assistantAnswer: string) => {
    const idx = messages.findIndex((m) => m.id === botMessageId);
    const prevUser = idx >= 0 ? [...messages].slice(0, idx).reverse().find((m) => m.type === 'user') : null;
    setTriageDraft({ messageId: botMessageId, taskOutputId, assistantAnswer, userQuery: prevUser?.content || '' });
    setTriageIssueType('incorrectAnswer');
    setTriageComment('');
    setTriageExpectedAnswer('');
    setTriageRoutingMode('AUTO');
  };

  useEffect(() => {
    if (!triageDraft) return;
    let mounted = true;
    const loadAssignees = async () => {
      setTriageLoadingAssignees(true);
      try {
        const res: any = await listTriageAssignees();
        if (!mounted) return;
        // Assignee list is preloaded to validate endpoint availability before submit.
        void (Array.isArray(res?.result)
          ? res.result
          : Array.isArray(res?.result?.rows)
            ? res.result.rows
            : []);
      } catch {
        if (!mounted) return;
      } finally {
        if (mounted) setTriageLoadingAssignees(false);
      }
    };
    loadAssignees();
    return () => {
      mounted = false;
    };
  }, [triageDraft]);

  const submitTriage = async () => {
    if (!triageDraft || !triageComment.trim()) return;
    setTriageSubmitting(true);
    try {
      const token = getToken();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;

      let payloadRoutingMode: 'AUTO' | 'MANUAL' = 'AUTO';
      let payloadDepartmentCode: 'HR' | 'GA' | 'ACC' | undefined;
      let payloadAssignedToUserId: number | null = null;
      let payloadTargetRoleCode: 'SUPER_ADMIN' | 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN' | undefined;

      if (triageRoutingMode !== 'AUTO') {
        payloadRoutingMode = 'MANUAL';
        if (triageRoutingMode === 'SUPER_ADMIN') {
          payloadTargetRoleCode = 'SUPER_ADMIN';
        } else if (triageRoutingMode === 'HR_ADMIN') {
          payloadTargetRoleCode = 'HR_ADMIN';
          payloadDepartmentCode = 'HR';
        } else if (triageRoutingMode === 'GA_ADMIN') {
          payloadTargetRoleCode = 'GA_ADMIN';
          payloadDepartmentCode = 'GA';
        } else if (triageRoutingMode === 'ACC_ADMIN') {
          payloadTargetRoleCode = 'ACC_ADMIN';
          payloadDepartmentCode = 'ACC';
        }
      }

      const res = await fetch('/dev-api/api/triage/tickets', {
        method: 'POST', headers,
        body: JSON.stringify({
          conversationId: currentChatId || null,
          messageId: triageDraft.taskOutputId ? `${triageDraft.taskOutputId}:assistant` : triageDraft.messageId,
          userQueryOriginal: triageDraft.userQuery || '',
          assistantAnswer: triageDraft.assistantAnswer,
          issueType: triageIssueType,
          userComment: triageComment.trim(),
          expectedAnswer: triageExpectedAnswer.trim() || null,
          modelName: 'chat-model',
          routingMode: payloadRoutingMode,
          departmentCode: payloadDepartmentCode,
          assignedToUserId: payloadAssignedToUserId,
          targetRoleCode: payloadTargetRoleCode,
        }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) throw new Error(data?.error?.message || t('chat.failedEscalate'));
      showToast(t('chat.issueEscalated'), 'success');
      setTriageDraft(null);
    } catch (error: any) {
      showToast(error?.message || t('chat.failedEscalate'), 'error');
    } finally { setTriageSubmitting(false); }
  };

  const stopGeneration = () => {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    setIsTyping(false);
    setMessages(prev => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (lastMsg?.type === 'bot' && !lastMsg.content) updated[updated.length - 1] = { ...lastMsg, content: t('chat.generationStopped'), generationStatus: 'Cancelled' };
      return updated;
    });
    showToast(t('chat.generation'), 'info');
  };

  const clearChat = () => {
    setMessages([{ id: '1', type: 'bot', content: t('chat.askQuestion'), timestamp: new Date() }]);
    setCurrentChatId(null);
    setFieldSort(0);
    showToast(t('chat.chatSaved'), 'success');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape' && isTyping) stopGeneration();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    onUserTyping?.(true);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => onUserTyping?.(false), 800);
  };

  const regenerateAt = (botMessageId: string) => {
    if (isTyping) return;
    const idx = messages.findIndex(m => m.id === botMessageId);
    if (idx <= 0) return;
    const prevUser = [...messages].slice(0, idx).reverse().find(m => m.type === 'user');
    if (!prevUser) return;
    showToast(t('chat.regen'), 'info');
    handleSend(prevUser.content);
  };

  return (
    <div className="flex h-full flex-col md:flex-row mac-root">
      {showExportDialog && (
        <ChatExport
          messages={messages.map(m => ({ role: m.type === 'user' ? 'user' : 'assistant', content: m.content, timestamp: m.timestamp?.toLocaleTimeString() }))}
          chatTitle={chatList.find(c => c.id === currentChatId)?.title || 'Chat Export'}
          onClose={() => setShowExportDialog(false)}
        />
      )}

      <ConfirmDialog
        isOpen={confirmDelete !== null}
        title="Delete Chat"
        message={`Are you sure you want to delete "${confirmDelete?.title || 'this chat'}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            try {
              if (confirmDelete.id) {
                await deleteTaskOutput(confirmDelete.id);
                setChatList(prev => prev.filter(c => c.id !== confirmDelete.id));
                if (currentChatId === confirmDelete.id) startNewChat();
                showToast(t('chat.chatDeleted'), 'success');
              } else {
                clearChat();
                showToast(t('chat.chatCleared'), 'success');
              }
            } catch { showToast('Failed to delete chat', 'error'); }
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      <div className="flex-1 flex flex-col h-full bg-transparent mac-window">
        <div className="flex-1 overflow-y-auto p-3 space-y-4 mac-glass-surface mac-scroll">
          {Array.isArray(messages) && messages.map((message, messageIndex) => {
            // Track whether this is the very first bot welcome message
            const isInitialMessage = messageIndex === 0 && message.type === 'bot';
            return (
              <div
                key={message.id}
                className={`flex gap-3 ${message.type === 'user' ? 'flex-row-reverse' : 'flex-row'} animate-fadeIn`}
              >
                <div
                  className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
                  style={message.type === 'user' ? { background: '#1e228a' } : undefined}
                >
                  {message.type === 'user' ? (
                    <User className="w-5 h-5 text-white" />
                  ) : (
                    <Bot className="w-5 h-5 text-[#1e228a] dark:text-[#00ccff]" />
                  )}
                </div>

                <div className={`min-w-0 flex-1 max-w-full sm:max-w-[80%] md:max-w-[60%] ${message.type === 'user' ? 'items-end' : 'items-start'} flex flex-col gap-2`}>
                  <div className={['px-4 py-3 min-w-0 max-w-full mac-glass-bubble', message.type === 'user' ? 'mac-glass-user' : 'mac-glass-bot'].join(' ')}>
                    {message.type === 'bot' ? (
                      message.content ? (
                        (() => {
                          try {
                            const parsed = parseDualLanguageContent(message.content);
                            return (
                              <>
                                <DualLanguageMessage
                                  content={parsed}
                                  taskOutputId={message.taskOutputId}
                                  isInitialMessage={isInitialMessage}
                                />
                                {/* CHANGE: No action buttons on initial welcome message */}
                                {!isInitialMessage && (
                                  <MessageActions
                                    content={message.content}
                                    messageId={message.id}
                                    onFeedback={(id, fb) => {
                                      handleFeedback(id, fb, message.taskOutputId);
                                      if (fb === 'dislike') openTriageForMessage(id, message.taskOutputId, message.content);
                                      showToast(fb === 'like' ? t('chat.like') : t('chat.dislike'), 'success');
                                    }}
                                    onRegenerate={() => regenerateAt(message.id)}
                                    onEditResend={() => { setInput(message.content); inputRef.current?.focus(); }}
                                  />
                                )}
                              </>
                            );
                          } catch (error) {
                            console.error('Error rendering message:', error);
                            return (
                              <>
                                <div className="space-y-3">
                                  <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-slate-900 dark:text-slate-100">
                                    {message.content}
                                  </p>
                                  <DualLanguageMessage
                                    content={{ isDualLanguage: false, isSingleLanguage: false, rawContent: message.content, content: message.content }}
                                    taskOutputId={message.taskOutputId}
                                    isInitialMessage={isInitialMessage}
                                  />
                                </div>
                                {!isInitialMessage && (
                                  <MessageActions
                                    content={message.content}
                                    messageId={message.id}
                                    onFeedback={(id, fb) => {
                                      handleFeedback(id, fb, message.taskOutputId);
                                      if (fb === 'dislike') openTriageForMessage(id, message.taskOutputId, message.content);
                                      showToast(fb === 'like' ? t('chat.like') : t('chat.dislike'), 'success');
                                    }}
                                    onRegenerate={() => regenerateAt(message.id)}
                                    onEditResend={() => { setInput(message.content); inputRef.current?.focus(); }}
                                  />
                                )}
                              </>
                            );
                          }
                        })()
                      ) : (
                        <div className="space-y-2">
                          <div className="flex gap-1">
                            <div className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                            <div className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                            <div className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                          </div>
                          {message.generationStatus && (
                            <p className="text-xs text-slate-600 dark:text-slate-300">{message.generationStatus}...</p>
                          )}
                        </div>
                      )
                    ) : (
                      <div className="group/msg relative">
                        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-slate-900 dark:text-slate-100 pr-9">
                          {message.content}
                        </p>
                        {message.type === 'user' && !isTyping && (
                          <button
                            onClick={() => { setInput(message.content); inputRef.current?.focus(); }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#1e228a] hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition-colors"
                            title={t('chat.editResend')}
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {message.type === 'bot' && message.generationStatus && (
                    <div className="px-2 text-xs text-slate-500 dark:text-slate-400">
                      {t('chat.status')}: {message.generationStatus}
                    </div>
                  )}

                  {message.type === 'bot' && message.kpi && (
                    <div className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/40 dark:bg-white/5 px-3 py-2 text-xs text-slate-700 dark:text-slate-200">
                      <div className="font-semibold mb-1">{t('chat.kpiMetrics')}</div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        <span>{t('chat.kpi.total')}</span><span>{formatMs(message.kpi.totalMs)}</span>
                        <span>{t('chat.kpi.ttft')}</span><span>{formatMs(message.kpi.ttftMs)}</span>
                        <span>{t('chat.kpi.queue')}</span><span>{formatMs(message.kpi.queueMs)}</span>
                        <span>{t('chat.kpi.pollCycles')}</span><span>{message.kpi.pollCycles ?? '-'}</span>
                        <span>{t('chat.kpi.backendTotal')}</span><span>{formatMs(message.kpi.backend?.totalMs)}</span>
                        <span>{t('chat.kpi.rag')}</span><span>{formatMs(message.kpi.backend?.ragMs)}</span>
                        <span>{t('chat.kpi.llm')}</span><span>{formatMs(message.kpi.backend?.llmMs)}</span>
                        <span>{t('chat.kpi.title')}</span><span>{formatMs(message.kpi.backend?.titleMs)}</span>
                        <span>{t('chat.kpi.retrieval')}</span><span>{formatMs(message.kpi.backend?.retrievalMs)}</span>
                      </div>
                    </div>
                  )}

                  {message.source && (
                    <SourceCitation
                      document={message.source.document}
                      page={message.source.page}
                      excerpt={message.content.slice(0, 100)}
                      onClick={() => setPdfPreview({ filename: message.source!.document, page: message.source!.page, highlight: message.content.slice(0, 50) })}
                    />
                  )}

                  <span className="text-xs text-slate-500 dark:text-slate-400 px-2 hidden sm:inline">
                    {message.timestamp.toLocaleTimeString()}
                  </span>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {pdfPreview && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setPdfPreview(null)} />
            <div className="relative w-full max-w-4xl">
              <PDFPreview filename={pdfPreview.filename} pageNumber={pdfPreview.page} highlightText={pdfPreview.highlight} onClose={() => setPdfPreview(null)} />
            </div>
          </div>
        )}

        {/*
          CHANGE: Bottom bar redesigned:
          - Removed "Enter to send / Shift+Enter newline / Esc to stop" hint text
          - Buttons (New, Delete, Export, Stop) placed BEFORE the textarea in a row
          - Export button is directly adjacent to textarea
        */}
        <div className="p-4 mac-inputbar">
          <div className="flex gap-2 items-end">
            {/* Action buttons before textarea */}
            <div className="flex items-center gap-2 flex-shrink-0 self-center">
              <button onClick={startNewChat} className="mac-toolbarbtn" title={t('chat.newChat')}>
                <Plus className="w-4 h-4" />
              </button>
              <button
                onClick={() => setConfirmDelete({ id: currentChatId || '', title: chatList.find(c => c.id === currentChatId)?.title || t('chat.deleteChat') })}
                className="mac-toolbarbtn"
                title={t('chat.clearHistory')}
              >
                <Trash2 className="w-4 h-4" />
              </button>
              {/* CHANGE: Export button now immediately before textarea */}
              <button onClick={() => setShowExportDialog(true)} className="mac-toolbarbtn" title={t('chat.exportChat')}>
                <Download className="w-4 h-4" />
              </button>
              {isTyping && (
                <button onClick={stopGeneration} className="mac-stopbtn" title={`${t('chat.stop')} (Esc)`}>
                  <StopCircle className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Textarea */}
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={t('chat.askQuestion')}
                rows={1}
                className="mac-textarea"
                style={{ minHeight: '48px', maxHeight: '150px' }}
              />
            </div>

            {/* Send button */}
            <button onClick={() => handleSend()} disabled={!input.trim() || isTyping} className="mac-sendbtn self-end">
              <Send className="w-5 h-5" />
              <span className="hidden sm:inline">{t('chat.send')}</span>
            </button>
          </div>

          {/* CHANGE: Removed Enter/Shift+Enter/Esc keyboard hint row entirely */}
          {input.length > 0 && (
            <div className="flex justify-end mt-1">
              <span className="text-xs text-slate-500 dark:text-slate-400">{input.length} chars</span>
            </div>
          )}
        </div>

        {/*
          CHANGE: Triage modal — now uses a true fixed full-screen overlay with backdrop-filter blur
          so the entire app behind it blurs, and the dialog is perfectly centered on the whole screen.
        */}
        {triageDraft && (
          <div className="triage-overlay">
            <div className="triage-modal">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">{t('chat.escalateIssue')}</h3>
              <div className="space-y-3">
                <div>
                  <label className="text-sm font-medium text-slate-600 dark:text-slate-300 mb-1 block">{t('chat.issueType')}</label>
                  <select value={triageIssueType} onChange={(e) => setTriageIssueType(e.target.value)} className="triage-select">
                    <option value="incorrectAnswer">{t('chat.triageIssueType.incorrectAnswer')}</option>
                    <option value="missingContext">{t('chat.triageIssueType.missingContext')}</option>
                    <option value="wrongCitation">{t('chat.triageIssueType.wrongCitation')}</option>
                    <option value="offTopic">{t('chat.triageIssueType.offTopic')}</option>
                    <option value="other">{t('chat.triageIssueType.other')}</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-600 dark:text-slate-300 mb-1 block">{t('chat.escalationMode')}</label>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                      <input
                        type="radio"
                        name="triageRoutingMode"
                        value="AUTO"
                        checked={triageRoutingMode === 'AUTO'}
                        onChange={() => setTriageRoutingMode('AUTO')}
                        className="w-4 h-4 accent-[#1e228a] dark:accent-[#00ccff]"
                      />
                      {t('chat.escalationModeAuto')}
                    </label>
                    <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                      <input
                        type="radio"
                        name="triageRoutingMode"
                        value="SUPER_ADMIN"
                        checked={triageRoutingMode === 'SUPER_ADMIN'}
                        onChange={() => setTriageRoutingMode('SUPER_ADMIN')}
                        className="w-4 h-4 accent-[#1e228a] dark:accent-[#00ccff]"
                      />
                      {t('chat.escalationModeSuperAdmin')}
                    </label>
                    <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                      <input
                        type="radio"
                        name="triageRoutingMode"
                        value="HR_ADMIN"
                        checked={triageRoutingMode === 'HR_ADMIN'}
                        onChange={() => setTriageRoutingMode('HR_ADMIN')}
                        className="w-4 h-4 accent-[#1e228a] dark:accent-[#00ccff]"
                      />
                      {t('chat.escalationModeHrAdmin')}
                    </label>
                    <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                      <input
                        type="radio"
                        name="triageRoutingMode"
                        value="GA_ADMIN"
                        checked={triageRoutingMode === 'GA_ADMIN'}
                        onChange={() => setTriageRoutingMode('GA_ADMIN')}
                        className="w-4 h-4 accent-[#1e228a] dark:accent-[#00ccff]"
                      />
                      {t('chat.escalationModeGaAdmin')}
                    </label>
                    <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                      <input
                        type="radio"
                        name="triageRoutingMode"
                        value="ACC_ADMIN"
                        checked={triageRoutingMode === 'ACC_ADMIN'}
                        onChange={() => setTriageRoutingMode('ACC_ADMIN')}
                        className="w-4 h-4 accent-[#1e228a] dark:accent-[#00ccff]"
                      />
                      {t('chat.escalationModeAccAdmin')}
                    </label>
                  </div>
                </div>
                {triageLoadingAssignees && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('common.loading')}</p>
                )}
                <div>
                  <label className="text-sm font-medium text-slate-600 dark:text-slate-300 mb-1 block">{t('chat.whatsProblem')}</label>
                  <textarea value={triageComment} onChange={(e) => setTriageComment(e.target.value)} rows={4} className="triage-textarea" placeholder={t('chat.describeProblem')} />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-600 dark:text-slate-300 mb-1 block">{t('chat.expectedAnswer')}</label>
                  <textarea value={triageExpectedAnswer} onChange={(e) => setTriageExpectedAnswer(e.target.value)} rows={3} className="triage-textarea" placeholder={t('chat.whatShouldCorrectBe')} />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-5">
                <button onClick={() => setTriageDraft(null)} className="triage-cancel-btn">{t('common.cancel')}</button>
                <button onClick={submitTriage} disabled={triageSubmitting || !triageComment.trim()} className="triage-submit-btn">
                  {triageSubmitting ? t('common.submitting') : t('chat.escalate')}
                </button>
              </div>
            </div>
          </div>
        )}

        <style>{`
          .mac-root {
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
          }

          /* Page background */
          .mac-window { background: #ffffff; }
          .dark .mac-window { background: #0f1724; }

          /* Chat scroll area */
          .mac-glass-surface { background: #ffffff; border-top: 1px solid rgba(0,0,0,0.05); }
          .dark .mac-glass-surface { background: #0f1724; border-top: 1px solid rgba(255,255,255,0.06); }

          /* =============================================
             GLASSMORPHISM CHAT BUBBLES
             Light: white bg with subtle shadow, dark text
             Dark: single cyan #00CCFF with transparency,
                   white text, glass blur, rounded + shadow
             ============================================= */

          /* Light mode base bubble */
          .mac-glass-bubble {
            position: relative;
            border-radius: 18px;
            overflow: hidden;
            background: rgba(255,255,255,0.90);
            border: 1px solid rgba(220,225,235,0.60);
            box-shadow: 0 2px 8px rgba(0,0,0,0.07);
            backdrop-filter: none;
            -webkit-backdrop-filter: none;
          }
          .mac-glass-bubble,
          .mac-glass-bubble * {
            max-width: 100%;
            min-width: 0;
          }
          .mac-glass-bubble p,
          .mac-glass-bubble li,
          .mac-glass-bubble span {
            overflow-wrap: anywhere;
            word-break: break-word;
          }

          /* Light — user bubble */
          .mac-glass-user {
            background: rgba(235,242,255,0.92);
            border-color: rgba(190,215,255,0.55);
          }

          /* Light — bot bubble */
          .mac-glass-bot {
            background: rgba(255,255,255,0.92);
            border-color: rgba(225,228,235,0.65);
          }

          /* Dark mode — ALL bubbles: single cyan glassmorphism, no gradients */
          .dark .mac-glass-bubble,
          .dark .mac-glass-user,
          .dark .mac-glass-bot {
            background: rgba(0,204,255,0.14) !important;
            border: 1px solid rgba(0,204,255,0.30) !important;
            box-shadow: 0 8px 28px rgba(0,0,0,0.35), inset 0 1px 0 rgba(0,204,255,0.18) !important;
            backdrop-filter: blur(20px) saturate(140%) !important;
            -webkit-backdrop-filter: blur(20px) saturate(140%) !important;
            border-radius: 18px !important;
          }

          /* Dark — ensure all text inside bubbles is bright white */
          .dark .mac-glass-bubble p,
          .dark .mac-glass-user p,
          .dark .mac-glass-bot p,
          .dark .mac-glass-bubble span,
          .dark .mac-glass-user span,
          .dark .mac-glass-bot span {
            color: #ffffff !important;
          }

          /* Scrollbar */
          .mac-scroll::-webkit-scrollbar { width: 10px; }
          .mac-scroll::-webkit-scrollbar-thumb {
            background: rgba(0,0,0,0.18);
            border-radius: 999px;
            border: 3px solid transparent;
            background-clip: content-box;
          }
          .dark .mac-scroll::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.18);
            border: 3px solid transparent;
            background-clip: content-box;
          }

          /* Bottom input bar */
          .mac-inputbar {
            border-top: 1px solid rgba(0,0,0,0.06);
            background: rgba(255,255,255,0.55);
            backdrop-filter: blur(26px) saturate(140%);
            -webkit-backdrop-filter: blur(26px) saturate(140%);
            box-shadow: 0 -12px 30px rgba(15,23,42,0.06);
          }
          .dark .mac-inputbar {
            border-top: 1px solid rgba(255,255,255,0.10);
            background: rgba(10,10,10,0.35);
            backdrop-filter: blur(30px) saturate(150%);
            -webkit-backdrop-filter: blur(30px) saturate(150%);
            box-shadow: 0 -14px 40px rgba(0,0,0,0.35);
          }

          /* Toolbar buttons */
          .mac-toolbarbtn {
            padding: 8px;
            border-radius: 10px;
            border: 1px solid rgba(0,0,0,0.08);
            background: rgba(255,255,255,0.60);
            color: rgba(15,23,42,0.70);
            backdrop-filter: blur(16px) saturate(140%);
            -webkit-backdrop-filter: blur(16px) saturate(140%);
            transition: transform .15s ease, background .15s ease;
          }
          .mac-toolbarbtn:hover { background: rgba(255,255,255,0.75); transform: translateY(-1px); }
          .mac-toolbarbtn:active { transform: translateY(0) scale(0.98); }
          .dark .mac-toolbarbtn { border-color: rgba(255,255,255,0.10); background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.78); }
          .dark .mac-toolbarbtn:hover { background: rgba(255,255,255,0.12); }

          .mac-stopbtn {
            padding: 8px;
            border-radius: 10px;
            border: 1px solid rgba(239,68,68,0.25);
            background: rgba(239,68,68,0.10);
            color: rgba(239,68,68,0.9);
            display: inline-flex;
            align-items: center;
            gap: 4px;
          }

          /* Textarea */
          .mac-textarea {
            width: 100%;
            padding: 12px 14px;
            border-radius: 14px;
            border: 1px solid rgba(0,0,0,0.10);
            background: rgba(255,255,255,0.65);
            color: rgba(15,23,42,0.92);
            outline: none;
            resize: none;
            backdrop-filter: blur(18px) saturate(140%);
            -webkit-backdrop-filter: blur(18px) saturate(140%);
            box-shadow: 0 10px 28px rgba(15,23,42,0.06), inset 0 1px 0 rgba(255,255,255,0.55);
          }
          .mac-textarea:focus { border-color: rgba(30,34,138,0.45); box-shadow: 0 0 0 4px rgba(30,34,138,0.10); }
          .dark .mac-textarea { border-color: rgba(255,255,255,0.12); background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.90); box-shadow: 0 12px 34px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08); }
          .dark .mac-textarea:focus { border-color: rgba(0,204,255,0.45); box-shadow: 0 0 0 4px rgba(0,204,255,0.18); }

          /* Send button */
          .mac-sendbtn {
            padding: 12px 16px;
            border-radius: 14px;
            border: 1px solid #1e228a;
            background: #1e228a;
            color: white;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: transform .15s ease, background .15s ease, opacity .15s ease;
            white-space: nowrap;
          }
          .mac-sendbtn:hover { background: #161a5a; transform: translateY(-1px); }
          .mac-sendbtn:active { transform: translateY(0) scale(0.98); }
          .mac-sendbtn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
          .dark .mac-sendbtn { border-color: rgba(0,204,255,0.40); background: rgba(0,204,255,0.25); color: #ffffff; }
          .dark .mac-sendbtn:hover { background: rgba(0,204,255,0.35); }

          /* Icon action buttons inside messages */
          .mac-iconbtn {
            padding: 6px;
            border-radius: 10px;
            border: 1px solid rgba(0,0,0,0.08);
            background: rgba(255,255,255,0.60);
            color: rgba(15,23,42,0.70);
            transition: transform .15s ease, background .15s ease;
          }
          .mac-iconbtn:hover { background: rgba(255,255,255,0.75); transform: translateY(-1px); }
          .mac-iconbtn:active { transform: translateY(0) scale(0.98); }
          .dark .mac-iconbtn { border-color: rgba(255,255,255,0.10); background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.85); }
          .dark .mac-iconbtn:hover { background: rgba(255,255,255,0.12); }
          .mac-iconbtn-active-good { background: rgba(16,185,129,0.18) !important; border-color: rgba(16,185,129,0.24) !important; color: rgba(16,185,129,0.95) !important; }
          .mac-iconbtn-active-bad { background: rgba(239,68,68,0.16) !important; border-color: rgba(239,68,68,0.22) !important; color: rgba(239,68,68,0.95) !important; }

          /* Secondary buttons (translate etc.) */
          .mac-secondary {
            display: inline-flex; align-items: center; gap: 8px;
            padding: 8px 10px; border-radius: 12px;
            border: 1px solid rgba(0,0,0,0.08);
            background: rgba(255,255,255,0.55);
            color: rgba(15,23,42,0.78);
            font-size: 13px;
          }
          .mac-secondary:hover { background: rgba(255,255,255,0.72); }
          .dark .mac-secondary { border-color: rgba(0,204,255,0.20); background: rgba(0,204,255,0.10); color: rgba(255,255,255,0.86); }
          .dark .mac-secondary:hover { background: rgba(0,204,255,0.16); }

          /* Translation panel */
          .mac-panel {
            border-radius: 14px;
            border: 1px solid rgba(0,0,0,0.08);
            background: rgba(255,255,255,0.60);
            backdrop-filter: blur(22px) saturate(140%);
            -webkit-backdrop-filter: blur(22px) saturate(140%);
            box-shadow: 0 12px 32px rgba(15,23,42,0.08);
          }
          .dark .mac-panel {
            border-color: rgba(0,204,255,0.20);
            background: rgba(0,204,255,0.10);
            backdrop-filter: blur(26px) saturate(150%);
            -webkit-backdrop-filter: blur(26px) saturate(150%);
            box-shadow: 0 18px 48px rgba(0,0,0,0.45);
          }

          /* =================================================
             TRIAGE MODAL — true fullscreen centered + blur
             The overlay covers the ENTIRE viewport (position:fixed, inset:0)
             backdrop-filter blurs everything behind it including sidebar/header
             ================================================= */
          .triage-overlay {
            position: fixed;
            inset: 0;
            z-index: 9999;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            background: rgba(0,0,0,0.45);
            backdrop-filter: blur(8px) saturate(120%);
            -webkit-backdrop-filter: blur(8px) saturate(120%);
          }

          .triage-modal {
            width: 100%;
            max-width: 520px;
            border-radius: 20px;
            padding: 28px 24px;
            background: rgba(255,255,255,0.94);
            border: 1px solid rgba(0,0,0,0.10);
            box-shadow: 0 40px 100px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.08);
            backdrop-filter: blur(30px) saturate(150%);
            -webkit-backdrop-filter: blur(30px) saturate(150%);
            animation: triage-appear 0.22s cubic-bezier(0.22,0.95,0.36,1) both;
          }
          .dark .triage-modal {
            background: rgba(15,23,36,0.92);
            border-color: rgba(0,204,255,0.25);
            box-shadow: 0 40px 100px rgba(0,0,0,0.55), 0 2px 8px rgba(0,204,255,0.10);
          }

          @keyframes triage-appear {
            from { opacity:0; transform: translateY(20px) scale(0.96); }
            to   { opacity:1; transform: translateY(0) scale(1); }
          }

          .triage-select {
            width: 100%;
            border-radius: 10px;
            border: 1px solid rgba(0,0,0,0.10);
            background: rgba(255,255,255,0.75);
            color: rgba(15,23,42,0.90);
            padding: 10px 12px;
            outline: none;
            font-size: 14px;
          }
          .triage-select:focus { border-color: #1e228a; box-shadow: 0 0 0 3px rgba(30,34,138,0.12); }
          .dark .triage-select { background: rgba(255,255,255,0.08); border-color: rgba(0,204,255,0.20); color: rgba(255,255,255,0.90); }
          .dark .triage-select:focus { border-color: rgba(0,204,255,0.50); box-shadow: 0 0 0 3px rgba(0,204,255,0.14); }

          .triage-textarea {
            width: 100%;
            border-radius: 10px;
            border: 1px solid rgba(0,0,0,0.10);
            background: rgba(255,255,255,0.75);
            color: rgba(15,23,42,0.90);
            padding: 10px 12px;
            outline: none;
            resize: vertical;
            font-size: 14px;
            font-family: inherit;
          }
          .triage-textarea:focus { border-color: #1e228a; box-shadow: 0 0 0 3px rgba(30,34,138,0.12); }
          .triage-textarea::placeholder { color: rgba(15,23,42,0.35); }
          .dark .triage-textarea { background: rgba(255,255,255,0.08); border-color: rgba(0,204,255,0.20); color: rgba(255,255,255,0.90); }
          .dark .triage-textarea:focus { border-color: rgba(0,204,255,0.50); box-shadow: 0 0 0 3px rgba(0,204,255,0.14); }
          .dark .triage-textarea::placeholder { color: rgba(255,255,255,0.30); }

          .triage-cancel-btn {
            padding: 10px 18px; border-radius: 10px;
            border: 1px solid rgba(0,0,0,0.10);
            background: rgba(255,255,255,0.65);
            color: rgba(15,23,42,0.75);
            font-size: 14px; font-weight: 500; cursor: pointer;
            transition: background .15s ease;
          }
          .triage-cancel-btn:hover { background: rgba(255,255,255,0.85); }
          .dark .triage-cancel-btn { border-color: rgba(255,255,255,0.12); background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.80); }
          .dark .triage-cancel-btn:hover { background: rgba(255,255,255,0.12); }

          .triage-submit-btn {
            padding: 10px 20px; border-radius: 10px;
            border: 1px solid #1e228a; background: #1e228a;
            color: white; font-size: 14px; font-weight: 600; cursor: pointer;
            transition: background .15s ease, transform .15s ease, opacity .15s ease;
          }
          .triage-submit-btn:hover { background: #161a5a; transform: translateY(-1px); }
          .triage-submit-btn:disabled { opacity: .50; cursor: not-allowed; transform: none; }
          .dark .triage-submit-btn { border-color: rgba(0,204,255,0.40); background: rgba(0,204,255,0.25); }
          .dark .triage-submit-btn:hover { background: rgba(0,204,255,0.38); }
          /* =================================================
   TRIAGE SELECT — FIX DARK MODE DROPDOWN OPTIONS
   ================================================= */

/* Light mode options (keep default look) */
.triage-select option {
  background: #ffffff;
  color: #0f172a;
}

/* Dark mode dropdown list background + text */
.dark .triage-select option {
  background: #1f2937;      /* slate-800 / light grey dark surface */
  color: #ffffff;           /* white text for visibility */
}

/* Optional: hover/selected state (browser-dependent) */
.dark .triage-select option:checked,
.dark .triage-select option:hover {
  background: #334155;      /* slate-700 */
  color: #ffffff;
}

          .mac-primary {
            padding: 10px 14px; border-radius: 12px;
            border: 1px solid #1e228a; background: #1e228a;
            color: white; font-weight: 600;
          }
          .dark .mac-primary { background: rgba(0,204,255,0.25); color: #ffffff; border-color: rgba(0,204,255,0.30); }

          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to   { opacity: 1; transform: translateY(0); }
          }
          .animate-fadeIn { animation: fadeIn 0.3s ease-out; }
        `}</style>
      </div>
    </div>
  );
}
