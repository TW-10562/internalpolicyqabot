import request from './request';

export type AdminUser = {
  user_id: number;
  user_name?: string;
  emp_id: string;
  email?: string;
  first_name: string;
  last_name: string;
  job_role_key?: string;
  area_of_work_key?: string;
  role_code: 'USER' | 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN' | 'SUPER_ADMIN';
  department_code: 'HR' | 'GA' | 'ACC' | 'SYSTEMS';
  status: string;
  updated_at: string;
};

export type AdminUserPayload = {
  firstName: string;
  lastName: string;
  email: string;
  employeeCode?: string;
  // Backward-compatible field used by the backend to populate emp_id.
  // We send employeeCode (or email as fallback) here.
  employeeId: string;
  userJobRole?: string;
  areaOfWork?: string;
  roleCode: 'USER' | 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN' | 'SUPER_ADMIN';
  departmentCode: 'HR' | 'GA' | 'ACC' | 'SYSTEMS';
  isActive?: boolean;
  password?: string;
};

export async function fetchAdminUsers(query?: string) {
  const q = String(query || '').trim();
  const url = q ? `/api/admin/users?q=${encodeURIComponent(q)}` : '/api/admin/users';
  return request<{ code: number; result?: AdminUser[]; message?: string }>(url, {
    method: 'GET',
  });
}

export async function createAdminUser(payload: AdminUserPayload) {
  return request<{ code: number; result?: AdminUser; message?: string }>('/api/admin/users', {
    method: 'POST',
    data: payload,
  });
}

export async function updateAdminUser(userId: string, payload: AdminUserPayload) {
  return request<{ code: number; result?: AdminUser; message?: string }>(`/api/admin/users/${userId}`, {
    method: 'PUT',
    data: payload,
  });
}

export async function deleteAdminUser(userId: string) {
  return request<{ code: number; result?: { success: boolean }; message?: string }>(`/api/admin/users/${userId}`, {
    method: 'DELETE',
  });
}

export async function bulkDeleteAdminUsers(userIds: Array<string | number>) {
  return request<{ code: number; result?: { success: boolean; deletedCount: number }; message?: string }>(
    '/api/users/bulk-delete',
    {
      method: 'DELETE',
      data: { userIds },
    },
  );
}

export async function importAdminUsersCsv(file: File) {
  const form = new FormData();
  form.append('file', file);
  return request<{
    code: number | string;
    result?: { success: boolean; insertedCount: number; totalRows: number; validRows: number; invalidRows: number };
    message?: string;
    errors?: Array<{ row: number; field: string; value?: string; message: string }>;
    totalRows?: number;
    validRows?: number;
    invalidRows?: number;
  }>(
    '/api/users/upload-csv',
    {
      method: 'POST',
      data: form,
    },
  );
}
