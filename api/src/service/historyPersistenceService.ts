import { Op, QueryTypes } from 'sequelize';
import ChatHistoryConversation from '@/mysql/model/chat_history_conversation.model';
import ChatHistoryMessage from '@/mysql/model/chat_history_message.model';
import User from '@/mysql/model/user.model';
import seq from '@/mysql/db/seq.db';

export type PersistChatTurnInput = {
  userId: number;
  userName: string;
  departmentCode: string;
  conversationId: string;
  outputId: number;
  userText: string;
  userLanguage: 'ja' | 'en';
  workingQuery?: string;
  assistantText: string;
  ragUsed: boolean;
  sourceIds?: string[];
  tokenInput?: number;
  tokenOutput?: number;
  title?: string;
  metadata?: Record<string, unknown>;
};

const toJson = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
};

const toSourceJson = (sourceIds?: string[]): string => {
  try {
    return JSON.stringify(Array.isArray(sourceIds) ? sourceIds : []);
  } catch {
    return '[]';
  }
};

export function buildHistoryRowsForTurn(input: PersistChatTurnInput) {
  const now = new Date();
  const sourceJson = toSourceJson(input.sourceIds);
  const metadataJson = toJson(input.metadata || {});
  const translatedQuery = input.workingQuery && input.workingQuery !== input.userText ? input.workingQuery : null;

  return {
    conversationUpsert: {
      conversation_id: input.conversationId,
      user_id: input.userId,
      user_name: input.userName,
      department_code: input.departmentCode,
      title: input.title || 'New Chat',
      last_message: input.assistantText,
      updated_at: now,
    },
    userMessage: {
      conversation_id: input.conversationId,
      user_id: input.userId,
      user_name: input.userName,
      department_code: input.departmentCode,
      message_id: `${input.outputId}:user`,
      role: 'user',
      original_text: input.userText,
      detected_language: input.userLanguage,
      translated_text: translatedQuery,
      model_answer_text: null,
      rag_used: input.ragUsed,
      source_ids: sourceJson,
      token_input: input.tokenInput ?? null,
      token_output: null,
      metadata_json: metadataJson,
    },
    assistantMessage: {
      conversation_id: input.conversationId,
      user_id: input.userId,
      user_name: input.userName,
      department_code: input.departmentCode,
      message_id: `${input.outputId}:assistant`,
      role: 'assistant',
      original_text: input.assistantText,
      detected_language: input.userLanguage,
      translated_text: null,
      model_answer_text: input.assistantText,
      rag_used: input.ragUsed,
      source_ids: sourceJson,
      token_input: input.tokenInput ?? null,
      token_output: input.tokenOutput ?? null,
      metadata_json: metadataJson,
    },
  };
}

export async function persistChatTurn(input: PersistChatTurnInput): Promise<void> {
  const rows = buildHistoryRowsForTurn(input);
  await seq.transaction(async (transaction) => {
    const existing = await ChatHistoryConversation.findOne({
      raw: true,
      where: { conversation_id: input.conversationId },
      transaction,
    }) as any;

    if (existing) {
      await ChatHistoryConversation.update(rows.conversationUpsert as any, {
        where: { conversation_id: input.conversationId },
        transaction,
      });
    } else {
      await ChatHistoryConversation.create({
        ...rows.conversationUpsert,
        created_at: new Date(),
      } as any, { transaction });
    }

    await ChatHistoryMessage.findOrCreate({
      where: { message_id: rows.userMessage.message_id },
      defaults: rows.userMessage as any,
      transaction,
    });

    await ChatHistoryMessage.findOrCreate({
      where: { message_id: rows.assistantMessage.message_id },
      defaults: rows.assistantMessage as any,
      transaction,
    });
  });
}

