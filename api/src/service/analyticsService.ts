import { Op, Sequelize } from 'sequelize';
import AnalyticsEvent from '@/mysql/model/analytics_event.model';
import User from '@/mysql/model/user.model';
import File from '@/mysql/model/file.model';
import { analyzeModeration, ModerationReason } from '@/service/contentModeration';
import { normalizeDepartmentCode } from '@/service/rbac';
import { noEvidenceReply } from '@/rag/generation/promptBuilder';
import { parseDualLanguageOutput } from '@/utils/translation';

type TimeRange = '7d' | '30d' | '90d';

type QueryEventInput = {
  taskId?: string;
  taskOutputId?: number;
  userId?: number;
  userName?: string;
  departmentCode?: string;
  status: 'FINISHED' | 'FAILED';
  responseMs?: number;
  ragUsed?: boolean;
  queryText?: string;
  answerText?: string;
  metadata?: Record<string, unknown>;
};

type FeedbackEventInput = {
  taskOutputId?: number;
  userId?: number;
  userName?: string;
  departmentCode?: string;
  cacheSignal: 0 | 1;
  query?: string;
  answer?: string;
  metadata?: Record<string, unknown>;
};

const QUERY_EVENT = 'QUERY_PROCESSED';
const FEEDBACK_EVENT = 'FEEDBACK_SUBMITTED';
const CONTENT_FLAG_EVENT = 'CONTENT_FLAGGED';

const toFiniteMs = (value: unknown): number | undefined => {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return undefined;
  return n;
};

const parseMetadata = (raw: unknown): Record<string, unknown> => {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
};

const extractOrganicRetrievalMsFromMeta = (metaRaw: unknown): number | undefined => {
  const meta = parseMetadata(metaRaw);
  const direct = toFiniteMs(meta.retrievalMs);
  if (direct != null) return direct;

  const solrMs = toFiniteMs(meta.solrMs) || 0;
  const rerankMs = toFiniteMs(meta.rerankMs) || 0;
  const candidateMs = toFiniteMs(meta.candidateMs) || 0;
  const intentMs = toFiniteMs(meta.intentMs) || 0;
  const queryTranslationMs = toFiniteMs(meta.queryTranslationMs) || 0;
  const reconstructed = solrMs + rerankMs + candidateMs + intentMs + queryTranslationMs;
  if (reconstructed > 0) return reconstructed;

  const ragMs = toFiniteMs(meta.ragMs);
  if (ragMs != null) return ragMs;
  return undefined;
};

const compactLatin = (value: string) => value.toLowerCase().replace(/[^a-z]/g, '');

const compactJa = (value: string) => value.replace(/[\s。、，,.:;!?！？「」『』【】（）()]/g, '');

const extractAnswerBody = (raw: unknown): string => {
  const text = String(raw || '').trim();
  if (!text) return '';

  const parsed = parseDualLanguageOutput(text);
  if (!parsed.isDualLanguage && parsed.singleContent) return String(parsed.singleContent || '').trim();
  if (parsed.isDualLanguage && parsed.translated) return String(parsed.translated || '').trim();
  if (parsed.isDualLanguage && parsed.japanese) return String(parsed.japanese || '').trim();
  return text;
};

const isNoEvidenceStyleAnswer = (raw: unknown): boolean => {
  const text = extractAnswerBody(raw);
  if (!text) return false;

  const lower = text.toLowerCase();
  const latin = compactLatin(text);
  const ja = compactJa(text);
  const strictNoEvidenceEn = noEvidenceReply('en').toLowerCase();
  const strictNoEvidenceJa = noEvidenceReply('ja');
  const compactStrictNoEvidenceEn = compactLatin(strictNoEvidenceEn);
  const compactStrictNoEvidenceJa = compactJa(strictNoEvidenceJa);

  return (
    lower.includes(strictNoEvidenceEn) ||
    lower.includes('i can’t confirm from the provided documents') ||
    lower.includes("i can't confirm from the provided documents") ||
    lower.includes('i could not find a matching section in internal policy documents') ||
    lower.includes('i could not find relevant information in the available company documents') ||
    /i could not find relevant information in the available .*internal documents/.test(lower) ||
    lower.includes('the requested information was not found in the available company documents') ||
    /the requested information was not found in the available .*internal documents/.test(lower) ||
    text.includes(strictNoEvidenceJa) ||
    text.includes('提供された文書から確認できません') ||
    text.includes('社内文書から該当する記載を確認できません') ||
    text.includes('利用可能な社内文書内で、要求された情報は見つかりませんでした') ||
    /利用可能な.+社内文書内で、要求された情報は見つかりませんでした/.test(text) ||
    latin.includes(compactStrictNoEvidenceEn) ||
    latin.includes('icouldnotfindrelevantinformationintheavailablecompanydocuments') ||
    /icouldnotfindrelevantinformationintheavailable[a-z]+internaldocuments/.test(latin) ||
    latin.includes('therequestedinformationwasnotfoundintheavailablecompanydocuments') ||
    /therequestedinformationwasnotfoundintheavailable[a-z]+internaldocuments/.test(latin) ||
    ja.includes(compactStrictNoEvidenceJa) ||
    /利用可能な.+社内文書内で要求された情報は見つかりませんでした/.test(ja) ||
    ja.includes('利用可能な社内文書内で要求された情報は見つかりませんでした')
  );
};

