// API Request utility for UI2
const rawBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || '/dev-api';
const BASE_URL = rawBaseUrl.replace(/\/+$/, '');

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  params?: Record<string, any>;
  data?: any;
  headers?: Record<string, string>;
}

// Get token from localStorage
export const getToken = (): string | null => {
  return localStorage.getItem('token');
};

// Set token to localStorage
export const setToken = (token: string): void => {
  localStorage.setItem('token', token);
};

// Remove token from localStorage
export const removeToken = (): void => {
  localStorage.removeItem('token');
};

// Transform params to query string
const tansParams = (params: Record<string, any>): string => {
  let result = '';
  for (const propName of Object.keys(params)) {
    const value = params[propName];
    const part = encodeURIComponent(propName) + '=';
    if (value !== null && value !== '' && typeof value !== 'undefined') {
      if (typeof value === 'object') {
        for (const key of Object.keys(value)) {
          if (value[key] !== null && value[key] !== '' && typeof value[key] !== 'undefined') {
            const params = propName + '[' + key + ']';
            const subPart = encodeURIComponent(params) + '=';
            result += subPart + encodeURIComponent(value[key]) + '&';
          }
        }
      } else {
        result += part + encodeURIComponent(value) + '&';
      }
    }
  }
  return result;
};

// Main request function
export async function request<T = any>(url: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', params, data, headers = {} } = options;
  
  let fullUrl = `${BASE_URL}${url}`;
  
  // Add params to URL for GET requests
  if (params && method === 'GET') {
    const queryString = tansParams(params);
    if (queryString) {
      fullUrl += (fullUrl.includes('?') ? '&' : '?') + queryString.slice(0, -1);
    }
  }
  
  // Set default headers
  const requestHeaders: Record<string, string> = {
    ...headers,
  };
  
  // Add auth token
  const token = getToken();
  if (token) {
    requestHeaders['Authorization'] = `Bearer ${token}`;
  }
  
  // Add content type for POST/PUT
  if (data && !(data instanceof FormData)) {
    requestHeaders['Content-Type'] = 'application/json;charset=utf-8';
  }
  
  const fetchOptions: RequestInit = {
    method,
    headers: requestHeaders,
  };
  
  if (data) {
    fetchOptions.body = data instanceof FormData ? data : JSON.stringify(data);
  }
  
  try {
    const response = await fetch(fullUrl, fetchOptions);

    // Read response body once as text, then try to parse JSON from it.
    const rawText = await response.text();
    let result: any;
    try {
      result = rawText ? JSON.parse(rawText) : {};
    } catch (e) {
      // If parsing fails, normalize to an error-like shape using the raw text
      result = {
        code: response.status,
        message: rawText || response.statusText || 'Request failed',
      };
    }

    // Handle 401 unauthorized first (also when HTTP status is non-2xx)
    if (response.status === 401 || result.code === '401' || result.code === 401) {
      removeToken();
      if (window.location.pathname !== '/') {
        window.location.href = '/';
      }
      return {
        code: 401,
        message: 'Session expired, please login again',
        status: 401,
      } as any;
    }

    // Handle HTTP errors
    if (!response.ok) {
      // Return normalized error, but preserve structured fields (e.g., errors array)
      return {
        ...result,
        code: result.code || response.status,
        message: result.message || response.statusText || 'Request failed',
        status: response.status,
      } as any;
    }

    return result;
  } catch (error) {
    console.error('Request error:', error);
    // Surface a consistent error shape
    return {
      code: 500,
      message: (error as Error).message || 'Request error',
    } as any;
  }
}

export default request;