export async function listHistoryConversations(params: {
  userId?: number;
  pageNum: number;
  pageSize: number;
  departmentCode?: string;
}) {
  const limit = Math.max(1, Math.min(100, Number(params.pageSize) || 20));
  const offset = (Math.max(1, Number(params.pageNum) || 1) - 1) * limit;
  const where: any = {
    ...(params.userId != null ? { user_id: params.userId } : {}),
    ...(params.departmentCode ? { department_code: params.departmentCode } : {}),
  };

  const { rows, count } = await ChatHistoryConversation.findAndCountAll({
    raw: true,
    where,
    order: [['updated_at', 'DESC']],
    limit,
    offset,
  });

  const userIds = Array.from(
    new Set(
      (rows as any[])
        .map((row) => Number(row.user_id))
        .filter((id) => Number.isFinite(id)),
    ),
  );
  const userMap = new Map<number, { emp_id?: string; user_name?: string }>();
  if (userIds.length > 0) {
    const users = await User.findAll({
      raw: true,
      attributes: ['user_id', 'emp_id', 'user_name'],
      where: {
        user_id: { [Op.in]: userIds },
      },
    }) as any[];
    for (const u of users) {
      const id = Number(u.user_id);
      if (Number.isFinite(id)) {
        userMap.set(id, { emp_id: u.emp_id || undefined, user_name: u.user_name || undefined });
      }
    }
  }

  return {
    rows: rows.map((row: any) => ({
      conversation_id: row.conversation_id,
      user_id: row.user_id,
      user_name: userMap.get(Number(row.user_id))?.user_name || row.user_name,
      emp_id: userMap.get(Number(row.user_id))?.emp_id || undefined,
      department_code: row.department_code,
      title: row.title,
      last_message: row.last_message,
      updated_at: row.updated_at,
    })),
    total: count,
    page_num: Math.max(1, Number(params.pageNum) || 1),
    page_size: limit,
  };
}

export async function listHistoryUsers(params: {
  query?: string;
  pageNum: number;
  pageSize: number;
}) {
  const limit = Math.max(1, Math.min(100, Number(params.pageSize) || 20));
  const pageNum = Math.max(1, Number(params.pageNum) || 1);
  const offset = (pageNum - 1) * limit;
  const q = String(params.query || '').trim().toLowerCase();
  const hasQuery = q.length > 0;
  const replacements: Record<string, any> = {
    limit,
    offset,
  };
  const filterSql = hasQuery
    ? `AND (
      LOWER(COALESCE(u.emp_id, '')) LIKE :q
      OR LOWER(COALESCE(u.user_name, '')) LIKE :q
      OR CAST(u.user_id AS TEXT) LIKE :q
    )`
    : '';
  if (hasQuery) replacements.q = `%${q}%`;

  const countRows = await seq.query(
    `
      SELECT COUNT(*)::int AS total
      FROM (
        SELECT u.user_id
        FROM "user" u
        INNER JOIN chat_history_conversations c ON c.user_id = u.user_id
        WHERE u.deleted_at IS NULL
        ${filterSql}
        GROUP BY u.user_id
      ) s
    `,
    {
      type: QueryTypes.SELECT,
      replacements,
    },
  ) as any[];

  const rows = await seq.query(
    `
      SELECT
        u.user_id,
        u.emp_id,
        u.user_name,
        u.department_code,
        COUNT(c.conversation_id)::int AS conversation_count,
        MAX(c.updated_at) AS last_activity_at
      FROM "user" u
      INNER JOIN chat_history_conversations c ON c.user_id = u.user_id
      WHERE u.deleted_at IS NULL
      ${filterSql}
      GROUP BY u.user_id, u.emp_id, u.user_name, u.department_code
      ORDER BY MAX(c.updated_at) DESC, u.user_id ASC
      LIMIT :limit OFFSET :offset
    `,
    {
      type: QueryTypes.SELECT,
      replacements,
    },
  ) as any[];

  return {
    rows: rows.map((row: any) => ({
      user_id: Number(row.user_id),
      emp_id: row.emp_id || null,
      user_name: row.user_name || null,
      department_code: row.department_code || null,
      conversation_count: Number(row.conversation_count || 0),
      last_activity_at: row.last_activity_at,
    })),
    total: Number(countRows?.[0]?.total || 0),
    page_num: pageNum,
    page_size: limit,
  };
}

