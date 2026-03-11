import KrdGenTaskOutput from '@/mysql/model/gen_task_output.model';
import { IGenTaskOutputSer } from '@/types/genTaskOutput';
import { put, queryList } from '@/utils/mapper';
import { openaiClient } from '@/service/openai_client';
import { Op } from 'sequelize';
import {
  buildDirectContextAnswerPrompt,
  buildEvidenceExtractionPrompt,
  buildGroundedAnswerPrompt,
  groundedNoEvidenceReply,
  NO_EVIDENCE_FOUND_TOKEN,
} from '@/rag/generation/promptBuilder';
import { hasJapaneseChars } from '@/rag/language/detectLanguage';
import { translateText } from '@/utils/translation';
import { publishChatStreamEvent } from '@/service/chatStreamService';

const LLM_EMPTY_CIRCUIT_BREAKER_ENABLED =
  String(process.env.RAG_LLM_EMPTY_CIRCUIT_BREAKER || '1') !== '0';
const LLM_EMPTY_CIRCUIT_BREAKER_THRESHOLD = Math.max(
  1,
  Number(process.env.RAG_LLM_EMPTY_CIRCUIT_BREAKER_THRESHOLD || 2),
);
const LLM_EMPTY_CIRCUIT_BREAKER_COOLDOWN_MS = Math.max(
  10000,
  Number(process.env.RAG_LLM_EMPTY_CIRCUIT_BREAKER_COOLDOWN_MS || 120000),
);
const LLM_STREAM_FLUSH_INTERVAL_MS = Math.max(
  80,
  Number(process.env.RAG_STREAM_FLUSH_INTERVAL_MS || 180),
);
const LLM_STREAM_FLUSH_MIN_CHARS = Math.max(
  24,
  Number(process.env.RAG_STREAM_FLUSH_MIN_CHARS || 120),
);
const LLM_STREAM_CANCEL_CHECK_INTERVAL_MS = Math.max(
  120,
  Number(process.env.RAG_STREAM_CANCEL_CHECK_INTERVAL_MS || 350),
);
const LLM_FALLBACK_STREAM_CHUNK_CHARS = Math.max(
  12,
  Number(process.env.RAG_STREAM_FALLBACK_CHUNK_CHARS || 42),
);
const MAX_LLM_LATENCY_MS = Math.max(
  60000,
  Number(
    process.env.RAG_LLM_TIMEOUT_MS ||
    process.env.RAG_LLM_FAILFAST_TIMEOUT_MS ||
    60000,
  ),
);
const MAX_LLM_STREAM_IDLE_TIMEOUT_MS = Math.max(
  MAX_LLM_LATENCY_MS,
  Number(process.env.RAG_LLM_STREAM_IDLE_TIMEOUT_MS || MAX_LLM_LATENCY_MS),
);
const RAG_LLM_REASONING_EFFORT = String(
  process.env.RAG_LLM_REASONING_EFFORT ||
  process.env.LLM_REASONING_EFFORT ||
  'low',
).trim();

let llmEmptyStreak = 0;
let llmCircuitOpenUntil = 0;
const outputTaskIdCache = new Map<number, string>();
const llmTtftByOutputId = new Map<number, number>();
const ACTIVE_OUTPUT_STATUSES = new Set(['WAIT', 'IN_PROCESS', 'PROCESSING']);

const buildRagLlmExtraBody = (): Record<string, any> | undefined => {
  const extraBody: Record<string, any> = {};
  if (RAG_LLM_REASONING_EFFORT) {
    extraBody.reasoning_effort = RAG_LLM_REASONING_EFFORT;
  }
  return Object.keys(extraBody).length > 0 ? extraBody : undefined;
};

const isLikelyTimeoutError = (error: any): boolean => {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('aborted') ||
    message.includes('aborterror') ||
    message.includes('timed out')
  );
};

export const consumeLlmTtftMs = (outputId?: number): number | undefined => {
  const id = Number(outputId || 0);
  if (!Number.isFinite(id) || id <= 0) return undefined;
  const value = llmTtftByOutputId.get(id);
  llmTtftByOutputId.delete(id);
  return Number.isFinite(value as number) ? Number(value) : undefined;
};

const resolveTaskIdForOutput = async (outputId?: number): Promise<string> => {
  const id = Number(outputId || 0);
  if (!Number.isFinite(id) || id <= 0) return '';
  const cached = outputTaskIdCache.get(id);
  if (cached) return cached;
  try {
    const [output] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: id } });
    const taskId = String(output?.task_id || '').trim();
    if (taskId) outputTaskIdCache.set(id, taskId);
    return taskId;
  } catch {
    return '';
  }
};

const isOutputStillWritable = async (outputId?: number): Promise<boolean> => {
  const id = Number(outputId || 0);
  if (!Number.isFinite(id) || id <= 0) return false;
  try {
    const [output] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: id } });
    const status = String(output?.status || '').trim().toUpperCase();
    return ACTIVE_OUTPUT_STATUSES.has(status);
  } catch {
    return false;
  }
};

export type CallLLMInput = {
  messages: any[];
  temperature?: number;
  outputId?: number;
  modelOverride?: string;
  numPredictOverride?: number;
  retryOnEmpty?: boolean;
  chatMaxPredict: number;
  extraBody?: Record<string, any>;
};

