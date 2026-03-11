import { pgPool } from '@/clients/postgres';
import {
  AccessScope,
  isDepartmentAdminRole,
  isSuperAdminRole,
  normalizeDepartmentCode,
  DepartmentCode,
} from '@/service/rbac';
import { createNotification } from '@/service/notificationService';
import { verifyPassword } from '@/service/user';
import Message from '@/mysql/model/message.model';

export type CreateTriageInput = {
  conversationId?: string;
  messageId?: string;
  userQueryOriginal: string;
  assistantAnswer: string;
  issueType: string;
  userComment: string;
  expectedAnswer?: string;
  retrievedSourceIds?: string[];
  retrievalQueryUsed?: string;
  modelName?: string;
  departmentCode?: string;
  routingMode?: 'AUTO' | 'MANUAL';
  assignedToUserId?: number | null;
  targetRoleCode?: 'SUPER_ADMIN' | 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN';
};

export type TriageAssignee = {
  userId: number;
  userName: string;
  empId: string | null;
  departmentCode: DepartmentCode;
  roleCode: string;
};

type TriageRoutingSource = 'MANUAL' | 'LLM' | 'FALLBACK' | 'DEDUPED' | 'GUARDRAIL';
type TriageSentiment = 'positive' | 'neutral' | 'negative' | 'mixed';
type TriageUrgency = 'low' | 'medium' | 'high' | 'critical';
type TriageRoutingAnalysis = {
  source: TriageRoutingSource;
  departmentCode: DepartmentCode;
  sentiment: TriageSentiment;
  urgency: TriageUrgency;
  confidence: number;
  reason: string;
  modelName: string | null;
};

type ExistingOpenTicket = {
  id: number;
  department_code: DepartmentCode;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'REJECTED';
  created_by: number;
  assigned_to: number | null;
  created_at: string;
  updated_at: string;
  conversation_id: string | null;
  message_id: string | null;
  user_query_original: string;
  issue_type: string;
};

const getCrossConversationDuplicateWindowMs = (): number => {
  const parsed = Number(process.env.TRIAGE_DEDUP_CROSS_CONVERSATION_MS || 2 * 60 * 60 * 1000);
  if (!Number.isFinite(parsed)) return 2 * 60 * 60 * 1000;
  return Math.max(0, parsed);
};

const toEpochMs = (value: unknown): number => {
  if (!value) return Number.NaN;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : Number.NaN;
};

async function notifyTriageReplyToRequester(input: {
  scope: AccessScope;
  ticketId: number;
  targetUserId: number;
  fallbackDepartmentCode: DepartmentCode;
  reply: string;
  status?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'REJECTED';
}) {
  const targetUserRes = await pgPool.query(
    `
    SELECT
      user_id,
      COALESCE(NULLIF(department_code, ''), 'HR') AS department_code,
      COALESCE(NULLIF(user_name, ''), CAST(user_id AS TEXT)) AS user_name
    FROM "user"
    WHERE user_id = $1
    LIMIT 1
    `,
    [input.targetUserId],
  );
  const target = targetUserRes.rows[0];
  const targetDepartmentCode = normalizeDepartmentCode(target?.department_code || input.fallbackDepartmentCode);
  const targetRecipientId = String(target?.user_name || input.targetUserId);

  await createNotification({
    userId: input.targetUserId,
    departmentCode: targetDepartmentCode,
    type: 'system_alert',
    title: `Escalation ticket #${input.ticketId} reply`,
    body: input.reply,
    payload: {
      ticketId: input.ticketId,
      status: input.status,
      repliedBy: input.scope.userId,
      type: 'triage_reply',
    },
  });

  // Also insert into direct inbox channel used by notification panel.
  await Message.create({
    sender_id: String(input.scope.userName || input.scope.userId),
    sender_user_id: Number(input.scope.userId),
    sender_type: 'admin',
    recipient_id: targetRecipientId,
    recipient_type: 'user',
    subject: `Escalation ticket #${input.ticketId} reply`,
    content: input.reply,
    parent_id: null,
    is_read: false,
    is_broadcast: false,
    department_code: targetDepartmentCode,
  } as any);
}

const getTriageRoutingModelName = (): string => {
  const value = String(
    process.env.TRIAGE_ROUTING_MODEL_NAME ||
    process.env.CHAT_KEYWORD_MODEL_NAME ||
    process.env.CHAT_MODEL_NAME ||
    process.env.OLLAMA_MODEL ||
    'openai/gpt-oss-20b',
  ).trim();
  return value || 'openai/gpt-oss-20b';
};

const getTriageRoutingTimeoutMs = (): number => {
  const parsed = Number(process.env.TRIAGE_ROUTING_TIMEOUT_MS || 18000);
  if (!Number.isFinite(parsed)) return 18000;
  return Math.max(3000, parsed);
};

const getTriageRoutingAttempts = (): number => {
  const parsed = Number(process.env.TRIAGE_ROUTING_ATTEMPTS || 2);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(1, Math.min(4, parsed));
};

const parseOllamaBaseUrls = (): string[] => {
  const raw = String(process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_API_URL || '').trim();
  const values = (raw || 'http://127.0.0.1:11435')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (/^https?:\/\//i.test(v) ? v : `http://${v}`))
    .map((v) => v.replace(/\/+$/, ''));
  return values.length > 0 ? values : ['http://127.0.0.1:11435'];
};

const normalizeRoutingDepartment = (value: unknown): DepartmentCode => {
  const normalized = normalizeDepartmentCode(value);
  if (normalized === 'OTHER') return 'HR';
  return normalized;
};

const normalizeRoutingSentiment = (value: unknown): TriageSentiment => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'positive') return 'positive';
  if (normalized === 'negative') return 'negative';
  if (normalized === 'mixed') return 'mixed';
  return 'neutral';
};

const normalizeRoutingUrgency = (value: unknown): TriageUrgency => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'low') return 'low';
  if (normalized === 'high') return 'high';
  if (normalized === 'critical') return 'critical';
  return 'medium';
};

const normalizeConfidence = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.max(0, Math.min(1, parsed));
};