const isFailedQueryForAnalytics = (status: unknown, answerText: unknown): boolean =>
  String(status || '').toUpperCase() === 'FAILED' || isNoEvidenceStyleAnswer(answerText);

function getRangeStart(range: TimeRange): Date {
  const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

const normalizeStoredDepartmentCode = (value: unknown): string | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return normalizeDepartmentCode(raw);
};

type DepartmentAnalyticsScope = {
  normalizedDepartment: string;
  userIds: number[];
  userNames: string[];
};

const resolveDepartmentAnalyticsScope = async (departmentCode?: string): Promise<DepartmentAnalyticsScope | null> => {
  const normalizedDepartment = normalizeStoredDepartmentCode(departmentCode);
  if (!normalizedDepartment) return null;

  const users = await User.findAll({
    attributes: ['user_id', 'user_name', 'emp_id', 'department', 'department_code'],
    where: { deleted_at: null } as any,
    raw: true,
  }) as any[];

  const scopedUsers = users.filter((row) => (
    normalizeStoredDepartmentCode(row.department_code || row.department) === normalizedDepartment
  ));

  const userIds = Array.from(
    new Set(
      scopedUsers
        .map((row) => Number(row.user_id))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );

  const userNames = Array.from(
    new Set(
      scopedUsers
        .flatMap((row) => [String(row.user_name || '').trim(), String(row.emp_id || '').trim()])
        .filter(Boolean),
    ),
  );

  return {
    normalizedDepartment,
    userIds,
    userNames,
  };
};

const buildScopedEventWhere = (baseWhere: Record<string, unknown>, scope: DepartmentAnalyticsScope | null) => {
  if (!scope) return baseWhere;
  return {
    ...baseWhere,
    [Op.or]: [
      { department_code: scope.normalizedDepartment },
      ...(scope.userIds.length > 0 ? [{ user_id: { [Op.in]: scope.userIds } }] : []),
      ...(scope.userNames.length > 0 ? [{ user_name: { [Op.in]: scope.userNames } }] : []),
    ],
  };
};

export async function recordQueryEvent(input: QueryEventInput) {
  const analyticsFailure = isFailedQueryForAnalytics(input.status, input.answerText);
  const normalizedStatus: QueryEventInput['status'] = analyticsFailure ? 'FAILED' : 'FINISHED';
  const metadata = {
    ...(input.metadata || {}),
    ...(analyticsFailure && input.status !== 'FAILED' ? { analyticsFailureReason: 'NO_RELIABLE_INFORMATION' } : {}),
  };

  await AnalyticsEvent.create({
    event_type: QUERY_EVENT,
    task_id: input.taskId || null,
    task_output_id: input.taskOutputId || null,
    user_id: input.userId || null,
    user_name: input.userName || null,
    department_code: normalizeStoredDepartmentCode(input.departmentCode),
    status: normalizedStatus,
    response_ms: Number.isFinite(input.responseMs) ? Number(input.responseMs) : null,
    rag_used: !!input.ragUsed,
    query_text: input.queryText || null,
    answer_text: input.answerText || null,
    metadata_json: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
  } as any);
}

export async function recordFeedbackEvent(input: FeedbackEventInput) {
  await AnalyticsEvent.create({
    event_type: FEEDBACK_EVENT,
    task_output_id: input.taskOutputId || null,
    user_id: input.userId || null,
    user_name: input.userName || null,
    department_code: normalizeStoredDepartmentCode(input.departmentCode),
    feedback_signal: input.cacheSignal,
    query_text: input.query || null,
    answer_text: input.answer || null,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
  } as any);
}

type ContentFlagEventInput = {
  taskId?: string;
  taskOutputId?: number;
  userId?: number;
  userName?: string;
  departmentCode?: string;
  queryText?: string;
  answerText?: string;
  moderation?: import('@/service/contentModeration').ModerationAnalysis;
};

export async function recordContentFlagEvent(input: ContentFlagEventInput) {
  const moderation = input.moderation || await analyzeModeration(input.queryText, input.answerText);
  if (!moderation.flagged) return;

  await AnalyticsEvent.create({
    event_type: CONTENT_FLAG_EVENT,
    task_id: input.taskId || null,
    task_output_id: input.taskOutputId || null,
    user_id: input.userId || null,
    user_name: input.userName || null,
    department_code: normalizeStoredDepartmentCode(input.departmentCode),
    status: 'FLAGGED',
    query_text: input.queryText || null,
    answer_text: input.answerText || null,
    metadata_json: JSON.stringify({
      score: moderation.score,
      llmAssisted: moderation.llmAssisted,
      detectors: moderation.detectors,
      reasons: moderation.reasons,
    }),
  } as any);
}

export async function getQueryEventMetricsByTaskOutput(taskOutputId: number) {
  if (!Number.isFinite(taskOutputId) || taskOutputId <= 0) return null;
  const row = await AnalyticsEvent.findOne({
    where: {
      event_type: QUERY_EVENT,
      task_output_id: taskOutputId,
    },
    order: [['id', 'DESC']],
    raw: true,
  }) as any;
  if (!row) return null;

  const meta = parseMetadata(row.metadata_json);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(meta || {}, k);
  const metric = (k: string): number | undefined => (has(k) ? (Number(meta?.[k] || 0) || 0) : undefined);
  const retrievalMs = extractOrganicRetrievalMsFromMeta(meta);

  return {
    taskOutputId: Number(row.task_output_id || taskOutputId),
    totalMs: Number(row.response_ms || 0) || undefined,
    ragMs: metric('ragMs'),
    llmMs: metric('llmMs'),
    retrievalMs,
    translationMs: metric('translationMs'),
    queryTranslationMs: metric('queryTranslationMs'),
    titleMs: metric('titleMs'),
    inputTokens: metric('inputTokens'),
    outputTokens: metric('outputTokens'),
    userLanguage: typeof meta?.userLanguage === 'string' ? meta.userLanguage : undefined,
    ragUsed: typeof row.rag_used === 'boolean' ? row.rag_used : undefined,
  };
}

export async function getAnalyticsOverview(range: TimeRange, departmentCode?: string) {
  const startAt = getRangeStart(range);
  const commonWhere: any = { created_at: { [Op.gte]: startAt } };
  const departmentScope = await resolveDepartmentAnalyticsScope(departmentCode);
  const queryWhere = buildScopedEventWhere({ ...commonWhere, event_type: QUERY_EVENT }, departmentScope);
  const feedbackWhere = buildScopedEventWhere({ ...commonWhere, event_type: FEEDBACK_EVENT }, departmentScope);
  const contentFlagWhere = buildScopedEventWhere({ ...commonWhere, event_type: CONTENT_FLAG_EVENT }, departmentScope);

  const fileWhere: any = {};
  if (departmentCode) fileWhere.department_code = normalizeDepartmentCode(departmentCode);

  const [queryRows, ragRows, feedbackRows, totalDocs, docsByDept, flaggedRows] = await Promise.all([
    AnalyticsEvent.findAll({
      attributes: ['user_id', 'user_name', 'status', 'answer_text', 'response_ms', 'metadata_json'],
      where: queryWhere,
      raw: true,
    }),
    AnalyticsEvent.findAll({
      attributes: [
        'rag_used',
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'count'],
      ],
      where: queryWhere,
      group: ['rag_used'],
      raw: true,
    }),
    AnalyticsEvent.findAll({
      attributes: [
        'feedback_signal',
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'count'],
      ],
      where: feedbackWhere,
      group: ['feedback_signal'],
      raw: true,
    }),
    File.count({ where: fileWhere }),
    File.findAll({
      attributes: [
        'department_code',
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'count'],
      ],
      where: fileWhere,
      group: ['department_code'],
      raw: true,
    }),
    AnalyticsEvent.findAll({
      where: contentFlagWhere,
      order: [['created_at', 'DESC']],
      limit: 50,
      raw: true,
    }),
  ]);

  const queryRowsAny = queryRows as any[];
  const totalQueries = queryRowsAny.length;
  let failedRequests = 0;
  let successfulResponses = 0;
  const finishedQueryRows = [] as any[];

  for (const row of queryRowsAny) {
    if (isFailedQueryForAnalytics(row?.status, row?.answer_text)) {
      failedRequests += 1;
      continue;
    }
    successfulResponses += 1;
    finishedQueryRows.push(row);
  }

  let retrievalMsTotal = 0;
  let retrievalMsCount = 0;
  let responseMsTotal = 0;
  let responseMsCount = 0;
  for (const row of (finishedQueryRows as any[])) {
    const responseMs = toFiniteMs(row?.response_ms);
    if (responseMs != null) {
      responseMsTotal += responseMs;
      responseMsCount += 1;
    }
    const retrievalMs = extractOrganicRetrievalMsFromMeta(row?.metadata_json);
    if (retrievalMs != null) {
      retrievalMsTotal += retrievalMs;
      retrievalMsCount += 1;
    }
  }
  const avgRetrievalMs = retrievalMsCount > 0 ? (retrievalMsTotal / retrievalMsCount) : 0;
  const avgTotalResponseMs = responseMsCount > 0 ? (responseMsTotal / responseMsCount) : 0;
  const avgResponseMs = avgTotalResponseMs;
  const avgResponseSource = 'response';
  const errorRate = totalQueries > 0 ? Number(((failedRequests / totalQueries) * 100).toFixed(2)) : 0;
  const responseRate = totalQueries > 0 ? Number(((successfulResponses / totalQueries) * 100).toFixed(2)) : 0;

  const activeUserKeys = new Set<string>();
  for (const row of queryRowsAny) {
    const userId = Number(row.user_id);
    if (Number.isFinite(userId) && userId > 0) {
      activeUserKeys.add(`id:${userId}`);
      continue;
    }

    const userName = String(row.user_name || '').trim().toLowerCase();
    if (userName) activeUserKeys.add(`name:${userName}`);
  }
  const activeUsers = activeUserKeys.size;

  let ragUsedCount = 0;
  let ragUnusedCount = 0;
  for (const row of ragRows as any[]) {
    const count = Number(row.count || 0);
    if (row.rag_used === true || row.rag_used === 'true' || row.rag_used === 1) ragUsedCount += count;
    else ragUnusedCount += count;
  }

  let positive = 0;
  let negative = 0;
  for (const row of feedbackRows as any[]) {
    const count = Number(row.count || 0);
    if (Number(row.feedback_signal) === 1) positive += count;
    if (Number(row.feedback_signal) === 0) negative += count;
  }
  const feedbackTotal = positive + negative;
  const positivePct = feedbackTotal > 0 ? Math.round((positive / feedbackTotal) * 100) : 0;
  const negativePct = feedbackTotal > 0 ? Math.round((negative / feedbackTotal) * 100) : 0;

  const byDepartment: Record<'HR' | 'GA' | 'ACC' | 'OTHER', number> = { HR: 0, GA: 0, ACC: 0, OTHER: 0 };
  for (const row of docsByDept as any[]) {
    const dept = String(row.department_code || '').toUpperCase();
    if (dept === 'HR' || dept === 'GA' || dept === 'ACC' || dept === 'OTHER') {
      byDepartment[dept] = Number(row.count || 0);
    }
  }

  const flaggedRowsAny = flaggedRows as any[];
  const flaggedUserIds = Array.from(
    new Set(
      flaggedRowsAny
        .map((row) => Number(row.user_id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );
  const flaggedUserNames = Array.from(
    new Set(
      flaggedRowsAny
        .map((row) => String(row.user_name || '').trim())
        .filter(Boolean),
    ),
  );
  const users = flaggedUserIds.length || flaggedUserNames.length
    ? ((await User.findAll({
        attributes: [
          'user_id',
          'user_name',
          'emp_id',
          'first_name',
          'last_name',
          'job_role_key',
          'area_of_work_key',
          'role_code',
          'department',
          'department_code',
        ],
        where: {
          [Op.or]: [
            ...(flaggedUserIds.length ? [{ user_id: { [Op.in]: flaggedUserIds } }] : []),
            ...(flaggedUserNames.length ? [{ user_name: { [Op.in]: flaggedUserNames } }] : []),
            ...(flaggedUserNames.length ? [{ emp_id: { [Op.in]: flaggedUserNames } }] : []),
          ],
          deleted_at: null,
        } as any,
        raw: true,
      })) as any[])
    : [];
  const userById = new Map<number, any>(
    users.map((u: any) => [Number(u.user_id), u]),
  );
  const normalizeKey = (value: unknown) => String(value || '').trim().toLowerCase();
  const userByNameOrEmp = new Map<string, any>();
  for (const u of users) {
    const userNameKey = normalizeKey(u.user_name);
    const empIdKey = normalizeKey(u.emp_id);
    if (userNameKey && !userByNameOrEmp.has(userNameKey)) userByNameOrEmp.set(userNameKey, u);
    if (empIdKey && !userByNameOrEmp.has(empIdKey)) userByNameOrEmp.set(empIdKey, u);
  }

  const categoryCounts: Record<string, number> = {};
  const incidents = flaggedRowsAny.map((row) => {
    let parsedMeta: any = {};
    try {
      parsedMeta = row.metadata_json ? JSON.parse(row.metadata_json) : {};
    } catch {
      parsedMeta = {};
    }
    const reasons = Array.isArray(parsedMeta?.reasons) ? (parsedMeta.reasons as ModerationReason[]) : [];
    for (const reason of reasons) {
      const key = String(reason?.category || 'unknown');
      categoryCounts[key] = (categoryCounts[key] || 0) + 1;
    }

    const userId = row.user_id ? Number(row.user_id) : null;
    const rowUserNameKey = normalizeKey(row.user_name);
    const byId = userId ? userById.get(userId) : null;
    const byNameOrEmp = rowUserNameKey ? userByNameOrEmp.get(rowUserNameKey) : null;
    const byIdMatchesIdentity =
      !!byId &&
      (normalizeKey(byId.user_name) === rowUserNameKey ||
        normalizeKey(byId.emp_id) === rowUserNameKey);
    const user = byIdMatchesIdentity ? byId : (byNameOrEmp || byId || null);

    return {
      id: Number(row.id),
      createdAt: row.created_at,
      userName: row.user_name || 'unknown',
      departmentCode: row.department_code || 'N/A',
      userProfile: user
        ? {
            userId: Number(user.user_id),
            userName: String(user.user_name || ''),
            employeeId: String(user.emp_id || ''),
            firstName: String(user.first_name || ''),
            lastName: String(user.last_name || ''),
            userJobRole: String(user.job_role_key || ''),
            areaOfWork: String(user.area_of_work_key || ''),
            roleCode: String(user.role_code || ''),
            department: String(user.department || ''),
            departmentCode: String(user.department_code || ''),
          }
        : null,
      taskOutputId: row.task_output_id ? Number(row.task_output_id) : null,
      queryText: row.query_text || '',
      answerText: row.answer_text || '',
      score: Number(parsedMeta?.score || 0),
      reasons: reasons.map((r) => ({
        category: String(r?.category || ''),
        reason: String(r?.reason || ''),
        matchedText: String(r?.matchedText || ''),
        severity: Number(r?.severity || 0),
        source: String(r?.source || ''),
        detector: String((r as any)?.detector || 'rules'),
        confidence: Number((r as any)?.confidence || 0),
      })).sort((a, b) => Number(b.severity || 0) - Number(a.severity || 0)),
    };
  });

  return {
    range,
    totalQueries,
    activeUsers,
    avgResponseTimeMs: Math.round(avgResponseMs),
    avgRetrievalTimeMs: Math.round(avgRetrievalMs),
    avgTotalResponseTimeMs: Math.round(avgTotalResponseMs),
    avgResponseTimeSource: avgResponseSource,
    successfulResponses,
    responseRate,
    failedRequests,
    errorRate,
    feedback: {
      positive,
      negative,
      positivePct,
      negativePct,
    },
    ragUsage: {
      used: ragUsedCount,
      notUsed: ragUnusedCount,
    },
    uploadedDocuments: {
      total: Number(totalDocs || 0),
      byDepartment,
    },
    contentSafety: {
      totalFlagged: incidents.length,
      categoryCounts,
      incidents,
    },
  };
}