export const callLLM = async ({
  messages,
  temperature = 0.5,
  outputId,
  modelOverride,
  numPredictOverride,
  retryOnEmpty = true,
  chatMaxPredict,
  extraBody,
}: CallLLMInput): Promise<string> => {
  void modelOverride;
  try {
    const maxTokens = Number(numPredictOverride || chatMaxPredict);
    const effectiveExtraBody = extraBody ?? buildRagLlmExtraBody();

    if (outputId) {
      let content = '';
      let cancelled = false;
      let missingOutput = false;
      let streamFailed = false;
      let streamTimedOut = false;
      let taskIdForStream = await resolveTaskIdForOutput(outputId);
      let charsSinceFlush = 0;
      let lastFlushAt = Date.now();
      let lastCancelCheckAt = 0;
      const requestStartedAt = Date.now();
      let ttftCaptured = false;
      if (taskIdForStream) {
        await publishChatStreamEvent(taskIdForStream, 'status', {
          status: 'PROCESSING',
          outputId,
          message: 'Generating response...',
        }).catch(() => undefined);
      }

      const flushProgress = async (opts?: { forceWrite?: boolean; forceCheckCancel?: boolean }) => {
        if (cancelled || missingOutput) return;
        const now = Date.now();
        const forceWrite = Boolean(opts?.forceWrite);
        const forceCheckCancel = Boolean(opts?.forceCheckCancel);
        const shouldCheckCancel =
          forceCheckCancel || (now - lastCancelCheckAt >= LLM_STREAM_CANCEL_CHECK_INTERVAL_MS);

        if (shouldCheckCancel) {
          lastCancelCheckAt = now;
          const [curOutput] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: outputId } });
          if (!curOutput) {
            console.error(`[LLM] Output with ID ${outputId} not found.`);
            missingOutput = true;
            return;
          }
          const outputStatus = String(curOutput.status || '').trim().toUpperCase();
          if (outputStatus === 'CANCEL') {
            await put<IGenTaskOutputSer>(KrdGenTaskOutput, { id: outputId }, {
              status: 'CANCEL',
              update_by: 'JOB',
            });
            cancelled = true;
            return;
          }
          if (!ACTIVE_OUTPUT_STATUSES.has(outputStatus)) {
            cancelled = true;
            return;
          }
        }

        const shouldFlushBySize = charsSinceFlush >= LLM_STREAM_FLUSH_MIN_CHARS;
        const shouldFlushByTime =
          charsSinceFlush > 0 && (now - lastFlushAt >= LLM_STREAM_FLUSH_INTERVAL_MS);
        const shouldWrite = forceWrite || shouldFlushBySize || shouldFlushByTime;
        if (!shouldWrite || charsSinceFlush <= 0) return;

        await put<IGenTaskOutputSer>(
          KrdGenTaskOutput,
          { id: outputId },
          {
            content,
            status: 'PROCESSING',
            update_by: 'JOB',
          },
        );
        charsSinceFlush = 0;
        lastFlushAt = now;
      };

      try {
        const stream = openaiClient.generateStream(messages, {
          temperature,
          max_tokens: maxTokens,
          timeout_ms: MAX_LLM_STREAM_IDLE_TIMEOUT_MS,
          extra_body: effectiveExtraBody,
        });
        for await (const chunk of stream) {
          if (cancelled || missingOutput) break;
          const delta = String(chunk || '');
          if (!delta) continue;
          if (!ttftCaptured) {
            const ttft = Math.max(0, Date.now() - requestStartedAt);
            llmTtftByOutputId.set(Number(outputId), ttft);
            ttftCaptured = true;
          }
          content += delta;
          charsSinceFlush += delta.length;
          if (taskIdForStream) {
            publishChatStreamEvent(taskIdForStream, 'chunk', {
              status: 'PROCESSING',
              outputId,
              delta,
            }).catch(() => undefined);
          }
          await flushProgress();
        }
      } catch (streamError) {
        streamFailed = true;
        streamTimedOut = isLikelyTimeoutError(streamError);
        if (streamTimedOut) {
          console.warn(`[LLM] Streaming request timed out after ${MAX_LLM_STREAM_IDLE_TIMEOUT_MS}ms`);
        }
        console.warn('[LLM] Streaming request failed, switching to non-stream fallback:', (streamError as any)?.message || streamError);
        if (taskIdForStream) {
          await publishChatStreamEvent(taskIdForStream, 'status', {
            status: 'PROCESSING',
            outputId,
            message: 'Generating response... (fallback)',
          }).catch(() => undefined);
        }
      }

      if (!cancelled && !missingOutput) {
        await flushProgress({ forceWrite: true, forceCheckCancel: true });
      }

      if (!cancelled && !String(content || '').trim()) {
        try {
          const fallback = await openaiClient.generate(messages, {
            temperature,
            max_tokens: maxTokens,
            retry_on_empty: retryOnEmpty,
            timeout_ms: MAX_LLM_LATENCY_MS,
            extra_body: effectiveExtraBody,
          });
          const fallbackContent = String(fallback?.content || '');
          if (fallbackContent.trim()) {
            if (!ttftCaptured) {
              const ttft = Math.max(0, Date.now() - requestStartedAt);
              llmTtftByOutputId.set(Number(outputId), ttft);
              ttftCaptured = true;
            }
            const fallbackPieces =
              fallbackContent.match(new RegExp(`([\\s\\S]{1,${LLM_FALLBACK_STREAM_CHUNK_CHARS}})`, 'g')) ||
              [fallbackContent];
            for (const piece of fallbackPieces) {
              if (cancelled || missingOutput) break;
              content += piece;
              charsSinceFlush += String(piece || '').length;
              if (taskIdForStream) {
                publishChatStreamEvent(taskIdForStream, 'chunk', {
                  status: 'PROCESSING',
                  outputId,
                  delta: String(piece || ''),
                }).catch(() => undefined);
              }
              await flushProgress();
            }
            if (!cancelled && !missingOutput) {
              await flushProgress({ forceWrite: true, forceCheckCancel: true });
            }
          }
        } catch (error) {
          if (isLikelyTimeoutError(error)) {
            console.warn(`[LLM] Non-stream fallback timed out after ${MAX_LLM_LATENCY_MS}ms`);
          }
          console.warn('[LLM] Empty stream fallback (non-stream generate) failed:', (error as any)?.message || error);
        }
      }
      if (streamFailed && !String(content || '').trim()) {
        console.warn('[LLM] Stream/fallback both produced empty content.');
      }

      return content;
    }

    try {
      const resp = await openaiClient.generate(messages, {
        temperature,
        max_tokens: maxTokens,
        retry_on_empty: retryOnEmpty,
        timeout_ms: MAX_LLM_LATENCY_MS,
        extra_body: effectiveExtraBody,
      });
      return resp.content;
    } catch (error: any) {
      if (isLikelyTimeoutError(error)) {
        console.warn(`[LLM] Non-stream request timed out after ${MAX_LLM_LATENCY_MS}ms`);
      }
      const message = String(error?.message || error || '');
      const needsStreamFallback =
        /stream options can only be defined when/i.test(message) ||
        /stream_options/i.test(message);
      if (!needsStreamFallback) throw error;

      let content = '';
      const stream = openaiClient.generateStream(messages, {
        temperature,
        max_tokens: maxTokens,
        timeout_ms: MAX_LLM_STREAM_IDLE_TIMEOUT_MS,
        extra_body: effectiveExtraBody,
      });
      for await (const chunk of stream) {
        content += chunk;
      }
      return content;
    }
  } catch (error) {
    console.error('[LLM] callLLM error:', error);
    throw error;
  }
};

export const generateWithLLM = async (
  messages: any[],
  outputId: number,
  chatMaxPredict: number,
): Promise<string> => {
  try {
    console.log(`[generateWithLLM] Starting LLM generation for outputId: ${outputId}`);
    if (LLM_EMPTY_CIRCUIT_BREAKER_ENABLED && Date.now() < llmCircuitOpenUntil) {
      console.warn(
        `[generateWithLLM] Skipping LLM call due to open empty-response circuit breaker (until ${new Date(llmCircuitOpenUntil).toISOString()}).`,
      );
      return '';
    }

    const result = await callLLM({
      messages,
      temperature: 0.1,
      outputId,
      chatMaxPredict,
    });

    if (!String(result || '').trim()) {
      llmEmptyStreak += 1;
      if (
        LLM_EMPTY_CIRCUIT_BREAKER_ENABLED &&
        llmEmptyStreak >= LLM_EMPTY_CIRCUIT_BREAKER_THRESHOLD
      ) {
        llmCircuitOpenUntil = Date.now() + LLM_EMPTY_CIRCUIT_BREAKER_COOLDOWN_MS;
        console.warn(
          `[generateWithLLM] Empty-response circuit breaker opened (streak=${llmEmptyStreak}, cooldownMs=${LLM_EMPTY_CIRCUIT_BREAKER_COOLDOWN_MS}).`,
        );
      }
    } else {
      llmEmptyStreak = 0;
      llmCircuitOpenUntil = 0;
    }

    console.log(`[generateWithLLM] LLM generation completed, result length: ${result?.length || 0}`);
    return String(result || '');
  } catch (error) {
    console.error('[generateWithLLM] LLM generation failed:', error);
    console.error('[generateWithLLM] Error type:', error instanceof Error ? error.message : String(error));
    return '';
  }
};

const extractDocumentContextFromPrompt = (prompt: string): string => {
  const text = String(prompt || '');
  const match = text.match(/(?:RETRIEVED\s+)?DOCUMENT CONTEXT:\s*([\s\S]*)$/i);
  if (!match) return '';
  return String(match[1] || '').trim();
};

type EvidenceChunk = {
  title: string;
  text: string;
};

const EVIDENCE_MAX_CHUNKS = Math.max(
  1,
  Math.min(
    6,
    Number(
      process.env.RAG_EVIDENCE_MAX_CHUNKS ||
      process.env.RAG_MAX_EVIDENCE_CHUNKS ||
      3,
    ),
  ),
);
const EVIDENCE_TRANSLATION_TIMEOUT_MS = Math.max(
  1200,
  Math.min(25000, Number(process.env.RAG_EVIDENCE_TRANSLATION_TIMEOUT_MS || 20000)),
);
const EVIDENCE_TRANSLATION_MAX_CHARS = Math.max(
  600,
  Number(process.env.RAG_EVIDENCE_TRANSLATION_MAX_CHARS || 2600),
);
const DIRECT_CONTEXT_TRANSLATION_MAX_CHUNKS = Math.max(
  1,
  Math.min(2, Number(process.env.RAG_DIRECT_CONTEXT_TRANSLATION_MAX_CHUNKS || 1)),
);
const EVIDENCE_TRANSLATION_MAX_CHUNKS = Math.max(
  0,
  Math.min(3, Number(process.env.RAG_EVIDENCE_TRANSLATION_MAX_CHUNKS || 0)),
);
const EVIDENCE_LINES_TRANSLATION_TIMEOUT_MS = Math.max(
  1500,
  Math.min(25000, Number(process.env.RAG_EVIDENCE_LINES_TRANSLATION_TIMEOUT_MS || 15000)),
);
const EVIDENCE_DIRECT_ANSWER_ENABLED =
  String(process.env.RAG_EVIDENCE_DIRECT_ANSWER_ENABLED || '1') !== '0';