const normalizeQuestionForDuplicate = (value: string): string =>
  String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function findDuplicateOpenTicket(
  client: { query: (...args: any[]) => Promise<any> },
  scope: AccessScope,
  input: CreateTriageInput,
): Promise<ExistingOpenTicket | null> {
  const res = await client.query(
    `
    SELECT
      t.id,
      t.department_code,
      t.status,
      t.created_by,
      t.assigned_to,
      t.created_at,
      t.updated_at,
      p.conversation_id,
      p.message_id,
      p.user_query_original,
      p.issue_type
    FROM triage_tickets t
    INNER JOIN triage_payload p ON p.ticket_id = t.id
    WHERE t.created_by = $1
      AND t.status IN ('OPEN', 'IN_PROGRESS')
    ORDER BY t.updated_at DESC
    LIMIT 100
    `,
    [scope.userId],
  );

  const inputMessageId = String(input.messageId || '').trim();
  const inputConversationId = String(input.conversationId || '').trim();
  const normalizedInputQuestion = normalizeQuestionForDuplicate(input.userQueryOriginal || '');
  const nowMs = Date.now();
  const crossConversationWindowMs = getCrossConversationDuplicateWindowMs();

  const matches: ExistingOpenTicket[] = [];

  for (const row of res.rows || []) {
    const rowMessageId = String(row.message_id || '').trim();
    const rowConversationId = String(row.conversation_id || '').trim();
    const normalizedRowQuestion = normalizeQuestionForDuplicate(row.user_query_original || '');
    const candidate = {
      ...row,
      id: Number(row.id),
      assigned_to: row.assigned_to == null ? null : Number(row.assigned_to),
    } as ExistingOpenTicket;

    if (inputMessageId && rowMessageId && inputMessageId === rowMessageId) {
      matches.push(candidate);
      continue;
    }

    const sameQuestion =
      Boolean(normalizedInputQuestion) &&
      Boolean(normalizedRowQuestion) &&
      normalizedInputQuestion === normalizedRowQuestion;

    if (!sameQuestion) continue;

    if (inputConversationId && rowConversationId) {
      if (inputConversationId === rowConversationId) {
        matches.push(candidate);
      } else if (crossConversationWindowMs > 0) {
        const candidateUpdatedMs = toEpochMs(candidate.updated_at || candidate.created_at);
        if (Number.isFinite(candidateUpdatedMs) && (nowMs - candidateUpdatedMs) <= crossConversationWindowMs) {
          matches.push(candidate);
        }
      }
      continue;
    }

    // If conversation id is unavailable on one side, treat same normalized question as duplicate.
    matches.push(candidate);
  }

  if (!matches.length) return null;

  matches.sort((a, b) => {
    const aNoSource = String(a.issue_type || '').toUpperCase() === 'NO_SOURCE_DOCUMENT' ? 1 : 0;
    const bNoSource = String(b.issue_type || '').toUpperCase() === 'NO_SOURCE_DOCUMENT' ? 1 : 0;
    if (aNoSource !== bNoSource) return aNoSource - bNoSource;

    const aAssigned = a.assigned_to == null ? 1 : 0;
    const bAssigned = b.assigned_to == null ? 1 : 0;
    if (aAssigned !== bAssigned) return aAssigned - bAssigned;

    return a.id - b.id;
  });

  return matches[0];
}

async function refreshDuplicatePayload(
  client: { query: (...args: any[]) => Promise<any> },
  ticketId: number,
  input: CreateTriageInput,
) {
  await client.query(
    `
    UPDATE triage_payload
    SET
      conversation_id = COALESCE(conversation_id, $2),
      message_id = COALESCE(message_id, $3),
      timestamp = NOW()
    WHERE ticket_id = $1
    `,
    [
      ticketId,
      input.conversationId || null,
      input.messageId || null,
    ],
  );
}

const extractJsonFromModelText = (raw: string): Record<string, any> => {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Empty model output');
  const withoutFence = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const firstBrace = withoutFence.indexOf('{');
  const lastBrace = withoutFence.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('Model output did not include JSON object');
  }
  const parsed = JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Model JSON must be an object');
  }
  return parsed as Record<string, any>;
};

const normalizeIssueType = (value: unknown): string =>
  String(value || '').trim().toUpperCase();

const stripTriageFormatting = (value: string): string =>
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

const normalizeEscalationText = (value: unknown): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const singleLangMatch = raw.match(/<!--SINGLE_LANG_START-->([\s\S]*?)<!--SINGLE_LANG_END-->/);
  if (singleLangMatch?.[1]) {
    const parsed = tryParseAnyJsonObject(singleLangMatch[1]);
    if (parsed) {
      const content = typeof parsed.content === 'string'
        ? parsed.content
        : typeof parsed.translated === 'string'
          ? parsed.translated
          : '';
      if (content) return stripTriageFormatting(content);
    }
  }

  const dualLangMatch = raw.match(/<!--DUAL_LANG_START-->([\s\S]*?)<!--DUAL_LANG_END-->/);
  if (dualLangMatch?.[1]) {
    const parsed = tryParseAnyJsonObject(dualLangMatch[1]);
    if (parsed) {
      const content = typeof parsed.translated === 'string'
        ? parsed.translated
        : typeof parsed.content === 'string'
          ? parsed.content
          : typeof parsed.japanese === 'string'
            ? parsed.japanese
            : '';
      if (content) return stripTriageFormatting(content);
    }
  }

  const parsedRaw = tryParseAnyJsonObject(raw);
  if (parsedRaw) {
    const content = typeof parsedRaw.content === 'string'
      ? parsedRaw.content
      : typeof parsedRaw.translated === 'string'
        ? parsedRaw.translated
        : typeof parsedRaw.japanese === 'string'
          ? parsedRaw.japanese
          : '';
    if (content) return stripTriageFormatting(content);
  }

  return stripTriageFormatting(raw);
};

