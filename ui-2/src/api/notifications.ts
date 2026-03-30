import request from './request';

export type AppNotification = {
  id: number;
  user_id: number | null;
  department_code?: 'HR' | 'GA' | 'ACC' | 'OTHER';
  type: string;
  title: string;
  body: string;
  payload_json: Record<string, any>;
  is_read: boolean;
  created_at: string;
  read_at: string | null;
};

export function listNotifications(pageNum = 1, pageSize = 50) {
  return request<{ ok: boolean; data: { rows: AppNotification[]; total: number; page_num: number; page_size: number }; error: any }>(
    '/api/notifications',
    { method: 'GET', params: { pageNum, pageSize } },
  );
}

export function markNotificationRead(id: number) {
  return request<{ ok: boolean; data: { id: number; is_read: boolean }; error: any }>(
    `/api/notifications/${id}/read`,
    { method: 'PATCH' as any },
  );
}

export function markAllNotificationsRead() {
  return request<{ ok: boolean; data: { markedRead: number }; error: any }>(
    '/api/notifications/mark-all-read',
    { method: 'PATCH' as any },
  );
}

export function deleteNotificationsBatch(ids: number[]) {
  return request<{ ok: boolean; data: { deleted: number }; error: any }>(
    '/api/notifications/delete-batch',
    { method: 'POST', data: { ids } },
  );
}

export function purgeAllUserNotifications() {
  return request<{ ok: boolean; data: { appDeleted: number; legacyDeleted: number; totalDeleted: number; scope: string }; error: any }>(
    '/api/notifications/purge-users',
    { method: 'DELETE' },
  );
}