const EVIDENCE_EXTRACTION_ENABLED =
  String(process.env.RAG_EVIDENCE_EXTRACTION_ENABLED || '1') !== '0';
const EVIDENCE_CHUNK_TRANSLATION_ENABLED =
  String(process.env.RAG_EVIDENCE_TRANSLATION_ENABLED || '1') !== '0';
const EVIDENCE_LINES_TRANSLATION_ENABLED =
  String(process.env.RAG_EVIDENCE_LINES_TRANSLATION_ENABLED || '1') !== '0';
const DIRECT_CONTEXT_MIN_ANSWER_CHARS = Math.max(
  24,
  Number(process.env.RAG_DIRECT_CONTEXT_MIN_ANSWER_CHARS || 36),
);
const DIRECT_CONTEXT_RETRY_ON_EMPTY =
  String(process.env.RAG_DIRECT_CONTEXT_RETRY_ON_EMPTY || '0') === '1';
const DIRECT_CONTEXT_RETRY_MAX_TOKENS = Math.max(
  180,
  Number(process.env.RAG_DIRECT_CONTEXT_RETRY_MAX_TOKENS || 520),
);
const EVIDENCE_MIN_LINES_FOR_SYNTHESIS = Math.max(
  1,
  Number(process.env.RAG_EVIDENCE_MIN_LINES_FOR_SYNTHESIS || 2),
);
const EVIDENCE_MIN_LINES_FOR_DIRECT_ANSWER = Math.max(
  EVIDENCE_MIN_LINES_FOR_SYNTHESIS,
  Number(process.env.RAG_EVIDENCE_MIN_LINES_FOR_DIRECT_ANSWER || 3),
);

const EVIDENCE_QUERY_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please',
  'the', 'to', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
  'must', 'should', 'do', 'does', 'did', 'can', 'could', 'would', 'will',
  'employees', 'employee', 'company', 'they', 'them', 'their', 'this', 'that',
]);

const PROCEDURAL_QUERY_PATTERN =
  /(?:\b(?:how|procedure|steps?|apply|request|submit|change|reset|update|correct|what should|what must)\b|手順|方法|申請|対応|どう|手続き)/i;
const FACT_QUESTION_PATTERN =
  /(?:\b(?:how\s+much|upper\s+limit|maximum|cap|limit|amount|fee|price|cost|allowance|daily|monthly|per\s+day|per\s+month)\b|いくら|上限|上限額|限度額|最大|月額|日額|金額|料金|費用)/i;
const FACT_LIMIT_SIGNAL_PATTERN =
  /(?:\b(?:upper\s+limit|maximum|cap|limit|amount|per\s+day|per\s+month|monthly|daily|allowance)\b|上限|上限額|限度額|月額|日額|定期代|通勤手当|交通費)/i;
const FACT_NUMERIC_SIGNAL_PATTERN =
  /(?:\b\d[\d,]*(?:\.\d+)?\s*(?:yen|km|months?|days?)\b|[0-9０-９][0-9０-９,，]*(?:\.[0-9０-９]+)?\s*(?:円|ヶ月|か月|ヵ月|月|日|㎞|km))/i;
const FACT_PART_TIME_SIGNAL_PATTERN =
  /(?:\bpart[-\s]?time\b|\bpart[-\s]?timer(?:s)?\b|パートタイマー|パート社員|パートタイム|短時間勤務)/i;

const parseEvidenceChunks = (context: string): EvidenceChunk[] => {
  const text = String(context || '').trim();
  if (!text) return [];

  const marker = /(?:^|\n)--- Document:\s*(.*?)\s*---\n/g;
  const matches = [...text.matchAll(marker)];
  if (!matches.length) {
    return [{ title: 'Document', text }];
  }

  const chunks: EvidenceChunk[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const title = String(m[1] || 'Document').trim() || 'Document';
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    const chunkText = String(text.slice(start, end) || '').trim();
    if (!chunkText) continue;
    chunks.push({ title, text: chunkText });
  }
  return chunks.length > 0 ? chunks : [{ title: 'Document', text }];
};