const normalizeCreateTriageInput = (input: CreateTriageInput): CreateTriageInput => {
  const userQueryOriginal = normalizeEscalationText(input.userQueryOriginal);
  const assistantAnswer = normalizeEscalationText(input.assistantAnswer);
  const userComment = normalizeEscalationText(input.userComment);
  const expectedAnswer = normalizeEscalationText(input.expectedAnswer || '');
  const retrievalQueryUsed = normalizeEscalationText(input.retrievalQueryUsed || '');

  return {
    ...input,
    userQueryOriginal: userQueryOriginal || String(input.userQueryOriginal || '').trim(),
    assistantAnswer: assistantAnswer || String(input.assistantAnswer || '').trim(),
    userComment: userComment || String(input.userComment || '').trim(),
    expectedAnswer: expectedAnswer || undefined,
    retrievalQueryUsed: retrievalQueryUsed || undefined,
  };
};

type RoutedDepartment = 'HR' | 'GA' | 'ACC';
type DomainPattern = { pattern: RegExp; weight: number };

const GA_STRONG_PATTERNS: DomainPattern[] = [
  { pattern: /\boffice\s+seat\b/i, weight: 2.2 },
  { pattern: /\bseat\s+allocation\b/i, weight: 2.2 },
  { pattern: /\bdesk\s+allocation\b/i, weight: 2.2 },
  { pattern: /\boffice\s+relocation\b/i, weight: 2.2 },
  { pattern: /\bdesk\s+relocation\b/i, weight: 2.2 },
  { pattern: /\bworkstation\b/i, weight: 1.8 },
  { pattern: /\baccess\s+card\b/i, weight: 2.3 },
  { pattern: /\bid\s*card\b/i, weight: 2.0 },
  { pattern: /\bbadge\b/i, weight: 2.0 },
  { pattern: /\bparking\s+(slot|pass|permit)\b/i, weight: 2.2 },
  { pattern: /\bequipment\s+replacement\b/i, weight: 2.3 },
  { pattern: /\blaptop\b.{0,30}\b(repair|replacement|broken)\b/i, weight: 2.2 },
  { pattern: /\bfacilit(y|ies)\b/i, weight: 1.2 },
];

const ACC_STRONG_PATTERNS: DomainPattern[] = [
  { pattern: /\binvoice(s)?\b/i, weight: 2.4 },
  { pattern: /\bvendor\s+payment(s)?\b/i, weight: 2.4 },
  { pattern: /\bpayment\s+approval\b/i, weight: 2.3 },
  { pattern: /\bpurchase\s+order\b|\bpo\s+approval\b/i, weight: 2.2 },
  { pattern: /\bpayroll\b/i, weight: 2.3 },
  { pattern: /\bdeduction(s)?\b/i, weight: 2.0 },
  { pattern: /\breimbursement\b/i, weight: 2.1 },
  { pattern: /\btax(es)?\b/i, weight: 2.0 },
  { pattern: /\bsalary\b/i, weight: 1.7 },
  { pattern: /\bexpense(s)?\b/i, weight: 1.6 },
];

const HR_STRONG_PATTERNS: DomainPattern[] = [
  { pattern: /\bmaternity\b/i, weight: 2.2 },
  { pattern: /\bpaternity\b/i, weight: 2.2 },
  { pattern: /\bprobation\b/i, weight: 2.2 },
  { pattern: /\bleave\b/i, weight: 1.9 },
  { pattern: /\battendance\b/i, weight: 1.9 },
  { pattern: /\bbenefit(s)?\b/i, weight: 1.8 },
  { pattern: /\bappraisal\b|\bevaluation\b/i, weight: 1.8 },
  { pattern: /\bonboarding\b/i, weight: 1.8 },
  { pattern: /\boffboarding\b/i, weight: 1.8 },
];

const scoreDomainPatterns = (text: string, patterns: DomainPattern[]): number =>
  patterns.reduce((score, item) => score + (item.pattern.test(text) ? item.weight : 0), 0);

const detectStrongDomainDepartment = (input: CreateTriageInput): { departmentCode: RoutedDepartment; reason: string; score: number; margin: number } | null => {
  const signalText = [
    String(input.userQueryOriginal || ''),
    String(input.userComment || ''),
    String(input.expectedAnswer || ''),
    String(input.issueType || ''),
  ].join('\n');

  const scoreGA = scoreDomainPatterns(signalText, GA_STRONG_PATTERNS);
  const scoreACC = scoreDomainPatterns(signalText, ACC_STRONG_PATTERNS);
  const scoreHR = scoreDomainPatterns(signalText, HR_STRONG_PATTERNS);
  const scored = [
    { dept: 'GA' as RoutedDepartment, score: scoreGA },
    { dept: 'ACC' as RoutedDepartment, score: scoreACC },
    { dept: 'HR' as RoutedDepartment, score: scoreHR },
  ].sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];
  if (!top || top.score <= 0) return null;

  const margin = top.score - Number(second?.score || 0);
  if (top.score >= 2.2 && margin >= 0.75) {
    return {
      departmentCode: top.dept,
      reason: `strong_domain_signal_${top.dept.toLowerCase()}`,
      score: top.score,
      margin,
    };
  }
  return null;
};

const roleScopedDepartment = (roleCode: unknown): DepartmentCode | null => {
  const normalized = String(roleCode || '').trim().toUpperCase();
  if (normalized === 'HR_ADMIN') return 'HR';
  if (normalized === 'GA_ADMIN') return 'GA';
  if (normalized === 'ACC_ADMIN') return 'ACC';
  return null;
};

const getNoSourceRoutingMinConfidence = (): number => {
  const parsed = Number(process.env.TRIAGE_NO_SOURCE_MIN_CONFIDENCE || 0.35);
  if (!Number.isFinite(parsed)) return 0.35;
  return Math.max(0, Math.min(1, parsed));
};

const fixedRoutingAnalysis = (
  source: TriageRoutingSource,
  departmentCode: DepartmentCode,
  reason: string,
  confidence: number,
  modelName: string | null,
): TriageRoutingAnalysis => ({
  source,
  departmentCode,
  sentiment: 'neutral',
  urgency: 'medium',
  confidence: Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0)),
  reason: String(reason || '').trim().slice(0, 160) || 'routing',
  modelName,
});

