import request from './request';

export type TriageStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'REJECTED';
export type TriageDepartmentCode = 'HR' | 'GA' | 'ACC' | 'OTHER';

export interface TriageTicket {
  id: number;
  department_code: TriageDepartmentCode;
  status: TriageStatus;
  created_by: number;
  assigned_to: number | null;
  created_at: string;
  updated_at: string;
  issue_type: string;
  user_comment: string;
  conversation_id: string | null;
  message_id: string | null;
  user_query_original: string;
  assistant_answer: string;
  expected_answer: string | null;
  retrieved_source_ids: string[] | null;
  retrieval_query_used: string | null;
  model_name: string | null;
  payload_timestamp: string;
  created_by_user_name: string | null;
  created_by_emp_id: string | null;
  created_by_department_code: string | null;
  assigned_to_user_name: string | null;
  assigned_to_emp_id: string | null;
}

export interface TriageAssignee {
  userId: number;
  userName: string;
  empId: string | null;
  departmentCode: TriageDepartmentCode;
  roleCode: string;
}

export interface TriageSummary {
  openCount: number;
  totalCount: number;
}

const normalize = (raw: any) => {
  if (raw?.ok === true) {
    return { code: 200, result: raw.data };
  }
  if (raw?.ok === false) {
    return { code: 500, message: raw?.error?.message || 'Request failed' };
  }
  return raw;
};

export async function listTriageTickets(pageNum = 1, pageSize = 50) {
  const raw = await request<any>(
    '/api/triage/tickets',
    { method: 'GET', params: { pageNum, pageSize } },
  );
  return normalize(raw) as { code: number; result?: { rows: TriageTicket[] } | TriageTicket[]; message?: string };
}

export async function updateTriageTicketStatus(id: number, status: TriageStatus, adminReply?: string) {
  const raw = await request<any>(
    `/api/triage/tickets/${id}/status`,
    { method: 'PATCH', data: { status, adminReply: adminReply || null } },
  );
  return normalize(raw) as { code: number; result?: TriageTicket; message?: string };
}

export async function listTriageAssignees(departmentCode?: TriageDepartmentCode) {
  const raw = await request<any>(
    '/api/triage/assignees',
    { method: 'GET', params: departmentCode ? { departmentCode } : {} },
  );
  return normalize(raw) as { code: number; result?: { rows: TriageAssignee[] } | TriageAssignee[]; message?: string };
}

export async function sendTriageReply(ticketId: number, reply: string) {
  const raw = await request<any>(
    `/api/triage/tickets/${ticketId}/reply`,
    { method: 'POST', data: { reply } },
  );
  return normalize(raw) as { code: number; result?: { ticketId: number; repliedTo: number }; message?: string };
}

export async function getTriageSummary() {
  const raw = await request<any>(
    '/api/triage/summary',
    { method: 'GET' },
  );
  return normalize(raw) as { code: number; result?: TriageSummary; message?: string };
}

export async function purgeTriageTickets(adminPassword: string) {
  const raw = await request<any>(
    '/api/triage/tickets/purge',
    { method: 'DELETE', data: { adminPassword } },
  );
  return normalize(raw) as { code: number; result?: { deletedTickets: number; deletedPayloadRows: number; sequenceReset?: boolean }; message?: string };
}