const extractQueryTokens = (query: string): string[] => {
  const value = String(query || '').toLowerCase();
  if (!value) return [];
  const english = value
    .split(/[^a-z0-9_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !EVIDENCE_QUERY_STOPWORDS.has(token));
  const japanese = (String(query || '').match(/[\u30a0-\u30ffー]{2,}|[\u3400-\u9fff]{2,}/g) || [])
    .map((token) => token.trim())
    .filter(Boolean);
  return Array.from(new Set([...english, ...japanese])).slice(0, 20);
};

const isAmountOrLimitQuestion = (query: string): boolean =>
  FACT_QUESTION_PATTERN.test(String(query || ''));

const hasFactNumericSignal = (line: string): boolean =>
  FACT_NUMERIC_SIGNAL_PATTERN.test(String(line || ''));

const hasFactLimitSignal = (line: string): boolean =>
  FACT_LIMIT_SIGNAL_PATTERN.test(String(line || ''));

const hasStrongFactEvidenceSignal = (line: string): boolean =>
  hasFactNumericSignal(line) && hasFactLimitSignal(line);

const scoreFactEvidenceLine = (line: string, query: string, queryTokens: string[]): number => {
  const value = String(line || '').trim();
  if (!value) return 0;
  let score = 0;
  const lower = value.toLowerCase();
  for (const token of queryTokens) {
    const normalized = String(token || '').trim().toLowerCase();
    if (!normalized) continue;
    if (lower.includes(normalized)) score += 2;
  }
  if (hasFactLimitSignal(value)) score += 4;
  if (hasFactNumericSignal(value)) score += 5;
  if (hasStrongFactEvidenceSignal(value)) score += 6;
  if (EVIDENCE_ARTICLE_PATTERN.test(value)) score += 1;
  if (FACT_PART_TIME_SIGNAL_PATTERN.test(query) && FACT_PART_TIME_SIGNAL_PATTERN.test(value)) score += 3;
  return score;
};

export const prioritizeFactEvidenceLines = (lines: string[], query: string, limit = 8): string[] => {
  const amountQuestion = isAmountOrLimitQuestion(query);
  const cleaned = sanitizeEvidenceLines(lines);
  if (!amountQuestion || !cleaned.length) return cleaned.slice(0, limit);
  const queryTokens = extractQueryTokens(query);
  return cleaned
    .map((line, index) => ({
      line,
      index,
      score: scoreFactEvidenceLine(line, query, queryTokens),
    }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, limit)
    .map((row) => row.line);
};

const scoreEvidenceChunk = (chunk: EvidenceChunk, tokens: string[], query: string): number => {
  const hay = `${chunk.title}\n${chunk.text}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    const t = String(token || '').trim().toLowerCase();
    if (!t) continue;
    if (/[\u30a0-\u30ffー\u3400-\u9fff]/.test(t)) {
      if (hay.includes(t)) score += 3;
      continue;
    }
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(hay)) score += 2;
    else if (t.length >= 5 && hay.includes(t)) score += 1;
  }
  if (isAmountOrLimitQuestion(query)) {
    const lines = splitPolicyLines(chunk.text);
    const numericLineCount = lines.filter((line) => hasFactNumericSignal(line)).length;
    const limitLineCount = lines.filter((line) => hasFactLimitSignal(line)).length;
    const strongLineCount = lines.filter((line) => hasStrongFactEvidenceSignal(line)).length;
    score += Math.min(3, numericLineCount) * 2;
    score += Math.min(3, limitLineCount) * 2;
    score += Math.min(2, strongLineCount) * 4;
  }
  return score;
};

const selectEvidenceChunks = (query: string, context: string): EvidenceChunk[] => {
  const chunks = parseEvidenceChunks(context);
  if (chunks.length <= EVIDENCE_MAX_CHUNKS) return chunks;
  const queryTokens = extractQueryTokens(query);
  if (!queryTokens.length) return chunks.slice(0, EVIDENCE_MAX_CHUNKS);

  const ranked = chunks
    .map((chunk, idx) => ({
      chunk,
      score: scoreEvidenceChunk(chunk, queryTokens, query),
      idx,
    }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  const selected = ranked
    .slice(0, EVIDENCE_MAX_CHUNKS)
    .sort((a, b) => a.idx - b.idx)
    .map((row) => row.chunk);
  return selected.length > 0 ? selected : chunks.slice(0, EVIDENCE_MAX_CHUNKS);
};

const splitPolicyLines = (text: string): string[] =>
  String(text || '')
    .split(/\r?\n|(?<=[。！？.!?])\s+/)
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

const fallbackAnswerFromChunks = (
  query: string,
  context: string,
  language: 'ja' | 'en',
): string => {
  const chunks = selectEvidenceChunks(query, context).slice(0, 3);
  if (!chunks.length) return groundedNoEvidenceReply(language);

  // Prefer scored policy/obligation lines to avoid returning portal headers.
  const scoredPolicyLines = sanitizeEvidenceLines(
    extractPolicyEvidenceFallback(context, query),
  );
  const candidateLines = chunks
    .flatMap((chunk) => splitPolicyLines(chunk.text))
    .filter((line) => !EVIDENCE_METADATA_PATTERN.test(line))
    .map((line) => String(line || '').trim())
    .filter((line) => line.length >= 8 && line.length <= 220)
    .slice(0, 40);
  const usefulLines = prioritizeFactEvidenceLines(
    scoredPolicyLines.length > 0
      ? scoredPolicyLines
      : sanitizeEvidenceLines(candidateLines),
    query,
    4,
  );
  if (!usefulLines.length) return groundedNoEvidenceReply(language);
  return renderDirectEvidenceAnswer(usefulLines, language) || groundedNoEvidenceReply(language);
};

const buildTranslatedExcerptForEnglish = async (chunk: EvidenceChunk): Promise<{
  excerpt: string;
  translated: boolean;
}> => {
  const sourceText = String(chunk?.text || '').trim();
  if (!sourceText || !hasJapaneseChars(sourceText)) {
    return {
      excerpt: sourceText,
      translated: false,
    };
  }
  const sourceForTranslation = sourceText.slice(0, EVIDENCE_TRANSLATION_MAX_CHARS);
  try {
    const translated = String(
      await translateText(sourceForTranslation, 'en', false, 1, EVIDENCE_TRANSLATION_TIMEOUT_MS) || '',
    ).trim();
    if (!translated || translated.toLowerCase() === sourceForTranslation.toLowerCase()) {
      return { excerpt: sourceText, translated: false };
    }
    return {
      excerpt: [
        `Document title: ${chunk.title}`,
        '',
        'Original excerpt (Japanese):',
        sourceForTranslation,
        '',
        'Translated excerpt (English):',
        translated,
      ].join('\n'),
      translated: true,
    };
  } catch (error) {
    console.warn('[RAG PIPELINE] evidence_translation_failed:', (error as any)?.message || error);
    return { excerpt: sourceText, translated: false };
  }
};

const parseEvidenceLines = (raw: string): string[] => {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (new RegExp(`^\\s*${NO_EVIDENCE_FOUND_TOKEN}\\s*$`, 'i').test(text)) {
    return [];
  }
  const answerMatch = text.match(/answer\s*[:：]\s*([\s\S]*?)(?:\n\s*source\s*[:：]|$)/i);
  const body = String(answerMatch?.[1] || text).trim();
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]\s*|\d+[.)]\s*)?/, '').trim())
    .filter(Boolean)
    .filter((line) => !/^answer\s*[:：]\s*$/i.test(line))
    .filter((line) => !/^source\s*[:：]/i.test(line))
    .filter((line) => !/^document$/i.test(line))
    .filter((line) => !/^step\s*\d+[:.\-]?\s*$/i.test(line))
    .filter((line) => !/^\{.*\}$/.test(line))
    .filter((line) => !new RegExp(`^\\s*${NO_EVIDENCE_FOUND_TOKEN}\\s*$`, 'i').test(line));
  const deduped = Array.from(new Set(lines.map((line) => line.trim())));
  return deduped.slice(0, 12);
};

const EVIDENCE_METADATA_PATTERN =
  /(?:https?:\/\/|www\.|\.pdf\b|\.docx?\b|\.xlsx?\b|(?:^|\s)id\s*\d+\b|^\s*source\s*[:：]|^\s*document\s*[:：]|^\s*section\s*[:：]|^\s*article\s*[:：]|^\s*page\s*[:：]|作成ユーザー|更新ユーザー|作成者|更新者|システム管理者|バックオフィスポータル|^\s*exment\s*[|｜])/i;
const EVIDENCE_POLICY_OBLIGATION_PATTERN =
  /(?:\b(?:must|shall|required|prohibited|return|delete|submit|immediately|without delay)\b|しなければならない|すること|禁止|返還|削除|廃棄|提出|申請|承認|届出|報告|直ちに|速やかに|遅滞なく|義務)/i;
const EVIDENCE_ARTICLE_PATTERN = /(?:第\s*[0-9０-９]+\s*(?:条|項)|article\s*[0-9０-９]+|clause\s*[0-9０-９]+)/i;
const EVIDENCE_DANGLING_END_PATTERN =
  /\b(?:a|an|the|to|for|with|as|of|in|on|at|by|from|and|or|if|when|that|which)\s*\.?$/i;
const EVIDENCE_TRAILING_SYMBOL_PATTERN = /[,:;\/\-]\s*$/;
const EVIDENCE_EN_CONDITIONAL_START_PATTERN = /^(?:once|if|when|after|before|unless|until|while|upon)\b/i;
const EVIDENCE_EN_ACTION_PATTERN = /\b(?:submit|notify|return|provide|delete|apply|record|request|contact|attach|approve|use|complete|enter|report|update|stop|change|inform|follow)\b/i;
const EVIDENCE_JA_ACTION_PATTERN = /(?:提出|申請|届出|報告|返還|返却|削除|廃棄|連絡|通知|確認|記録|更新|変更|停止|実施|入力|承認)/;
const EVIDENCE_UI_FRAGMENT_PATTERN =
  /(?:\b(?:menu|portal|screen|button|search|lookup|list|tab|page)\b|検索|メニュー|画面|ボタン|一覧|タブ|ページ|ポータル)/i;
const EVIDENCE_POLICY_SIGNAL_PATTERN =
  /(?:\b(?:must|shall|required|submit|request|apply|approval|approve|report|record|follow|need(?:ed)?\s+to|employees?|supervisor|attendance|overtime)\b|しなければならない|必要|申請する|承認|提出|届出|報告|記録|従う|規程|規則|就業|賃金|残業|勤怠|上司)/i;
const EVIDENCE_HEADING_PATTERN = /^(?:【[^】]{1,80}】|\[[^\]]{1,80}\])$/;
const EVIDENCE_HEADING_SUFFIX_PATTERN =
  /(?:方法|手順|手続(?:き)?|フロー|概要|procedure|procedures|steps?|workflow|process)$/i;

const isLikelyRawHeadingOrUiLine = (line: string): boolean => {
  const value = String(line || '').replace(/\s+/g, ' ').trim();
  if (!value) return true;
  if (EVIDENCE_HEADING_PATTERN.test(value)) return true;
  const hasSentenceEnding = /[。.!?！？]$/.test(value);
  const shortLine = value.length <= 40;
  if (
    shortLine &&
    !hasSentenceEnding &&
    EVIDENCE_UI_FRAGMENT_PATTERN.test(value) &&
    !EVIDENCE_POLICY_SIGNAL_PATTERN.test(value)
  ) {
    return true;
  }
  if (
    value.length <= 32 &&
    !hasSentenceEnding &&
    EVIDENCE_HEADING_SUFFIX_PATTERN.test(value)
  ) {
    return true;
  }
  return false;
};

const sanitizeChunkTextForGeneration = (text: string): string => {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const rawLines = raw
    .split(/\r?\n+/)
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!rawLines.length) return raw;

  const cleaned = rawLines
    .filter((line) => !EVIDENCE_METADATA_PATTERN.test(line))
    .filter((line) => !isLikelyRawHeadingOrUiLine(line));

  if (!cleaned.length) {
    return rawLines
      .filter((line) => !EVIDENCE_METADATA_PATTERN.test(line))
      .join('\n')
      .trim() || raw;
  }

  const cleanedText = cleaned.join('\n').trim();
  const rawCompactLen = raw.replace(/\s+/g, '').length;
  const cleanedCompactLen = cleanedText.replace(/\s+/g, '').length;
  if (cleanedCompactLen < Math.max(40, Math.floor(rawCompactLen * 0.2))) {
    const conservative = rawLines
      .filter((line) => !EVIDENCE_METADATA_PATTERN.test(line))
      .filter((line) => !EVIDENCE_HEADING_PATTERN.test(line))
      .join('\n')
      .trim();
    return conservative || cleanedText || raw;
  }
  return cleanedText;
};

const sanitizeRetrievedContextForGeneration = (context: string): string => {
  const chunks = parseEvidenceChunks(context);
  if (!chunks.length) return '';
  const rebuilt = chunks
    .map((chunk) => {
      const sanitizedText = sanitizeChunkTextForGeneration(chunk.text);
      if (!sanitizedText) return '';
      return `--- Document: ${chunk.title} ---\n${sanitizedText}`;
    })
    .filter(Boolean)
    .join('\n\n');
  return rebuilt || String(context || '').trim();
};

const buildDirectGenerationContext = async (
  query: string,
  retrievedContext: string,
  userLanguage: 'ja' | 'en',
): Promise<string> => {
  const baseContext = String(retrievedContext || '').trim();
  if (!baseContext) return '';
  if (userLanguage !== 'en' || !hasJapaneseChars(baseContext)) {
    return baseContext;
  }

  const translatedExcerpts: string[] = [];
  const selectedChunks = selectEvidenceChunks(query, baseContext).slice(0, DIRECT_CONTEXT_TRANSLATION_MAX_CHUNKS);
  for (const chunk of selectedChunks) {
    const translatedChunk = await buildTranslatedExcerptForEnglish(chunk);
    if (translatedChunk.translated && translatedChunk.excerpt.trim()) {
      translatedExcerpts.push(translatedChunk.excerpt.trim());
    }
  }

  if (!translatedExcerpts.length) {
    return baseContext;
  }

  return [
    baseContext,
    '',
    'Translated support excerpts (English):',
    ...translatedExcerpts,
  ].join('\n\n').trim();
};

export const extractPolicyEvidenceFallback = (context: string, scoringQuery: string): string[] => {
  const chunks = parseEvidenceChunks(context);
  if (!chunks.length) return [];
  const queryTokens = extractQueryTokens(scoringQuery);
  const amountQuestion = isAmountOrLimitQuestion(scoringQuery);
  const candidates: Array<{ line: string; score: number; hasNumeric: boolean; hasLimit: boolean }> = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const lines = String(chunk.text || '')
      .split(/\r?\n|(?<=[。！？.!?])\s+/)
      .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    for (const line of lines) {
      if (line.length < 8 || line.length > 260) continue;
      if (EVIDENCE_METADATA_PATTERN.test(line)) continue;
      if (isLikelyRawHeadingOrUiLine(line)) continue;
      let score = 0;
      const lower = line.toLowerCase();
      for (const token of queryTokens) {
        const t = String(token || '').trim().toLowerCase();
        if (!t) continue;
        if (lower.includes(t)) score += 2;
      }
      if (EVIDENCE_POLICY_OBLIGATION_PATTERN.test(line)) score += 3;
      if (EVIDENCE_ARTICLE_PATTERN.test(line)) score += 1;
      const hasNumeric = hasFactNumericSignal(line);
      const hasLimit = hasFactLimitSignal(line);
      if (amountQuestion) {
        if (hasNumeric) score += 5;
        if (hasLimit) score += 4;
        if (hasNumeric && hasLimit) score += 6;
      }
      if (score < (amountQuestion ? 2 : 3)) continue;
      const key = lower.replace(/\s+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ line, score, hasNumeric, hasLimit });
    }
  }

  return candidates
    .sort((a, b) =>
      (Number(b.hasNumeric && b.hasLimit) - Number(a.hasNumeric && a.hasLimit)) ||
      (Number(b.hasNumeric) - Number(a.hasNumeric)) ||
      (Number(b.hasLimit) - Number(a.hasLimit)) ||
      (b.score - a.score) ||
      (a.line.length - b.line.length)
    )
    .slice(0, 10)
    .map((row) => row.line);
};

const splitTranslatedEvidenceLines = (text: string): string[] =>
  String(text || '')
    .split(/\r?\n+/)
    .flatMap((line) => String(line || '').split(/(?<=[.!?])\s+/))
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .filter((line) => !/^answer\s*[:：]/i.test(line))
    .filter((line) => !/^source\s*[:：]/i.test(line))
    .slice(0, 12);

const isEvidenceLineUseful = (line: string): boolean => {
  const value = String(line || '').trim();
  if (!value) return false;
  if (EVIDENCE_METADATA_PATTERN.test(value)) return false;
  if (/^document$/i.test(value)) return false;
  if (/^(?:answer|source)$/i.test(value)) return false;
  if (/^step\s*\d+[:.\-]?\s*$/i.test(value)) return false;
  if (/^\{.*\}$/.test(value)) return false;
  if (isLikelyRawHeadingOrUiLine(value)) return false;

  // Keep short CJK obligations, but reject weak Latin placeholders.
  const hasCjk = /[\u3040-\u30ff\u3400-\u9fff]/.test(value);
  if (hasCjk) return value.length >= 6;
  if (EVIDENCE_TRAILING_SYMBOL_PATTERN.test(value)) return false;
  if (EVIDENCE_DANGLING_END_PATTERN.test(value)) return false;
  const doubleQuoteCount = (value.match(/["“”]/g) || []).length;
  if (doubleQuoteCount % 2 === 1) return false;
  const openParen = (value.match(/\(/g) || []).length;
  const closeParen = (value.match(/\)/g) || []).length;
  if (openParen !== closeParen) return false;
  const alphaWords = (value.match(/[a-z]{3,}/gi) || []).length;
  return value.length >= 12 && alphaWords >= 2;
};

const sanitizeEvidenceLines = (lines: string[]): string[] =>
  Array.from(
    new Set(
      (Array.isArray(lines) ? lines : [])
        .map((line) => String(line || '').trim())
        .filter((line) => isEvidenceLineUseful(line)),
    ),
  ).slice(0, 12);

const countStructuredStepLines = (text: string): number =>
  String(text || '')
    .split(/\r?\n+/)
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .filter((line) => /^(?:step\s*\d+[:.]|\d+[.)])/i.test(line))
    .length;

const shouldPreferDeterministicProceduralFallback = (
  query: string,
  answer: string,
  language: 'ja' | 'en',
): boolean => {
  const q = String(query || '').trim();
  const a = String(answer || '').trim();
  if (!q || !a) return false;
  if (!PROCEDURAL_QUERY_PATTERN.test(q)) return false;
  if (a === groundedNoEvidenceReply(language)) return false;
  const stepLines = countStructuredStepLines(a);
  return stepLines < 2;
};

const needsTranslatedEvidenceRetry = (lines: string[]): boolean => {
  const list = Array.isArray(lines) ? lines : [];
  if (list.length === 0) return true;
  const incompleteCount = list.filter((line) => {
    const value = String(line || '').trim();
    if (!value) return true;
    return EVIDENCE_DANGLING_END_PATTERN.test(value) || EVIDENCE_TRAILING_SYMBOL_PATTERN.test(value);
  }).length;
  return incompleteCount > 0;
};

const containsCjk = (value: string): boolean =>
  /[\u3040-\u30ff\u3400-\u9fff]/.test(String(value || ''));

const isCjkDominantLine = (line: string): boolean => {
  const value = String(line || '');
  const cjkChars = (value.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const latinChars = (value.match(/[A-Za-z]/g) || []).length;
  return cjkChars > latinChars;
};

const isLikelyFragmentaryProcedureLine = (line: string): boolean => {
  const value = String(line || '').trim();
  if (!value) return true;
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(value)) return false;
  if (!EVIDENCE_EN_CONDITIONAL_START_PATTERN.test(value)) return false;
  if (/,/.test(value)) return false;
  const lower = value.toLowerCase();
  if (/\b(?:then|must|should|shall|need to|required to)\b/.test(lower)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  return words.length <= 24;
};

const countActionableEvidenceLines = (lines: string[]): number =>
  (Array.isArray(lines) ? lines : []).filter((line) => {
    const value = String(line || '').trim();
    if (!value) return false;
    if (isLikelyFragmentaryProcedureLine(value)) return false;
    if (/[\u3040-\u30ff\u3400-\u9fff]/.test(value)) {
      return EVIDENCE_JA_ACTION_PATTERN.test(value);
    }
    return EVIDENCE_EN_ACTION_PATTERN.test(value);
  }).length;

const canUseDirectEvidenceAnswer = (
  lines: string[],
  language: 'ja' | 'en',
  query?: string,
): boolean => {
  const list = sanitizeEvidenceLines(lines);
  if (isAmountOrLimitQuestion(String(query || ''))) {
    const strongFactLines = list.filter((line) => hasStrongFactEvidenceSignal(line));
    if (strongFactLines.length > 0) {
      if (language === 'en' && strongFactLines.some((line) => isCjkDominantLine(line))) return false;
      return true;
    }
  }
  if (list.length < EVIDENCE_MIN_LINES_FOR_DIRECT_ANSWER) return false;
  if (language === 'en') {
    const dominantCjkLines = list.filter((line) => isCjkDominantLine(line)).length;
    if (dominantCjkLines > 0) return false;
  }
  const actionable = countActionableEvidenceLines(list);
  if (actionable < Math.max(2, Math.min(3, list.length))) return false;
  return true;
};

const renderDirectEvidenceAnswer = (
  lines: string[],
  language: 'ja' | 'en',
): string => {
  const normalizeEnglishMixedLine = (value: string): string => {
    let out = String(value || '').trim();
    if (!out) return '';
    if (containsCjk(out)) {
      // Keep CJK line intact; dropping it creates unreadable fragments.
      return out.replace(/\s{2,}/g, ' ').trim();
    }
    // Keep the instruction while removing untranslated UI-label fragments.
    out = out.replace(/[“"]?[\u3040-\u30ff\u3400-\u9fff]{2,}[”"]?\s*page/gi, 'attendance page');
    out = out.replace(/[（(][^()（）]*[\u3040-\u30ff\u3400-\u9fff][^()（）]*[）)]/g, '');
    out = out.replace(/[“"][\u3040-\u30ff\u3400-\u9fff]{2,}[”"]/g, 'attendance page');
    out = out.replace(/[\u3040-\u30ff\u3400-\u9fff]{2,}/g, '');
    out = out.replace(/\s{2,}/g, ' ').trim();
    return out;
  };
  const normalized = (lines || [])
    .map((line) => String(line || '').trim())
    .filter((line) => isEvidenceLineUseful(line))
    .filter(Boolean)
    .map((line) => {
      let out = line;
      if (language === 'en') {
        out = normalizeEnglishMixedLine(out);
      }
      if (!out) return '';
      if (language === 'en' && !/[.!?]$/.test(out)) return `${out}.`;
      if (language === 'ja' && !/[。！？]$/.test(out)) return `${out}。`;
      return out;
    });
  const filteredNormalized = normalized.filter(Boolean);
  if (!filteredNormalized.length) return '';
  return language === 'ja'
    ? filteredNormalized.join('').replace(/\s+/g, ' ').trim()
    : filteredNormalized.join(' ').replace(/\s+/g, ' ').trim();
};

export type GenerateEvidenceFirstGroundedAnswerInput = {
  query: string;
  queryHints?: string[];
  prompt: string;
  userLanguage: 'ja' | 'en';
  systemPrompt: string;
  chatMaxPredict: number;
  outputId?: number;
  historyMessages?: any[];
};

export const generateEvidenceFirstGroundedAnswer = async ({
  query,
  queryHints,
  prompt,
  userLanguage,
  systemPrompt,
  chatMaxPredict,
  outputId,
  historyMessages,
}: GenerateEvidenceFirstGroundedAnswerInput): Promise<string> => {
  const userQuery = String(query || '').trim();
  const evidenceQuery = Array.from(
    new Set([
      userQuery,
      ...((Array.isArray(queryHints) ? queryHints : []).map((item) => String(item || '').trim())),
    ].filter(Boolean)),
  ).join(' ');
  const retrievedContext = sanitizeRetrievedContextForGeneration(
    extractDocumentContextFromPrompt(prompt),
  );
  if (!userQuery || !retrievedContext) {
    return '';
  }
  const streamTaskId = await resolveTaskIdForOutput(outputId);
  let processingStatusPersisted = false;
  let outputWritable = true;
  const ensureOutputWritable = async (): Promise<boolean> => {
    if (!outputWritable) return false;
    outputWritable = await isOutputStillWritable(outputId);
    return outputWritable;
  };
  const ensureProcessingPersisted = async (): Promise<void> => {
    if (!outputId || processingStatusPersisted) return;
    if (!(await ensureOutputWritable())) return;
    try {
      await put<IGenTaskOutputSer>(
        KrdGenTaskOutput,
        { id: outputId },
        {
          status: 'PROCESSING',
          update_by: 'JOB',
        },
      );
      processingStatusPersisted = true;
    } catch {
      // best effort
    }
  };
  const publishProgressStatus = async (message: string): Promise<void> => {
    if (!(await ensureOutputWritable())) return;
    await ensureProcessingPersisted();
    if (!streamTaskId || !outputId) return;
    await publishChatStreamEvent(streamTaskId, 'status', {
      status: 'PROCESSING',
      outputId,
      message,
    }).catch(() => undefined);
  };
  const publishProgressReplace = async (content: string): Promise<void> => {
    if (!(await ensureOutputWritable())) return;
    await ensureProcessingPersisted();
    if (outputId) {
      await put<IGenTaskOutputSer>(
        KrdGenTaskOutput,
        { id: outputId },
        {
          status: 'PROCESSING',
          content: String(content || ''),
          update_by: 'JOB',
        },
      ).catch(() => undefined);
    }
    if (!streamTaskId || !outputId) return;
    await publishChatStreamEvent(streamTaskId, 'replace', {
      status: 'PROCESSING',
      outputId,
      content: String(content || ''),
    }).catch(() => undefined);
  };

  if (!EVIDENCE_EXTRACTION_ENABLED) {
    let directGenerationContext = String(retrievedContext || '').trim();
    try {
      await publishProgressStatus('Generating response...');
      directGenerationContext = await buildDirectGenerationContext(
        userQuery,
        retrievedContext,
        userLanguage,
      );
      const directPrompt = buildDirectContextAnswerPrompt(
        userQuery,
        directGenerationContext,
        userLanguage,
      );
      const directMessages = [
        { role: 'system', content: systemPrompt },
        ...(Array.isArray(historyMessages) ? historyMessages : []),
        { role: 'user', content: directPrompt },
      ];

      let directAnswer = String(
        await callLLM({
          messages: directMessages,
          temperature: 0.1,
          outputId,
          chatMaxPredict,
        }) || '',
      ).trim();

      const likelyTooShort =
        directAnswer &&
        directAnswer !== groundedNoEvidenceReply(userLanguage) &&
        directAnswer.length < DIRECT_CONTEXT_MIN_ANSWER_CHARS;
      const shouldRetryDirectCall =
        likelyTooShort || (DIRECT_CONTEXT_RETRY_ON_EMPTY && !directAnswer);
      if (shouldRetryDirectCall) {
        const retryPrompt = [
          'Answer only from the provided context.',
          'Summarize the information that directly answers the question.',
          'Preserve important document terminology and do not invent details.',
          `If context is insufficient, return exactly: "${groundedNoEvidenceReply(userLanguage)}"`,
          '',
          `Question:\n${userQuery}`,
          '',
          `Context:\n${directGenerationContext}`,
        ].join('\n');
        const retry = await callLLM({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: retryPrompt },
          ],
          temperature: 0.05,
          outputId,
          chatMaxPredict: Math.min(
            Number(chatMaxPredict || DIRECT_CONTEXT_RETRY_MAX_TOKENS),
            DIRECT_CONTEXT_RETRY_MAX_TOKENS,
          ),
        });
        if (String(retry || '').trim()) {
          directAnswer = String(retry || '').trim();
        }
      }
      if (shouldPreferDeterministicProceduralFallback(userQuery, directAnswer, userLanguage)) {
        const deterministicFallback = fallbackAnswerFromChunks(userQuery, directGenerationContext, userLanguage);
        if (deterministicFallback && deterministicFallback !== groundedNoEvidenceReply(userLanguage)) {
          directAnswer = deterministicFallback;
          console.log('[RAG PIPELINE] direct_context_generation_replaced_with_deterministic_fallback=true');
        }
      }

      if (directAnswer === groundedNoEvidenceReply(userLanguage)) {
        const translatedContextFallback = fallbackAnswerFromChunks(
          userQuery,
          directGenerationContext,
          userLanguage,
        );
        if (translatedContextFallback && translatedContextFallback !== groundedNoEvidenceReply(userLanguage)) {
          directAnswer = translatedContextFallback;
          console.log('[RAG PIPELINE] direct_context_generation_replaced_with_translated_context_fallback=true');
        }
      }

      if (!directAnswer) {
        const fallback = fallbackAnswerFromChunks(userQuery, directGenerationContext, userLanguage);
        await publishProgressReplace(fallback);
        console.log('[RAG PIPELINE] direct_context_generation_empty -> deterministic_fallback');
        return fallback;
      }

      console.log(
        `[RAG PIPELINE] direct_context_generation_applied=true answer_length=${directAnswer.length}`,
      );
      return directAnswer;
    } catch (error) {
      console.error('[RAG PIPELINE] direct_context_generation_error:', error);
      const fallback = fallbackAnswerFromChunks(userQuery, directGenerationContext, userLanguage);
      await publishProgressReplace(fallback);
      return fallback;
    }
  }

  try {
    const selectedChunks = selectEvidenceChunks(evidenceQuery || userQuery, retrievedContext);
    const extractedEvidence: string[] = [];
    const maxEvidenceItems = 16;
    let translatedChunks = 0;
    let lastStreamedPreview = '';
    const streamEvidencePreview = async (lines: string[]): Promise<void> => {
      const safeLines = sanitizeEvidenceLines((Array.isArray(lines) ? lines : []).slice(0, maxEvidenceItems));
      if (!safeLines.length) return;
      if (userLanguage === 'en' && safeLines.some((line) => isCjkDominantLine(line))) {
        return;
      }
      const preview = renderDirectEvidenceAnswer(safeLines, userLanguage);
      if (!preview || preview === lastStreamedPreview) return;
      lastStreamedPreview = preview;
      await publishProgressReplace(preview);
    };
    if (selectedChunks.length > 0) {
      await publishProgressStatus('Building answer...');
    }
    for (let chunkIndex = 0; chunkIndex < selectedChunks.length; chunkIndex += 1) {
      const chunk = selectedChunks[chunkIndex];
      if (extractedEvidence.length >= maxEvidenceItems) break;
      await publishProgressStatus(
        `Building answer... (${Math.min(chunkIndex + 1, selectedChunks.length)}/${selectedChunks.length})`,
      );
      // Stream an immediate deterministic preview so UI is not silent while evidence LLM runs.
      const immediatePreviewLines = sanitizeEvidenceLines(
        extractPolicyEvidenceFallback(
          `--- Document: ${String(chunk.title || 'Document')} ---\n${String(chunk.text || '')}`,
          evidenceQuery || userQuery,
        ).slice(0, 4),
      );
      if (immediatePreviewLines.length > 0 && extractedEvidence.length === 0) {
        await streamEvidencePreview(immediatePreviewLines);
      }
      const shouldTranslateChunk =
        EVIDENCE_CHUNK_TRANSLATION_ENABLED &&
        userLanguage === 'en' &&
        hasJapaneseChars(String(chunk.text || '')) &&
        translatedChunks < EVIDENCE_TRANSLATION_MAX_CHUNKS;
      const preparedChunk = shouldTranslateChunk
        ? await buildTranslatedExcerptForEnglish(chunk)
        : { excerpt: String(chunk.text || '').trim(), translated: false };
      if (preparedChunk.translated) {
        translatedChunks += 1;
      }
      const evidencePrompt = buildEvidenceExtractionPrompt(
        userQuery,
        preparedChunk.excerpt,
        String(chunk.title || 'Document'),
        userLanguage,
      );
      const evidenceRaw = await callLLM({
        messages: [
          {
            role: 'system',
            content:
              'You analyze internal document excerpts and extract grounded answer points. Never invent details or return generic filler.',
          },
          { role: 'user', content: evidencePrompt },
        ],
        temperature: 0,
        retryOnEmpty: false,
        chatMaxPredict: Math.max(140, Math.min(420, Number(chatMaxPredict || 240))),
      });
      const lines = parseEvidenceLines(evidenceRaw);
      let recoveredLines = sanitizeEvidenceLines(lines);
      if (lines.length > 0 && recoveredLines.length === 0) {
        console.log(
          `[RAG PIPELINE] evidence_quality_filter_dropped_all title="${String(chunk.title || '').slice(0, 120)}" raw_count=${lines.length}`,
        );
      }
      const shouldRetryWithTranslatedChunk =
        EVIDENCE_CHUNK_TRANSLATION_ENABLED &&
        userLanguage === 'en' &&
        hasJapaneseChars(String(chunk.text || '')) &&
        !preparedChunk.translated &&
        needsTranslatedEvidenceRetry(recoveredLines);
      if (shouldRetryWithTranslatedChunk) {
        const translatedRetryChunk = await buildTranslatedExcerptForEnglish(chunk);
        if (translatedRetryChunk.translated) {
          const translatedRetryPrompt = buildEvidenceExtractionPrompt(
            userQuery,
            translatedRetryChunk.excerpt,
            String(chunk.title || 'Document'),
            userLanguage,
          );
          const translatedRetryRaw = await callLLM({
            messages: [
              {
                role: 'system',
                content:
                  'You analyze internal document excerpts and extract complete, grounded answer points. Never return clipped, generic, or partial lines.',
              },
              { role: 'user', content: translatedRetryPrompt },
            ],
            temperature: 0,
            retryOnEmpty: false,
            chatMaxPredict: Math.max(140, Math.min(420, Number(chatMaxPredict || 240))),
          });
          const translatedRetryLines = sanitizeEvidenceLines(parseEvidenceLines(translatedRetryRaw));
          if (String(translatedRetryRaw || '').trim() && translatedRetryLines.length === 0) {
            console.log(
              `[RAG PIPELINE] evidence_quality_filter_dropped_retry title="${String(chunk.title || '').slice(0, 120)}"`,
            );
          }
          if (translatedRetryLines.length > 0) {
            recoveredLines = translatedRetryLines;
            console.log(
              `[RAG PIPELINE] evidence_chunk_retry_translated title="${String(chunk.title || '').slice(0, 120)}" evidence_count=${recoveredLines.length}`,
            );
          }
        }
      }
      if (recoveredLines.length === 0) {
        const deterministicChunkEvidence = extractPolicyEvidenceFallback(
          `--- Document: ${String(chunk.title || 'Document')} ---\n${String(chunk.text || '')}`,
          evidenceQuery || userQuery,
        );
        if (deterministicChunkEvidence.length > 0) {
          recoveredLines = sanitizeEvidenceLines(deterministicChunkEvidence.slice(0, 6));
          console.log(
            `[RAG PIPELINE] evidence_chunk_rule_fallback title="${String(chunk.title || '').slice(0, 120)}" count=${recoveredLines.length}`,
          );
        }
      }
      console.log(
        `[RAG PIPELINE] evidence_chunk_result title="${String(chunk.title || '').slice(0, 120)}" translated=${preparedChunk.translated} evidence_count=${recoveredLines.length}`,
      );
      for (const line of recoveredLines) {
        if (extractedEvidence.length >= maxEvidenceItems) break;
        if (extractedEvidence.includes(line)) continue;
        extractedEvidence.push(line);
      }
      if (recoveredLines.length > 0) {
        await streamEvidencePreview(extractedEvidence);
      }
    }

    let evidenceLines = extractedEvidence.slice(0, maxEvidenceItems);
    if (evidenceLines.length === 0) {
      // Final fallback on full context before declaring no evidence.
      await publishProgressStatus('Building answer... (fallback evidence pass)');
      const fallbackPrompt = buildEvidenceExtractionPrompt(
        userQuery,
        retrievedContext,
        'Retrieved Context',
        userLanguage,
      );
      const fallbackRaw = await callLLM({
        messages: [
          {
            role: 'system',
            content:
              'You analyze internal document excerpts and extract relevant grounded answer points even when wording differs from the question. Use only supplied text.',
          },
          { role: 'user', content: fallbackPrompt },
        ],
        temperature: 0,
        retryOnEmpty: false,
        chatMaxPredict: Math.max(140, Math.min(420, Number(chatMaxPredict || 240))),
      });
      evidenceLines = sanitizeEvidenceLines(parseEvidenceLines(fallbackRaw));
      if (evidenceLines.length > 0) {
        await streamEvidencePreview(evidenceLines);
      }
    }
    if (evidenceLines.length === 0) {
      const deterministicEvidence = extractPolicyEvidenceFallback(
        retrievedContext,
        evidenceQuery || userQuery,
      );
      if (deterministicEvidence.length > 0) {
        let fallbackLines = deterministicEvidence;
        if (userLanguage === 'en' && deterministicEvidence.some((line) => hasJapaneseChars(line))) {
          if (!EVIDENCE_CHUNK_TRANSLATION_ENABLED) {
            console.log('[RAG PIPELINE] evidence_rule_fallback_translation_skipped flag_off');
            fallbackLines = deterministicEvidence;
          } else {
            try {
              const translatedFallback = String(
                await translateText(
                  deterministicEvidence.join('\n'),
                  'en',
                  false,
                  0,
                  Math.max(2400, Math.min(20000, EVIDENCE_TRANSLATION_TIMEOUT_MS + 3000)),
                ) || '',
              ).trim();
              const translatedLines = splitTranslatedEvidenceLines(translatedFallback);
              if (translatedLines.length > 0) {
                fallbackLines = translatedLines;
                console.log(`[RAG PIPELINE] evidence_rule_fallback_translated count=${translatedLines.length}`);
              }
            } catch (error) {
              console.warn('[RAG PIPELINE] evidence_rule_fallback_translation_failed:', (error as any)?.message || error);
            }
          }
        }
        evidenceLines = fallbackLines;
        console.log(`[RAG PIPELINE] evidence_rule_fallback_applied count=${evidenceLines.length}`);
        if (evidenceLines.length > 0) {
          await streamEvidencePreview(evidenceLines);
        }
      }
    }
    if (evidenceLines.length > 0 && evidenceLines.length < EVIDENCE_MIN_LINES_FOR_SYNTHESIS) {
      await publishProgressStatus('Building answer... (expanding evidence)');
      const expansionPrompt = buildEvidenceExtractionPrompt(
        userQuery,
        retrievedContext,
        'Retrieved Context',
        userLanguage,
      );
      const expansionRaw = await callLLM({
        messages: [
          {
            role: 'system',
            content:
              'Extract complete grounded answer points from the supplied text. Do not return partial clauses.',
          },
          { role: 'user', content: expansionPrompt },
        ],
        temperature: 0,
        retryOnEmpty: false,
        chatMaxPredict: Math.max(180, Math.min(560, Number(chatMaxPredict || 300))),
      });
      const expandedLines = sanitizeEvidenceLines(parseEvidenceLines(expansionRaw));
      if (expandedLines.length > 0) {
        const merged = Array.from(new Set([...evidenceLines, ...expandedLines])).slice(0, maxEvidenceItems);
        evidenceLines = sanitizeEvidenceLines(merged);
        await streamEvidencePreview(evidenceLines);
      }
    }
    const preSanitizeCount = evidenceLines.length;
    evidenceLines = sanitizeEvidenceLines(evidenceLines);
    if (preSanitizeCount > 0 && evidenceLines.length === 0) {
      console.log(
        `[RAG PIPELINE] evidence_quality_filter_dropped_final raw_count=${preSanitizeCount}`,
      );
    }

    const deterministicEvidenceFromContext = sanitizeEvidenceLines(
      extractPolicyEvidenceFallback(retrievedContext, evidenceQuery || userQuery),
    );
    if (deterministicEvidenceFromContext.length > 0 && isAmountOrLimitQuestion(evidenceQuery || userQuery)) {
      evidenceLines = prioritizeFactEvidenceLines(
        [...evidenceLines, ...deterministicEvidenceFromContext],
        evidenceQuery || userQuery,
        maxEvidenceItems,
      );
    }

    console.log(
      `[RAG PIPELINE] evidence_extracted=${evidenceLines.length > 0 ? evidenceLines.join(' | ') : NO_EVIDENCE_FOUND_TOKEN}`,
    );
    console.log(`[RAG PIPELINE] evidence_count=${evidenceLines.length}`);

    if (userLanguage === 'en' && evidenceLines.some((line) => isCjkDominantLine(line))) {
      if (!EVIDENCE_LINES_TRANSLATION_ENABLED) {
        console.log('[RAG PIPELINE] evidence_lines_translation_skipped flag_off');
      } else {
      await publishProgressStatus('Building answer... (translating evidence)');
      try {
        const translatedEvidence = String(
          await translateText(
            evidenceLines.join('\n'),
            'en',
            false,
            0,
            EVIDENCE_LINES_TRANSLATION_TIMEOUT_MS,
          ) || '',
        ).trim();
        const translatedLines = sanitizeEvidenceLines(splitTranslatedEvidenceLines(translatedEvidence));
        if (translatedLines.length > 0) {
          evidenceLines = translatedLines;
          await streamEvidencePreview(evidenceLines);
          console.log(`[RAG PIPELINE] evidence_lines_translated count=${translatedLines.length}`);
        } else {
          console.log('[RAG PIPELINE] evidence_lines_translation_skipped reason=empty_result');
        }
      } catch (error) {
        console.warn('[RAG PIPELINE] evidence_lines_translation_failed:', (error as any)?.message || error);
      }
      }
    }

    if (evidenceLines.length === 0) {
      const noEvidence = groundedNoEvidenceReply(userLanguage);
      await publishProgressReplace(noEvidence);
      return noEvidence;
    }

    if (EVIDENCE_DIRECT_ANSWER_ENABLED && canUseDirectEvidenceAnswer(evidenceLines, userLanguage, userQuery)) {
      const direct = renderDirectEvidenceAnswer(evidenceLines, userLanguage);
      if (direct) {
        console.log('[RAG PIPELINE] evidence_direct_answer_applied=true');
        await publishProgressReplace(direct);
        return direct;
      }
    } else if (EVIDENCE_DIRECT_ANSWER_ENABLED) {
      console.log(
        `[RAG PIPELINE] evidence_direct_answer_skipped ${JSON.stringify({
          reason: 'low_quality_or_insufficient_steps',
          evidence_count: evidenceLines.length,
          actionable_count: countActionableEvidenceLines(evidenceLines),
          min_lines_for_direct_answer: EVIDENCE_MIN_LINES_FOR_DIRECT_ANSWER,
          cjk_dominant_lines: evidenceLines.filter((line) => isCjkDominantLine(line)).length,
        })}`,
      );
    }

    const groundedPrompt = buildGroundedAnswerPrompt(userQuery, evidenceLines, userLanguage);
    const finalMessages = [
      { role: 'system', content: systemPrompt },
      ...(Array.isArray(historyMessages) ? historyMessages : []),
      { role: 'user', content: groundedPrompt },
    ];

    await publishProgressStatus('Generating response...');
    let answer = await callLLM({
      messages: finalMessages,
      temperature: 0.1,
      outputId,
      chatMaxPredict,
    });
    if (!String(answer || '').trim() && !outputId) {
      answer = await callLLM({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: groundedPrompt },
        ],
        temperature: 0.1,
        chatMaxPredict,
      });
    }
    console.log(
      `[RAG PIPELINE] grounded_answer_generated=${String(answer || '').trim() ? 'true' : 'false'}`,
    );
    return String(answer || '');
  } catch (error) {
    console.error('[RAG PIPELINE] grounded_answer_generation_error:', error);
    return '';
  }
};