const resolveManualRoutingDepartment = (input: CreateTriageInput): DepartmentCode | null => {
  if (input.routingMode !== 'MANUAL') return null;
  const byRole = roleScopedDepartment(input.targetRoleCode);
  if (byRole) return byRole;
  if (input.departmentCode) return normalizeRoutingDepartment(input.departmentCode);
  return null;
};

const fallbackAutoDepartment = (scope: AccessScope, input: CreateTriageInput): DepartmentCode => {
  if (input.departmentCode) {
    return normalizeRoutingDepartment(input.departmentCode);
  }
  const byRole = roleScopedDepartment(scope.roleCode);
  if (byRole) return byRole;
  return 'HR';
};

const buildTriageRoutingMessages = (input: CreateTriageInput) => {
  const system = `You are a strict enterprise escalation triage router.
Decide exactly one department among HR, GA, ACC using semantics and intent.
Use the end-user issue content only (question, assistant answer, user comment).
Never use requester profile details (department, role, locale) as routing signal.

Department scope guide:
- HR: leave, attendance, policy interpretation, benefits, compensation policy, employment rules, probation, evaluation, onboarding/offboarding process.
- GA: facilities, office access, ID card/badge, seats, buildings, parking, security process, office equipment provisioning, workplace logistics.
- ACC: reimbursements, invoices, salary calculation details, tax handling, payroll processing, deductions, financial approvals and accounting rules.

Examples:
- "How many paid leave days do I get this year?" => HR
- "How do I request an access card or parking slot?" => GA
- "How do I claim travel reimbursement and tax deduction?" => ACC
- "My laptop is broken, how do I raise equipment replacement request?" => GA
- "When is payroll processed and how are deductions calculated?" => ACC

Return ONLY one compact JSON object with this exact schema:
{
  "department_code": "HR" | "GA" | "ACC",
  "sentiment": "positive" | "neutral" | "negative" | "mixed",
  "urgency": "low" | "medium" | "high" | "critical",
  "confidence": number,
  "reason": string
}

Rules:
- confidence must be between 0 and 1.
- reason must be <= 160 chars.
- For NO_SOURCE_DOCUMENT, still classify by the user question domain.
- Ignore boilerplate system text like "Auto-escalated by source-only policy...".
- No markdown, no prose, no extra keys.`;

  const payload = {
    issueType: normalizeIssueType(input.issueType),
    userQueryOriginal: String(input.userQueryOriginal || ''),
    assistantAnswer: String(input.assistantAnswer || ''),
    userComment: String(input.userComment || ''),
    expectedAnswer: String(input.expectedAnswer || ''),
    retrievalQueryUsed: String(input.retrievalQueryUsed || ''),
    retrievedSourceIds: Array.isArray(input.retrievedSourceIds) ? input.retrievedSourceIds : [],
  };

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Classify this escalation payload:\n${JSON.stringify(payload)}` },
  ];
};

async function classifyDepartmentWithLLM(input: CreateTriageInput): Promise<TriageRoutingAnalysis> {
  const modelName = getTriageRoutingModelName();
  const baseUrls = parseOllamaBaseUrls();
  const attempts = getTriageRoutingAttempts();
  const timeoutMs = getTriageRoutingTimeoutMs();
  const messages = buildTriageRoutingMessages(input);
  const errors: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const baseUrl of baseUrls) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stream: false,
            model: modelName,
            messages,
            options: {
              temperature: 0,
              top_p: 0.15,
              repeat_penalty: 1.1,
              num_predict: 220,
            },
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}: ${errText || response.statusText}`);
        }
        const data = await response.json();
        const content = String(data?.message?.content || data?.response || '').trim();
        const parsed = extractJsonFromModelText(content);
        return {
          source: 'LLM',
          departmentCode: normalizeRoutingDepartment(
            parsed.department_code || parsed.departmentCode || parsed.department,
          ),
          sentiment: normalizeRoutingSentiment(parsed.sentiment),
          urgency: normalizeRoutingUrgency(parsed.urgency || parsed.priority),
          confidence: normalizeConfidence(parsed.confidence),
          reason: String(parsed.reason || '').trim().slice(0, 160) || 'model_routing',
          modelName,
        };
      } catch (e: any) {
        errors.push(`[attempt ${attempt}] ${baseUrl}: ${String(e?.message || e)}`);
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  throw new Error(errors.join(' | ') || 'LLM triage routing failed');
}

const resolveTriageDepartment = async (scope: AccessScope, input: CreateTriageInput): Promise<TriageRoutingAnalysis> => {
  const manualDepartment = resolveManualRoutingDepartment(input);
  if (manualDepartment) {
    const reason = input.targetRoleCode ? 'manual_role_selection' : 'manual_department_selection';
    return fixedRoutingAnalysis('MANUAL', manualDepartment, reason, 1, null);
  }

  const strongDomain = detectStrongDomainDepartment(input);
  const issueType = normalizeIssueType(input.issueType);
  if (issueType === 'NO_SOURCE_DOCUMENT' && strongDomain && strongDomain.score >= 2.2) {
    return fixedRoutingAnalysis(
      'GUARDRAIL',
      strongDomain.departmentCode,
      `${strongDomain.reason}_no_source_lock`,
      0.96,
      getTriageRoutingModelName(),
    );
  }

  try {
    const llmResult = await classifyDepartmentWithLLM(input);
    if (
      strongDomain &&
      (llmResult.departmentCode !== strongDomain.departmentCode || llmResult.confidence < 0.75)
    ) {
      return {
        ...llmResult,
        source: 'GUARDRAIL',
        departmentCode: strongDomain.departmentCode,
        confidence: Math.max(llmResult.confidence, 0.92),
        reason: strongDomain.reason,
      };
    }

    if (issueType === 'NO_SOURCE_DOCUMENT' && llmResult.confidence < getNoSourceRoutingMinConfidence()) {
      if (String(input.userQueryOriginal || '').trim().length >= 8) {
        return {
          ...llmResult,
          reason: 'low_confidence_no_source_kept_model_decision',
        };
      }
      return {
        ...llmResult,
        source: 'FALLBACK',
        departmentCode: fallbackAutoDepartment(scope, input),
        reason: 'low_confidence_no_source_document',
      };
    }
    return llmResult;
  } catch (e: any) {
    console.warn('[Triage] LLM routing failed, using fallback:', String(e?.message || e));
    if (strongDomain) {
      return fixedRoutingAnalysis('GUARDRAIL', strongDomain.departmentCode, strongDomain.reason, 0.92, getTriageRoutingModelName());
    }
    return fixedRoutingAnalysis(
      'FALLBACK',
      fallbackAutoDepartment(scope, input),
      'llm_unavailable_or_invalid_output',
      0,
      getTriageRoutingModelName(),
    );
  }
};

