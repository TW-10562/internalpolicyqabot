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

const isLowValueQuestion = (q: string) => {
  const v = normalizeQuestion(q);
  if (!v) return true;
  if (v.length <= 2) return true;
  if (/\b(hi|hello|hey|test|testing)\b/i.test(v)) return true;
  if (/\bdebug\b|\btrace\b/i.test(v)) return true;
  return false;
};

const isLowValueAnswer = (a: string) => {
  const v = normalizeFaqText(String(a || '')).toLowerCase();
  if (!v || v.length < 8) return true;
  if (v.includes('[debug]')) return true;
  if (v.includes('i can’t confirm') || v.includes('i cannot confirm')) return true;
  if (v.includes('could you provide') || v.includes('could you specify')) return true;
  if (v.includes('forwarded to the administrator')) return true;
  return false;
};

const scoreAnswerQuality = (answer: string, ragUsed: boolean, sourceCount: number): number => {
  let score = 0;
  const clean = normalizeFaqText(answer);
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
  },
): FaqItem[] => {
  const map = new Map<string, FaqAggregate>();
  const minCount = Math.max(1, Number(options.minCount) || 1);

  for (const m of rows) {
    const q = normalizeFaqText(String(m.original_text || ''));
    if (isLowValueQuestion(q)) continue;
    const key = normalizeFaqQuestionKey(q) || normalizeQuestion(q);
    if (!key) continue;

    const outputId = String(m.message_id || '').split(':')[0];
    const assistant = assistantById.get(`${outputId}:assistant`);
    const answer = normalizeFaqText(String(assistant?.model_answer_text || assistant?.original_text || ''));
    if (!answer) continue;

    const ragUsed = Boolean(assistant?.rag_used);
    const sourceIds = parseSourceIds(assistant?.source_ids);
    if (options.requireRagUsed && !ragUsed) continue;
    if (options.requireSources && sourceIds.length === 0) continue;
    if (isLowValueAnswer(answer)) continue;

    const lastAsked = new Date(m.created_at || Date.now()).getTime();
    const prev = map.get(key);
    const dept = String(m.department_code || '').toUpperCase() || 'HR';
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
}) {
  const limit = Math.max(1, Math.min(50, Number(params.limit) || 10));
  const minCount = Math.max(1, Number(params.minCount) || 1);
  const sampleSize = Math.max(200, Math.min(5000, Number(params.sampleSize) || 1200));
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

  const whereBase: any = { role: 'user' };
  const roleCode = String(params.roleCode || '').toUpperCase();
  if (roleCode === 'HR_ADMIN') {
    // HR admin: HR FAQ only
    whereBase.department_code = 'HR';
  } else if (roleCode === 'GA_ADMIN') {
    // GA admin: GA FAQ only
    whereBase.department_code = 'GA';
  } else if (roleCode === 'ACC_ADMIN') {
    // ACC admin: ACC FAQ only
    whereBase.department_code = 'ACC';
  } else if (roleCode === 'USER') {
    // User: scope FAQ to current department when available.
    if (params.departmentCode) {
      whereBase.department_code = params.departmentCode;
    }
  } else if (params.departmentCode) {
    whereBase.department_code = params.departmentCode;
  }

  const userMessages = await ChatHistoryMessage.findAll({
    raw: true,
    where: whereBase,
    order: [['created_at', 'DESC']],
    limit: sampleSize,
  }) as any[];

  if (!userMessages.length) {
    return { items: [] as FaqItem[] };
  }

  // Optional role scoping for FAQ pool. Default keeps real usage from all roles.
  const userIds = Array.from(
    new Set(
      userMessages
        .map((m) => Number(m.user_id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );
  let scopedMessages = userMessages;
  if (userIds.length > 0) {
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
    scopedMessages = userMessages.filter((m) => {
      const ownerRoleCode = String(ownerRoleMap.get(Number(m.user_id)) || 'USER').toUpperCase();
      if (!includeNonUserRoles && ownerRoleCode !== 'USER') return false;
      if (excludedRoleCodes.has(ownerRoleCode)) return false;
      return true;
    });
  }
  if (!scopedMessages.length) {
    return { items: [] as FaqItem[] };
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
  const strictItems = collectFaqItems(scopedMessages, assistantById, {
    minCount,
    qualityLabel: 'VERIFIED',
    requireRagUsed: strictRequireRag,
    requireSources: strictRequireSources,
  });

  if (strictItems.length >= limit) {
    return { items: strictItems.slice(0, limit), mode: 'STRICT' as const };
  }

  const relaxedItems = collectFaqItems(scopedMessages, assistantById, {
    minCount: relaxedMinCount,
    qualityLabel: 'RELAXED',
    requireRagUsed: false,
    requireSources: false,
  });
  const merged: FaqItem[] = [];
  const seenKeys = new Set<string>();
  for (const item of strictItems) {
    const key = normalizeFaqQuestionKey(item.question) || normalizeQuestion(item.question);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push(item);
    if (merged.length >= limit) break;
  }
  for (const item of relaxedItems) {
    if (merged.length >= limit) break;
    const key = normalizeFaqQuestionKey(item.question) || normalizeQuestion(item.question);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push(item);
  }

  if (merged.length > 0) {
    return {
      items: merged.slice(0, limit),
      mode: strictItems.length > 0 ? ('HYBRID' as const) : ('RELAXED' as const),
    };
  }

  return { items: strictItems.slice(0, limit), mode: 'STRICT' as const };
}
