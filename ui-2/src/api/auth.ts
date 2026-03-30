// Authentication API functions — SSO (Microsoft) only
import request, { setToken, removeToken, getToken } from './request';

export interface LoginResponse {
  code: number | string;
  message: string;
  result?: {
    token: string;
    userId?: number;
    empId?: string;
    email?: string;
    displayName?: string;
    department?: string;
    roleCode?: 'USER' | 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN' | 'SUPER_ADMIN';
    departmentCode?: 'HR' | 'GA' | 'ACC' | 'OTHER';
  };
}

export async function loginWithMicrosoft(
  accessToken: string,
  department?: string,
  employeeId?: string,
): Promise<LoginResponse> {
  const response = await request<LoginResponse>('/api/auth/sso/microsoft', {
    method: 'POST',
    data: { accessToken, department, employeeId },
  });

  if (response.code === 200 && response.result?.token) {
    setToken(response.result.token);
  }

  return response;
}

export async function loginWithMicrosoftMock(email: string): Promise<LoginResponse> {
  const response = await request<LoginResponse>('/api/auth/sso/microsoft/mock', {
    method: 'POST',
    data: { email },
  });

  if (response.code === 200 && response.result?.token) {
    setToken(response.result.token);
  }

  return response;
}

// Logout
export async function logout(): Promise<void> {
  try {
    await request('/api/auth/logout', {
      method: 'POST',
    });
  } catch (error) {
    console.error('Logout error:', error);
  } finally {
    removeToken();
  }
}

// Check if user is logged in
export function isLoggedIn(): boolean {
  return !!getToken();
}

// Export token functions
export { getToken, setToken, removeToken };
