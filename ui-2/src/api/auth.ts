// Authentication API functions
import request, { setToken, removeToken, getToken } from './request';

export interface LoginParams {
  userName: string;
  password: string;
}

export interface LoginResponse {
  code: number | string;
  message: string;
  result?: {
    token: string;
    userId?: number;
    empId?: string;
    roleCode?: 'USER' | 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN' | 'SUPER_ADMIN';
    departmentCode?: 'HR' | 'GA' | 'ACC' | 'SYSTEMS' | 'OTHER';
  };
}

export interface UserInfo {
  id: string;
  username: string;
  name: string;
  email?: string;
  role?: string;
  department?: string;
}

// Login - uses /user/login endpoint
export async function login(params: LoginParams): Promise<LoginResponse> {
  // Preferred endpoint: employeeId based login
  let response = await request<LoginResponse>('/api/auth/login', {
    method: 'POST',
    data: { employeeId: params.userName, password: params.password },
  });

  // Legacy fallback: username based login only when endpoint is unavailable
  if (response.code === 404 || response.code === '404' || response.code === 405 || response.code === '405') {
    response = await request<LoginResponse>('/user/login', {
      method: 'POST',
      data: params,
    });
  }

  // Additional compatibility fallback for deployments with /api/user/login
  if ((response.code === 404 || response.code === '404') && response.message?.includes('Not Found')) {
    response = await request<LoginResponse>('/api/user/login', {
      method: 'POST',
      data: params,
    });
  }
  
  if (response.code === 200 && response.result?.token) {
    setToken(response.result.token);
  }
  
  return response;
}

// Temporary Microsoft SSO (mock) login.
// TODO(EntraID): Replace this with a real Microsoft Entra ID OAuth2/OIDC flow.
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

// Get user info
export async function getUserInfo(): Promise<{ code: number; result: UserInfo }> {
  return request('/user/getInfo', {
    method: 'GET',
  });
}

// Check if user is logged in
export function isLoggedIn(): boolean {
  return !!getToken();
}

// Export token functions
export { getToken, setToken, removeToken };