export async function getHistoryMessages(params: {
  userId?: number;
  conversationId: string;
  departmentCode?: string;
}) {
  const conversation = await ChatHistoryConversation.findOne({
    raw: true,
    where: {
      conversation_id: params.conversationId,
      ...(params.userId != null ? { user_id: params.userId } : {}),
      ...(params.departmentCode ? { department_code: params.departmentCode } : {}),
    },
  }) as any;
  if (!conversation) return null;

  const messages = await ChatHistoryMessage.findAll({
    raw: true,
    where: {
      conversation_id: params.conversationId,
      ...(params.userId != null ? { user_id: params.userId } : {}),
      ...(params.departmentCode ? { department_code: params.departmentCode } : {}),
    },
    order: [['created_at', 'ASC']],
  }) as any[];

  return {
    conversation: {
      conversation_id: conversation.conversation_id,
      title: conversation.title,
      updated_at: conversation.updated_at,
    },
    messages: messages.map((m) => ({
      message_id: m.message_id,
      role: m.role,
      original_text: m.original_text,
      detected_language: m.detected_language,
      translated_text: m.translated_text,
      model_answer_text: m.model_answer_text,
      rag_used: !!m.rag_used,
      source_ids: (() => {
        try {
          const raw = m.source_ids;
          return typeof raw === 'string' ? JSON.parse(raw || '[]') : raw || [];
        } catch {
          return [];
        }
      })(),
      token_input: m.token_input,
      token_output: m.token_output,
      metadata: (() => {
        try {
          const raw = m.metadata_json;
          return typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
        } catch {
          return {};
        }
      })(),
      created_at: m.created_at,
    })),
  };
}

export async function deleteConversationHistory(params: {
  userId?: number;
  conversationId: string;
  departmentCode?: string;
}) {
  const where: any = {
    conversation_id: params.conversationId,
    ...(params.userId != null ? { user_id: params.userId } : {}),
    ...(params.departmentCode ? { department_code: params.departmentCode } : {}),
  };
  await seq.transaction(async (transaction) => {
    await ChatHistoryMessage.destroy({
      where,
      transaction,
    });
    await ChatHistoryConversation.destroy({
      where,
      transaction,
    });
  });
}

type FaqItem = {
  question: string;
  answer: string;
  count: number;
  lastAsked: number;
  departmentCode: string;
  sourceCount: number;
  qualityLabel: 'VERIFIED' | 'RELAXED';
};

type FaqAggregate = FaqItem & { answerScore: number };

const FAQ_SEED_ITEMS: Array<{ key: string } & Omit<FaqItem, 'count' | 'lastAsked'>> = [
  {
    key: 'how-to-use-faq',
    question: 'How do I use this FAQ page?',
    answer: 'Use the search box to find a topic, filter by department, and open a question to read the answer.',
    departmentCode: 'OTHER',
    sourceCount: 0,
    qualityLabel: 'RELAXED',
  },
  {
    key: 'faq-empty-department',
    question: 'What if my department has no FAQs yet?',
    answer: 'You will still see general FAQs here. New FAQ entries appear automatically as more repeated questions are collected.',
    departmentCode: 'OTHER',
    sourceCount: 0,
    qualityLabel: 'RELAXED',
  },
  {
    key: 'faq-origin',
    question: 'Where do FAQ items come from?',
    answer: 'FAQ items are built from repeated support questions and validated answer history in the system.',
    departmentCode: 'OTHER',
    sourceCount: 0,
    qualityLabel: 'RELAXED',
  },
  {
    key: 'faq-access-scope',
    question: 'Who can see FAQs?',
    answer: 'Valid users can see FAQs according to their access scope and available FAQ data.',
    departmentCode: 'OTHER',
    sourceCount: 0,
    qualityLabel: 'RELAXED',
  },
];

const FAQ_STOPWORDS_EN = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'can',
  'company',
  'do',
  'does',
  'employee',
  'employees',
  'for',
  'from',
  'get',
  'how',
  'i',
  'in',
  'information',
  'internal',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'policy',
  'process',
  'procedure',
  'regarding',
  'should',
  'tell',
  'the',
  'their',
  'there',
  'these',
  'this',
  'to',
  'us',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
  'would',
  'you',
  'your',
]);

const FAQ_NUMERIC_QUERY_RE = /\b(how many|how much|days?|months?|years?|hours?|minutes?|amount|limit|maximum|minimum|rate|allowance|count)\b|何日|何時間|何年|何か月|いくら|上限|下限|日当|件数|回数/i;
const FAQ_NUMERIC_ANSWER_RE = /\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|day|days|month|months|year|years|hour|hours|minute|minutes|yen|%|％|日|ヶ月|か月|年|時間|分|円|回/i;

