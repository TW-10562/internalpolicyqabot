import request from './request';

export type HistoryConversation = {
  conversation_id: string;
  user_id?: number;
  user_name?: string;
  emp_id?: string;
  department_code?: string;
  title: string;
  last_message: string;
  updated_at: string;
};

export type HistoryMessage = {
  message_id: string;
  role: 'user' | 'assistant';
  original_text: string;
  detected_language: 'ja' | 'en';
  translated_text: string | null;
  model_answer_text: string | null;
  rag_used: boolean;
  source_ids: string[];
  token_input: number | null;
  token_output: number | null;
  metadata: Record<string, any>;
  created_at: string;
};

export type HistoryUserOption = {
  user_id: number;
  emp_id: string | null;
  user_name: string | null;
  department_code: string | null;
  conversation_count: number;
  last_activity_at: string | null;
};

export function listHistory(pageNum = 1, pageSize = 20, opts?: { userId?: number; allUsers?: boolean }) {
  const params: Record<string, any> = { pageNum, pageSize };
  if (typeof opts?.userId === 'number' && Number.isFinite(opts.userId)) params.userId = opts.userId;
  if (opts?.allUsers === true) params.allUsers = true;
  return request<{ ok: boolean; data: { rows: HistoryConversation[]; total: number; page_num: number; page_size: number }; error: any }>(
    '/api/history',
    { method: 'GET', params },
  );
}

export function listHistoryUsers(pageNum = 1, pageSize = 25, opts?: { query?: string }) {
  const params: Record<string, any> = { pageNum, pageSize };
  if (opts?.query) params.query = opts.query;
  return request<{ ok: boolean; data: { rows: HistoryUserOption[]; total: number; page_num: number; page_size: number }; error: any }>(
    '/api/history/users',
    { method: 'GET', params },
  );
}

export function getHistoryConversation(conversationId: string, opts?: { userId?: number }) {
  const params: Record<string, any> = {};
  if (typeof opts?.userId === 'number' && Number.isFinite(opts.userId)) params.userId = opts.userId;
  return request<{ ok: boolean; data: { conversation: HistoryConversation; messages: HistoryMessage[] }; error: any }>(
    `/api/history/${conversationId}`,
    { method: 'GET', params },
  );
}

export function deleteHistoryConversation(conversationId: string, opts?: { userId?: number }) {
  const params: Record<string, any> = {};
  if (typeof opts?.userId === 'number' && Number.isFinite(opts.userId)) params.userId = opts.userId;
  return request<{ ok: boolean; data: { deleted: boolean }; error: any }>(
    `/api/history/${conversationId}`,
    { method: 'DELETE', params },
  );
}