const roleCodeForDepartment = (departmentCode: DepartmentCode): 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN' => {
  if (departmentCode === 'GA') return 'GA_ADMIN';
  if (departmentCode === 'ACC') return 'ACC_ADMIN';
  return 'HR_ADMIN';
};

const departmentForAdminRole = (roleCode: 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN'): DepartmentCode => {
  if (roleCode === 'GA_ADMIN') return 'GA';
  if (roleCode === 'ACC_ADMIN') return 'ACC';
  return 'HR';
};

const strictDepartmentForScope = (scope: AccessScope): DepartmentCode => {
  if (scope.roleCode === 'HR_ADMIN') return 'HR';
  if (scope.roleCode === 'GA_ADMIN') return 'GA';
  if (scope.roleCode === 'ACC_ADMIN') return 'ACC';
  return normalizeDepartmentCode(scope.departmentCode);
};

export async function createTriageTicket(scope: AccessScope, input: CreateTriageInput) {
  const normalizedInput = normalizeCreateTriageInput(input);
  const routingMode = normalizedInput.routingMode === 'MANUAL' ? 'MANUAL' : 'AUTO';

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const duplicate = await findDuplicateOpenTicket(client, scope, normalizedInput);
    if (duplicate) {
      await refreshDuplicatePayload(client, duplicate.id, normalizedInput);
      const duplicateTicketRes = await client.query(
        `
        UPDATE triage_tickets
        SET updated_at = NOW()
        WHERE id = $1
        RETURNING id, department_code, status, created_by, assigned_to, created_at, updated_at
        `,
        [duplicate.id],
      );
      await client.query('COMMIT');
      const duplicateTicket = duplicateTicketRes.rows[0];
      if (!duplicateTicket) {
        throw new Error('Failed to reuse existing escalation ticket');
      }
      return {
        ...duplicateTicket,
        routing_mode: routingMode,
        routing_source: 'DEDUPED',
        routing_analysis: {
          source: 'DEDUPED',
          departmentCode: normalizeDepartmentCode(duplicateTicket.department_code),
          sentiment: 'neutral',
          urgency: 'medium',
          confidence: 1,
          reason: 'existing_open_or_in_progress_ticket_reused',
          modelName: null,
        },
        deduplicated: true,
      };
    }

    const routingAnalysis = await resolveTriageDepartment(scope, normalizedInput);
    let departmentCode = routingAnalysis.departmentCode;
    let assignedTo: number | null = null;

    if (routingMode === 'MANUAL' && normalizedInput.targetRoleCode === 'SUPER_ADMIN') {
      const superAdminRes = await client.query(
        `
        SELECT u.user_id
        FROM "user" u
        WHERE u.deleted_at IS NULL
          AND (
            u.role_code = 'SUPER_ADMIN'
            OR EXISTS (
              SELECT 1
              FROM user_role ur
              INNER JOIN role r ON r.role_id = ur.role_id
              WHERE ur.user_id = u.user_id
                AND r.role_key = 'admin'
            )
          )
        ORDER BY u.user_id ASC
        LIMIT 1
        `,
      );
      if (superAdminRes.rows[0]) {
        assignedTo = Number(superAdminRes.rows[0].user_id);
      } else {
        throw new Error('No active SUPER_ADMIN found for routing.');
      }
    } else if (
      routingMode === 'MANUAL' &&
      normalizedInput.assignedToUserId != null &&
      Number.isFinite(Number(normalizedInput.assignedToUserId)) &&
      Number(normalizedInput.assignedToUserId) > 0
    ) {
      const targetAssigneeId = Number(normalizedInput.assignedToUserId);
      const targetRes = await client.query(
        `
        SELECT user_id, user_name, department_code, role_code
        FROM "user"
        WHERE user_id = $1
          AND deleted_at IS NULL
        LIMIT 1
        `,
        [targetAssigneeId],
      );
      const target = targetRes.rows[0];
      if (!target) {
        throw new Error('Selected admin not found. Please refresh and try again.');
      }
      const targetRoleCode = String(target.role_code || '').toUpperCase();
      if (!['HR_ADMIN', 'GA_ADMIN', 'ACC_ADMIN', 'SUPER_ADMIN'].includes(targetRoleCode)) {
        throw new Error('Selected assignee is not an admin');
      }
      if (
        normalizedInput.targetRoleCode &&
        String(normalizedInput.targetRoleCode).toUpperCase() !== targetRoleCode
      ) {
        throw new Error('Selected admin does not match requested role');
      }

      if (targetRoleCode === 'SUPER_ADMIN') {
        assignedTo = targetAssigneeId;
      } else {
        const strictDept = departmentForAdminRole(targetRoleCode as 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN');
        const targetDepartment = normalizeDepartmentCode(target.department_code);
        if (targetDepartment !== strictDept) {
          throw new Error('Selected admin role and department are inconsistent');
        }
        if (normalizedInput.departmentCode && normalizeDepartmentCode(normalizedInput.departmentCode) !== strictDept) {
          throw new Error('Selected assignee does not match requested department');
        }
        departmentCode = strictDept;
        assignedTo = targetAssigneeId;
      }
    } else {
      const targetRoleCode = String(normalizedInput.targetRoleCode || '').toUpperCase();
      const manualRoleSelection =
        routingMode === 'MANUAL' &&
        (targetRoleCode === 'HR_ADMIN' || targetRoleCode === 'GA_ADMIN' || targetRoleCode === 'ACC_ADMIN');
      const desiredRole = manualRoleSelection
        ? (targetRoleCode as 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN')
        : roleCodeForDepartment(departmentCode);
      const desiredDepartment = departmentForAdminRole(desiredRole);

      // Strict role-based assignment (one-to-one), no broad department fan-out.
      const assigneeRes = await client.query(
        `
        SELECT u.user_id, COALESCE(NULLIF(u.department_code, ''), 'HR') AS department_code
        FROM "user" u
        WHERE u.deleted_at IS NULL
          AND u.role_code = $1
          AND COALESCE(NULLIF(u.department_code, ''), 'HR') = $2
        ORDER BY u.user_id ASC
        LIMIT 1
        `,
        [desiredRole, desiredDepartment],
      );
      assignedTo = assigneeRes.rows[0] ? Number(assigneeRes.rows[0].user_id) : null;
      if (!assignedTo) {
        throw new Error(`No active ${desiredRole} found for routing.`);
      }
      departmentCode = desiredDepartment;
    }

    const ticketRes = await client.query(
      `
      INSERT INTO triage_tickets (department_code, status, created_by, assigned_to, created_at, updated_at)
      VALUES ($1, 'OPEN', $2, $3, NOW(), NOW())
      RETURNING id, department_code, status, created_by, assigned_to, created_at, updated_at
      `,
      [departmentCode, scope.userId, assignedTo],
    );
    const ticket = ticketRes.rows[0];

    await client.query(
      `
      INSERT INTO triage_payload (
        ticket_id,
        conversation_id,
        message_id,
        user_query_original,
        assistant_answer,
        issue_type,
        user_comment,
        expected_answer,
        retrieved_source_ids,
        retrieval_query_used,
        model_name,
        timestamp
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,NOW())
      `,
      [
        ticket.id,
        normalizedInput.conversationId || null,
        normalizedInput.messageId || null,
        normalizedInput.userQueryOriginal,
        normalizedInput.assistantAnswer,
        normalizedInput.issueType,
        normalizedInput.userComment,
        normalizedInput.expectedAnswer || null,
        JSON.stringify(normalizedInput.retrievedSourceIds || []),
        normalizedInput.retrievalQueryUsed || null,
        normalizedInput.modelName || null,
      ],
    );

    await client.query('COMMIT');

    if (assignedTo) {
      await createNotification({
        userId: assignedTo,
        departmentCode,
        type: 'system_alert',
        title: `Triage ticket #${ticket.id} assigned`,
        body: `A new ${departmentCode} escalation has been assigned to you.`,
        payload: {
          ticketId: ticket.id,
          issueType: normalizedInput.issueType,
          createdBy: scope.userId,
          routingMode,
          routingSource: routingAnalysis.source,
          routingDepartment: departmentCode,
          routingConfidence: routingAnalysis.confidence,
          routingSentiment: routingAnalysis.sentiment,
          routingUrgency: routingAnalysis.urgency,
        },
      }).catch(() => undefined);
    }

    // Notify requester that escalation was submitted successfully.
    await createNotification({
      userId: scope.userId,
      departmentCode: scope.departmentCode,
      type: 'system_alert',
      title: `Escalation ticket #${ticket.id} submitted`,
      body: `Your escalation has been sent to ${departmentCode} admin queue.`,
      payload: {
        ticketId: ticket.id,
        issueType: normalizedInput.issueType,
        status: ticket.status,
        routingSource: routingAnalysis.source,
        routingDepartment: departmentCode,
      },
    }).catch(() => undefined);

    return {
      ...ticket,
      routing_mode: routingMode,
      routing_source: routingAnalysis.source,
      routing_analysis: routingAnalysis,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listTriageAssignees(scope: AccessScope, requestedDepartmentCode?: string): Promise<TriageAssignee[]> {
  const params: any[] = [];
  let where = `WHERE u.deleted_at IS NULL AND u.role_code IN ('HR_ADMIN', 'GA_ADMIN', 'ACC_ADMIN', 'SUPER_ADMIN')`;

  if (isDepartmentAdminRole(scope.roleCode)) {
    const strictDept = strictDepartmentForScope(scope);
    params.push(scope.roleCode);
    where += ` AND u.role_code = $${params.length}`;
    params.push(strictDept);
    where += ` AND u.department_code = $${params.length}`;
  } else if (requestedDepartmentCode) {
    const normalizedDepartment = normalizeDepartmentCode(requestedDepartmentCode);
    const targetRole = roleCodeForDepartment(normalizedDepartment);
    params.push(targetRole);
    where += ` AND u.role_code = $${params.length}`;
    params.push(normalizedDepartment);
    where += ` AND u.department_code = $${params.length}`;
  }

  const res = await pgPool.query(
    `
    SELECT
      u.user_id,
      COALESCE(NULLIF(u.user_name, ''), CAST(u.user_id AS TEXT)) AS user_name,
      NULLIF(u.emp_id, '') AS emp_id,
      COALESCE(NULLIF(u.department_code, ''), 'HR') AS department_code,
      COALESCE(NULLIF(u.role_code, ''), 'USER') AS role_code
    FROM "user" u
    ${where}
    ORDER BY u.department_code ASC, u.user_id ASC
    `,
    params,
  );

  return res.rows.map((row: any) => ({
    userId: Number(row.user_id),
    userName: String(row.user_name || row.user_id),
    empId: row.emp_id || null,
    departmentCode: normalizeDepartmentCode(row.department_code),
    roleCode: String(row.role_code || 'USER').toUpperCase(),
  }));
}

export async function listTriageTickets(scope: AccessScope, pageNum: number, pageSize: number) {
  const limit = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const offset = (Math.max(1, Number(pageNum) || 1) - 1) * limit;
  const params: any[] = [];
  let where = '';
  if (isSuperAdminRole(scope.roleCode)) {
    where = '';
  } else if (isDepartmentAdminRole(scope.roleCode)) {
    // Strict role scope: department admins see only their department escalations.
    params.push(strictDepartmentForScope(scope));
    where = `WHERE t.department_code = $${params.length}`;
  } else {
    params.push(scope.userId);
    where = `WHERE t.created_by = $${params.length}`;
  }

  params.push(limit, offset);

  const rows = await pgPool.query(
    `
    SELECT
      t.*,
      p.issue_type,
      p.user_comment,
      p.conversation_id,
      p.message_id,
      p.user_query_original,
      p.assistant_answer,
      p.expected_answer,
      p.retrieved_source_ids,
      p.retrieval_query_used,
      p.model_name,
      p.timestamp AS payload_timestamp,
      creator.user_name AS created_by_user_name,
      creator.emp_id AS created_by_emp_id,
      creator.department_code AS created_by_department_code,
      assignee.user_name AS assigned_to_user_name,
      assignee.emp_id AS assigned_to_emp_id
    FROM triage_tickets t
    INNER JOIN triage_payload p ON p.ticket_id = t.id
    LEFT JOIN "user" creator ON creator.user_id = t.created_by
    LEFT JOIN "user" assignee ON assignee.user_id = t.assigned_to
    ${where}
    ORDER BY t.updated_at DESC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
    `,
    params,
  );

  return rows.rows.map((row: any) => {
    const cleanedExpected = normalizeEscalationText(row.expected_answer || '');
    return {
      ...row,
      user_query_original: normalizeEscalationText(row.user_query_original || ''),
      assistant_answer: normalizeEscalationText(row.assistant_answer || ''),
      user_comment: normalizeEscalationText(row.user_comment || ''),
      expected_answer: cleanedExpected || null,
    };
  });
}

export async function updateTriageStatus(
  scope: AccessScope,
  ticketId: number,
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'REJECTED',
  assignedTo?: number | null,
  adminReply?: string | null,
) {
  if (!(isSuperAdminRole(scope.roleCode) || isDepartmentAdminRole(scope.roleCode))) {
    return null;
  }

  const ticketRes = await pgPool.query(
    `
    SELECT id, created_by, department_code, assigned_to
    FROM triage_tickets
    WHERE id = $1
    LIMIT 1
    `,
    [ticketId],
  );
  const existing = ticketRes.rows[0];
  if (!existing) return null;

  const ticketDepartment = normalizeDepartmentCode(existing.department_code);
  if (isDepartmentAdminRole(scope.roleCode) && ticketDepartment !== strictDepartmentForScope(scope)) {
    return null;
  }

  let nextAssigned: number | null = existing.assigned_to == null ? null : Number(existing.assigned_to);

  if (assignedTo === null) {
    // Department admins cannot unassign out of their scope; they claim the ticket.
    nextAssigned = isSuperAdminRole(scope.roleCode) ? null : scope.userId;
  } else if (assignedTo != null) {
    const assigneeId = Number(assignedTo);
    if (!Number.isFinite(assigneeId) || assigneeId <= 0) {
      throw new Error('Invalid assignee');
    }
    const assigneeRes = await pgPool.query(
      `
      SELECT user_id, COALESCE(NULLIF(role_code, ''), 'USER') AS role_code, COALESCE(NULLIF(department_code, ''), 'HR') AS department_code
      FROM "user"
      WHERE user_id = $1
        AND deleted_at IS NULL
      LIMIT 1
      `,
      [assigneeId],
    );
    const assignee = assigneeRes.rows[0];
    if (!assignee) throw new Error('Selected admin not found. Please refresh and try again.');
    const assigneeRole = String(assignee.role_code || '').toUpperCase();
    const assigneeDept = normalizeDepartmentCode(assignee.department_code);
    if (!['HR_ADMIN', 'GA_ADMIN', 'ACC_ADMIN', 'SUPER_ADMIN'].includes(assigneeRole)) {
      throw new Error('Selected assignee is not an admin');
    }
    if (isDepartmentAdminRole(scope.roleCode)) {
      if (assigneeRole !== scope.roleCode || assigneeDept !== strictDepartmentForScope(scope)) {
        throw new Error('Can only assign within your admin role scope');
      }
    } else if (!isSuperAdminRole(scope.roleCode)) {
      throw new Error('Access denied');
    }
    nextAssigned = assigneeId;
  } else if (nextAssigned == null && isDepartmentAdminRole(scope.roleCode)) {
    nextAssigned = scope.userId;
  }

  const res = await pgPool.query(
    `
    UPDATE triage_tickets
    SET status = $1, assigned_to = $2, updated_at = NOW()
    WHERE id = $3
    RETURNING *
    `,
    [status, nextAssigned, ticketId],
  );
  const updated = res.rows[0] || null;
  if (!updated) return null;

  const replyText = String(adminReply || '').trim();
  if (replyText) {
    const ownerRes = await pgPool.query(
      `
      SELECT created_by, department_code
      FROM triage_tickets
      WHERE id = $1
      LIMIT 1
      `,
      [ticketId],
    );
    const owner = ownerRes.rows[0];
    if (owner?.created_by) {
      await notifyTriageReplyToRequester({
        scope,
        ticketId,
        targetUserId: Number(owner.created_by),
        fallbackDepartmentCode: normalizeDepartmentCode(owner.department_code),
        reply: replyText,
        status,
      }).catch(() => undefined);
    }
  }

  return updated;
}

export async function sendTriageReply(scope: AccessScope, ticketId: number, replyText: string) {
  const reply = String(replyText || '').trim();
  if (!reply) return null;

  const params: any[] = [ticketId];
  let where = 't.id = $1';
  if (isDepartmentAdminRole(scope.roleCode)) {
    // Strict role scope: department admins can reply only to their department escalations.
    params.push(strictDepartmentForScope(scope));
    where += ` AND t.department_code = $2`;
  } else if (!isSuperAdminRole(scope.roleCode)) {
    return null;
  }

  const ticketRes = await pgPool.query(
    `
    SELECT t.id, t.created_by, t.department_code
    FROM triage_tickets t
    WHERE ${where}
    LIMIT 1
    `,
    params,
  );
  const ticket = ticketRes.rows[0];
  if (!ticket) return null;
  await notifyTriageReplyToRequester({
    scope,
    ticketId: Number(ticket.id),
    targetUserId: Number(ticket.created_by),
    fallbackDepartmentCode: normalizeDepartmentCode(ticket.department_code),
    reply,
  });

  return { ticketId: Number(ticket.id), repliedTo: Number(ticket.created_by) };
}

export async function getTriageSummary(scope: AccessScope) {
  const params: any[] = [];
  let where = '';
  if (isDepartmentAdminRole(scope.roleCode)) {
    params.push(strictDepartmentForScope(scope));
    where = `WHERE department_code = $${params.length}`;
  } else if (!isSuperAdminRole(scope.roleCode)) {
    params.push(scope.userId);
    where = `WHERE created_by = $${params.length}`;
  }

  const res = await pgPool.query(
    `
    SELECT
      COUNT(*)::int AS total_count,
      COUNT(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS'))::int AS open_count
    FROM triage_tickets
    ${where}
    `,
    params,
  );

  const row = res.rows[0] || {};
  return {
    totalCount: Number(row.total_count || 0),
    openCount: Number(row.open_count || 0),
  };
}

async function validateScopePassword(scope: AccessScope, adminPassword: string, client: { query: (...args: any[]) => Promise<any> }) {
  const password = String(adminPassword || '');
  if (!password.trim()) {
    throw new Error('Account password is required');
  }

  const userRes = await client.query(
    `
    SELECT password
    FROM "user"
    WHERE user_id = $1
      AND deleted_at IS NULL
    LIMIT 1
    `,
    [scope.userId],
  );
  const user = userRes.rows[0];
  if (!user) {
    throw new Error('Account not found');
  }
  const ok = await verifyPassword(password, String(user.password || ''));
  if (!ok) {
    throw new Error('Invalid account password');
  }
}

export async function purgeTriageTickets(scope: AccessScope, adminPassword: string) {
  if (!(isSuperAdminRole(scope.roleCode) || isDepartmentAdminRole(scope.roleCode))) {
    return {
      deletedTickets: 0,
      deletedPayloadRows: 0,
      deletedNotificationRows: 0,
      deletedMessageRows: 0,
      sequenceReset: false,
    };
  }

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await validateScopePassword(scope, adminPassword, client);

    const params: any[] = [];
    let where = '';
    if (isDepartmentAdminRole(scope.roleCode)) {
      params.push(strictDepartmentForScope(scope));
      where = `WHERE department_code = $${params.length}`;
    }

    const idRes = await client.query(
      `
      SELECT id
      FROM triage_tickets
      ${where}
      `,
      params,
    );
    const ids = idRes.rows.map((r: any) => Number(r.id)).filter((v) => Number.isFinite(v));
    let deletedPayloadRows = 0;
    let deletedTickets = 0;
    let deletedNotificationRows = 0;
    let deletedMessageRows = 0;
    if (ids.length) {
      const notificationRes = await client.query(
        `
        DELETE FROM app_notifications
        WHERE
          (
            title ILIKE 'Escalation ticket #% submitted'
            OR title ILIKE 'Escalation ticket #% reply'
            OR title ILIKE 'Triage ticket #% assigned'
          )
          AND COALESCE(NULLIF(SUBSTRING(title FROM '#([0-9]+)'), ''), '0')::bigint = ANY($1::bigint[])
        `,
        [ids],
      );

      const messageRes = await client.query(
        `
        DELETE FROM messages
        WHERE
          subject ILIKE 'Escalation ticket #% reply'
          AND COALESCE(NULLIF(SUBSTRING(subject FROM '#([0-9]+)'), ''), '0')::bigint = ANY($1::bigint[])
        `,
        [ids],
      );

      const payloadRes = await client.query(
        `
        DELETE FROM triage_payload
        WHERE ticket_id = ANY($1::bigint[])
        `,
        [ids],
      );

      const ticketRes = await client.query(
        `
        DELETE FROM triage_tickets
        WHERE id = ANY($1::bigint[])
        `,
        [ids],
      );
      deletedNotificationRows = Number(notificationRes.rowCount || 0);
      deletedMessageRows = Number(messageRes.rowCount || 0);
      deletedPayloadRows = Number(payloadRes.rowCount || 0);
      deletedTickets = Number(ticketRes.rowCount || 0);
    }

    // Cleanup legacy orphan notification/message rows left by older purge logic.
    const orphanNotificationRes = await client.query(
      `
      DELETE FROM app_notifications n
      WHERE
        (
          n.title ILIKE 'Escalation ticket #% submitted'
          OR n.title ILIKE 'Escalation ticket #% reply'
          OR n.title ILIKE 'Triage ticket #% assigned'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM triage_tickets t
          WHERE t.id = COALESCE(NULLIF(SUBSTRING(n.title FROM '#([0-9]+)'), ''), '0')::bigint
        )
      `,
    );

    const orphanMessageRes = await client.query(
      `
      DELETE FROM messages m
      WHERE
        m.subject ILIKE 'Escalation ticket #% reply'
        AND NOT EXISTS (
          SELECT 1
          FROM triage_tickets t
          WHERE t.id = COALESCE(NULLIF(SUBSTRING(m.subject FROM '#([0-9]+)'), ''), '0')::bigint
        )
      `,
    );

    deletedNotificationRows += Number(orphanNotificationRes.rowCount || 0);
    deletedMessageRows += Number(orphanMessageRes.rowCount || 0);

    const remainingRes = await client.query(
      `
      SELECT COUNT(*)::int AS count
      FROM triage_tickets
      `,
    );
    const remaining = Number(remainingRes.rows?.[0]?.count || 0);
    let sequenceReset = false;
    if (remaining === 0) {
      const seqRes = await client.query(
        `
        SELECT pg_get_serial_sequence('triage_tickets', 'id') AS seq_name
        `,
      );
      const seqName = String(seqRes.rows?.[0]?.seq_name || '').trim();
      if (seqName) {
        await client.query('SELECT setval($1::regclass, 1, false)', [seqName]);
        sequenceReset = true;
      }
    }

    await client.query('COMMIT');
    return {
      deletedTickets,
      deletedPayloadRows,
      deletedNotificationRows,
      deletedMessageRows,
      sequenceReset,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