const normalizeQuestion = (q: string) =>
  String(q || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeFaqQuestionKey = (q: string) =>
  normalizeQuestion(q)
    .replace(
      /\b(please|pls|can you|could you|would you|tell me|show me|give me|in detail|details?)\b/gi,
      ' ',
    )
    .replace(/\b(how do i|how can i|what is|what are|where can i|where do i)\b/gi, ' ')
    .replace(/(教えてください|教えて|詳しく|具体的に|具体的|について|ですか|ますか|方法|手順)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeFaqText = (value: string) =>
  String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<!--SINGLE_LANG_START-->/g, ' ')
    .replace(/<!--SINGLE_LANG_END-->/g, ' ')
    .replace(/<!--DUAL_LANG_START-->/g, ' ')
    .replace(/<!--DUAL_LANG_END-->/g, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const stripFaqSourceAttribution = (value: string) =>
  normalizeFaqText(value)
    .replace(/\n?SOURCE:\s.*$/is, ' ')
    .replace(/\((matched query|照会語):.*?\)/gi, ' ')
    .replace(/\s*\[(?:\d+(?:\s*,\s*\d+)*)\]\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasJapaneseContent = (value: string) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(String(value || ''));

const buildFaqEnglishTokenSet = (value: string): Set<string> => {
  const tokens = String(value || '')
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /^[a-z0-9]+$/.test(token))
    .map((token) => token.replace(/(?:ing|ed|es|s)$/i, ''))
    .filter((token) => token.length >= 4)
    .filter((token) => !FAQ_STOPWORDS_EN.has(token));
  return new Set(tokens);
};

const buildFaqJapaneseTokens = (value: string): string[] =>
  String(value || '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => hasJapaneseContent(token))
    .filter((token) => token.length >= 2);

const buildFaqQuestionKey = (question: string): string => {
  const normalized = normalizeFaqQuestionKey(question) || normalizeQuestion(question);
  if (!normalized) return '';
  if (!hasJapaneseContent(normalized)) {
    const englishTokens = Array.from(buildFaqEnglishTokenSet(normalized)).sort();
    if (englishTokens.length >= 2) return englishTokens.join(' ');
  }
  return normalized;
};

const isFaqAnswerRelevant = (question: string, answer: string): boolean => {
  const normalizedQuestion = normalizeFaqQuestionKey(question) || normalizeQuestion(question);
  const normalizedAnswer = stripFaqSourceAttribution(answer);
  if (!normalizedQuestion || !normalizedAnswer) return false;

  const questionEnTokens = buildFaqEnglishTokenSet(normalizedQuestion);
  const answerEnTokens = buildFaqEnglishTokenSet(normalizedAnswer);
  const questionEnTokenList = Array.from(questionEnTokens);
  const englishOverlap = questionEnTokenList.filter((token) => answerEnTokens.has(token)).length;
  const highSignalEnglishTokens = questionEnTokenList.filter((token) => token.length >= 8);
  const hasHighSignalEnglishMatch = highSignalEnglishTokens.length === 0
    ? true
    : highSignalEnglishTokens.some((token) => answerEnTokens.has(token));

  const questionJaTokens = buildFaqJapaneseTokens(normalizedQuestion);
  const compactAnswer = normalizedAnswer.replace(/\s+/g, '');
  const japaneseOverlap = questionJaTokens.filter((token) => compactAnswer.includes(token)).length;

  const hasEnglishSignals = questionEnTokens.size > 0;
  const hasJapaneseSignals = questionJaTokens.length > 0;
  const hasOverlap =
    (hasHighSignalEnglishMatch && englishOverlap >= 2) ||
    (hasHighSignalEnglishMatch && hasEnglishSignals && englishOverlap >= Math.ceil(questionEnTokens.size * 0.4)) ||
    japaneseOverlap >= 1;

  if (!hasOverlap && (hasEnglishSignals || hasJapaneseSignals)) return false;
  if (FAQ_NUMERIC_QUERY_RE.test(question) && !FAQ_NUMERIC_ANSWER_RE.test(normalizedAnswer)) return false;
  return true;
};

const isLowValueQuestion = (q: string) => {
  const v = normalizeQuestion(q);
  if (!v) return true;
  if (v.length <= 2) return true;
  if (/\b(hi|hello|hey|test|testing)\b/i.test(v)) return true;
  if (/\bdebug\b|\btrace\b/i.test(v)) return true;
  return false;
};

const isLowValueAnswer = (a: string) => {
  const v = stripFaqSourceAttribution(String(a || '')).toLowerCase();
  if (!v || v.length < 8) return true;
  if (v.includes('[debug]')) return true;
  if (v.includes('i can’t confirm') || v.includes('i cannot confirm')) return true;
  if (v.includes('could you provide') || v.includes('could you specify')) return true;
  if (v.includes('forwarded to the administrator')) return true;
  return false;
};

const scoreAnswerQuality = (answer: string, ragUsed: boolean, sourceCount: number): number => {
  let score = 0;
  const clean = stripFaqSourceAttribution(answer);
  if (clean.length >= 8) score += 1;
  if (!isLowValueAnswer(clean)) score += 2;
  if (ragUsed) score += 1;
  if (sourceCount > 0) score += 3;
  return score;
};

const parseSourceIds = (raw: unknown): string[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return [];
    }
  }
  return [];
};

const collectFaqItems = (
  rows: any[],
  assistantById: Map<string, any>,
  options: {
    minCount: number;
    qualityLabel: 'VERIFIED' | 'RELAXED';
    requireRagUsed: boolean;
    requireSources: boolean;
    skipAnswerRelevance?: boolean;
  },
): FaqItem[] => {
  const map = new Map<string, FaqAggregate>();
  const minCount = Math.max(1, Number(options.minCount) || 1);

  for (const m of rows) {
    const q = normalizeFaqText(String(m.original_text || ''));
    if (isLowValueQuestion(q)) continue;
    const key = buildFaqQuestionKey(q);
    if (!key) continue;

    const outputId = String(m.message_id || '').split(':')[0];
    const assistant = assistantById.get(`${outputId}:assistant`);
    const answer = stripFaqSourceAttribution(
      normalizeFaqText(String(assistant?.model_answer_text || assistant?.original_text || '')),
    );
    if (!answer) continue;

    const ragUsed = Boolean(assistant?.rag_used);
    const sourceIds = parseSourceIds(assistant?.source_ids);
    if (options.requireRagUsed && !ragUsed) continue;
    if (options.requireSources && sourceIds.length === 0) continue;
    if (isLowValueAnswer(answer)) continue;
    if (!options.skipAnswerRelevance && !isFaqAnswerRelevant(q, answer)) continue;

    const lastAsked = new Date(m.created_at || Date.now()).getTime();
    const prev = map.get(key);
    const dept = String(m.department_code || '').toUpperCase() || 'OTHER';
    const nextSourceCount = sourceIds.length;
    const nextQualityLabel = options.qualityLabel;
    const nextAnswerScore = scoreAnswerQuality(answer, ragUsed, nextSourceCount);
    const shouldReplaceAnswer = !prev || nextAnswerScore > prev.answerScore || (nextAnswerScore === prev.answerScore && lastAsked >= prev.lastAsked);

    if (!prev) {
      map.set(key, {
        question: q,
        answer,
        count: 1,
        lastAsked,
        departmentCode: dept,
        sourceCount: nextSourceCount,
        qualityLabel: nextQualityLabel,
        answerScore: nextAnswerScore,
      });
      continue;
    }

    map.set(key, {
      question: lastAsked >= prev.lastAsked ? q : prev.question,
      answer: shouldReplaceAnswer ? answer : prev.answer,
      count: prev.count + 1,
      lastAsked: Math.max(prev.lastAsked, lastAsked),
      departmentCode: lastAsked >= prev.lastAsked ? dept : prev.departmentCode,
      sourceCount: shouldReplaceAnswer ? nextSourceCount : Math.max(prev.sourceCount, nextSourceCount),
      qualityLabel: options.qualityLabel,
      answerScore: Math.max(prev.answerScore, nextAnswerScore),
    });
  }

  return Array.from(map.values())
    .map(({ answerScore, ...item }) => item)
    .sort((a, b) => b.count - a.count || b.lastAsked - a.lastAsked)
    .filter((i) => i.count >= minCount);
};

export async function listFaqItems(params: {
  limit: number;
  minCount: number;
  departmentCode?: string;
  roleCode?: string;
  sampleSize?: number;
  allowedCategories?: string[];
}) {
  const limit = Math.max(1, Math.min(50, Number(params.limit) || 10));
  const minCount = Math.max(1, Number(params.minCount) || 1);
  const sampleSize = Math.max(200, Math.min(5000, Number(params.sampleSize) || 1200));
  const faqLog = (...args: any[]) => console.info('[FAQ]', ...args);
  const includeNonUserRoles = String(process.env.FAQ_INCLUDE_NON_USER_ROLES || '1') === '1';
  const strictRequireSources = String(process.env.FAQ_STRICT_REQUIRE_SOURCES || '1') === '1';
  const strictRequireRag = String(process.env.FAQ_STRICT_REQUIRE_RAG || '1') === '1';
  const relaxedMinCount = Math.max(1, Number(process.env.FAQ_RELAXED_MIN_COUNT || 1));
  const excludedRoleCodes = new Set(
    String(process.env.FAQ_EXCLUDED_ROLE_CODES || '')
      .split(',')
      .map((v) => String(v || '').trim().toUpperCase())
      .filter(Boolean),
  );

  const roleCode = String(params.roleCode || '').toUpperCase();

  // Role-based category access: restrict which department_codes can appear in results.
  // HR FAQs are only visible to SUPER_ADMIN and HR_ADMIN.
  const { departmentToFaqCategory } = await import('@/service/faqAccess');
  const allowedCategories = (params.allowedCategories || ['HR', 'GA', 'ACC', 'OTHERS'])
    .map((c) => String(c || '').toUpperCase());
  const canSeeHR = allowedCategories.includes('HR');

  // Map allowed FAQ categories back to department_codes for DB filtering.
  // FAQ category OTHERS maps to all department_codes except HR, GA, ACC.
  const allowedDeptCodes: string[] = [];
  if (allowedCategories.includes('HR')) allowedDeptCodes.push('HR');
  if (allowedCategories.includes('GA')) allowedDeptCodes.push('GA');
  if (allowedCategories.includes('ACC')) allowedDeptCodes.push('ACC');
  // OTHERS covers: OTHER, SYSTEMS, and any other non-standard code
  const includesOthers = allowedCategories.includes('OTHERS');

  // Build the base where clause that enforces category access.
  const buildWhereBase = () => {
    const whereBase: any = { role: 'user' };
    if (!canSeeHR) {
      // Non-HR users: exclude HR department messages at the DB level.
      whereBase.department_code = { [Op.ne]: 'HR' };
    }
    return whereBase;
  };

  const globalWhere = buildWhereBase();

  type Attempt = {
    stage: string;
    where: any;
    minCount: number;
    qualityLabel: 'VERIFIED' | 'RELAXED';
    requireRagUsed: boolean;
    requireSources: boolean;
    skipAnswerRelevance?: boolean;
  };

  const attempts: Attempt[] = [
    {
      stage: 'global_strict',
      where: globalWhere,
      minCount,
      qualityLabel: 'VERIFIED',
      requireRagUsed: strictRequireRag,
      requireSources: strictRequireSources,
    },
    {
      stage: 'global_relaxed',
      where: globalWhere,
      minCount: relaxedMinCount,
      qualityLabel: 'RELAXED',
      requireRagUsed: false,
      requireSources: false,
      skipAnswerRelevance: true,
    },
  ];

  faqLog('request', {
    roleCode: roleCode || null,
    allowedCategories,
    canSeeHR,
    limit,
    sampleSize,
  });

  const applyOwnerRoleFilters = async (messages: any[]) => {
    const userIds = Array.from(
      new Set(
        messages
          .map((m) => Number(m.user_id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    );
    if (userIds.length === 0) return messages;

    const owners = await User.findAll({
      raw: true,
      attributes: ['user_id', 'role_code'],
      where: {
        user_id: { [Op.in]: userIds },
        deleted_at: null,
      },
    }) as any[];
    const ownerRoleMap = new Map<number, string>();
    for (const owner of owners) {
      ownerRoleMap.set(Number(owner.user_id), String(owner.role_code || 'USER').toUpperCase());
    }
    return messages.filter((m) => {
      const ownerRoleCode = String(ownerRoleMap.get(Number(m.user_id)) || 'USER').toUpperCase();
      if (!includeNonUserRoles && ownerRoleCode !== 'USER') return false;
      if (excludedRoleCodes.has(ownerRoleCode)) return false;
      return true;
    });
  };

  const buildFaqItemsForAttempt = async (attempt: Attempt) => {
    const messages = await ChatHistoryMessage.findAll({
      raw: true,
      where: attempt.where,
      order: [['created_at', 'DESC']],
      limit: sampleSize,
    }) as any[];
    if (!messages.length) {
      faqLog('stage', { stage: attempt.stage, count: 0 });
      return [] as FaqItem[];
    }

    const scopedMessages = await applyOwnerRoleFilters(messages);
    if (!scopedMessages.length) {
      faqLog('stage', { stage: attempt.stage, count: 0, note: 'role_filter_excluded_all' });
      return [] as FaqItem[];
    }

    const outputIds = scopedMessages
      .map((m) => String(m.message_id || '').split(':')[0])
      .filter((v) => v && v !== 'undefined');
    const assistantIds = Array.from(new Set(outputIds.map((id) => `${id}:assistant`)));
    const assistantRows = await ChatHistoryMessage.findAll({
      raw: true,
      where: { message_id: assistantIds },
    }) as any[];
    const assistantById = new Map<string, any>();
    for (const a of assistantRows) assistantById.set(String(a.message_id), a);
    const items = collectFaqItems(scopedMessages, assistantById, {
      minCount: attempt.minCount,
      qualityLabel: attempt.qualityLabel,
      requireRagUsed: attempt.requireRagUsed,
      requireSources: attempt.requireSources,
      skipAnswerRelevance: Boolean(attempt.skipAnswerRelevance),
    });
    faqLog('stage', {
      stage: attempt.stage,
      count: items.length,
      minCount: attempt.minCount,
      qualityLabel: attempt.qualityLabel,
    });
    return items;
  };

  const buildSeedItems = (): FaqItem[] => {
    const now = Date.now();
    return FAQ_SEED_ITEMS.map((item, index) => ({
      ...item,
      count: 1,
      lastAsked: now - (index * 1000),
    }));
  };

  // Safety filter: after collecting FAQ items, remove any whose departmentCode
  // maps to a category the user is not allowed to see (defense in depth).
  const filterByAllowedCategories = (items: FaqItem[]): FaqItem[] => {
    return items.filter((item) => {
      const cat = departmentToFaqCategory(item.departmentCode);
      return allowedCategories.includes(cat);
    });
  };

  let selectedItems: FaqItem[] = [];
  let selectedMode: 'VERIFIED' | 'RELAXED' = 'VERIFIED';
  let fallbackStage = 'none';
  for (const attempt of attempts) {
    const items = await buildFaqItemsForAttempt(attempt);
    const filtered = filterByAllowedCategories(items);
    if (filtered.length > 0) {
      selectedItems = filtered.slice(0, limit);
      selectedMode = attempt.qualityLabel;
      fallbackStage = attempt.stage;
      break;
    }
    fallbackStage = attempt.stage;
  }

  faqLog('result', {
    roleCode: roleCode || null,
    allowedCategories,
    fallbackStage,
    count: selectedItems.length,
  });

  if (selectedItems.length === 0) {
    const seedItems = filterByAllowedCategories(buildSeedItems()).slice(0, limit);
    faqLog('seeded', {
      roleCode: roleCode || null,
      count: seedItems.length,
    });
    return {
      items: seedItems,
      mode: 'SEEDED' as const,
      scope: {
        roleCode: roleCode || null,
        allowedCategories,
      },
      fallbackStage: 'seeded',
      totalCount: seedItems.length,
    };
  }

  return {
    items: selectedItems,
    mode: selectedMode,
    scope: {
      roleCode: roleCode || null,
      allowedCategories,
    },
    fallbackStage,
    totalCount: selectedItems.length,
  };
}
