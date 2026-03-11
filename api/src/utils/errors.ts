/**
 * Production-grade Error Handling Utilities
 * Standardized error responses with codes for debugging
 */

// Error codes for different scenarios
export enum ErrorCode {
  // Client errors (4xx)
  BAD_REQUEST = 'E400',
  VALIDATION_ERROR = 'E400_VALIDATION',
  UNAUTHORIZED = 'E401',
  TOKEN_EXPIRED = 'E401_TOKEN_EXPIRED',
  TOKEN_INVALID = 'E401_TOKEN_INVALID',
  FORBIDDEN = 'E403',
  NOT_FOUND = 'E404',
  CONFLICT = 'E409',
  RATE_LIMITED = 'E429',
  
  // Server errors (5xx)
  INTERNAL_ERROR = 'E500',
  DATABASE_ERROR = 'E500_DB',
  EXTERNAL_SERVICE_ERROR = 'E502',
  SERVICE_UNAVAILABLE = 'E503',
}

// Error messages in Japanese and English
export const ErrorMessages: Record<ErrorCode, { en: string; ja: string }> = {
  [ErrorCode.BAD_REQUEST]: {
    en: 'Bad request',
    ja: '不正なリクエストです'
  },
  [ErrorCode.VALIDATION_ERROR]: {
    en: 'Validation failed',
    ja: '入力検証に失敗しました'
  },
  [ErrorCode.UNAUTHORIZED]: {
    en: 'Unauthorized',
    ja: '認証が必要です'
  },
  [ErrorCode.TOKEN_EXPIRED]: {
    en: 'Token expired',
    ja: 'トークンの有効期限が切れています'
  },
  [ErrorCode.TOKEN_INVALID]: {
    en: 'Invalid token',
    ja: '無効なトークンです'
  },
  [ErrorCode.FORBIDDEN]: {
    en: 'Access forbidden',
    ja: 'アクセス権限がありません'
  },
  [ErrorCode.NOT_FOUND]: {
    en: 'Resource not found',
    ja: 'リソースが見つかりません'
  },
  [ErrorCode.CONFLICT]: {
    en: 'Resource conflict',
    ja: 'リソースが競合しています'
  },
  [ErrorCode.RATE_LIMITED]: {
    en: 'Too many requests',
    ja: 'リクエストが多すぎます'
  },
  [ErrorCode.INTERNAL_ERROR]: {
    en: 'Internal server error',
    ja: 'サーバー内部エラー'
  },
  [ErrorCode.DATABASE_ERROR]: {
    en: 'Database error',
    ja: 'データベースエラー'
  },
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: {
    en: 'External service error',
    ja: '外部サービスエラー'
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    en: 'Service temporarily unavailable',
    ja: 'サービスは一時的に利用できません'
  },
};

// API Response interface
export interface ApiResponse<T = any> {
  code: number;
  errorCode?: ErrorCode;
  message: string;
  result?: T;
  timestamp: string;
  requestId?: string;
}

// Create success response
export function successResponse<T>(result: T, message: string = 'Success'): ApiResponse<T> {
  return {
    code: 200,
    message,
    result,
    timestamp: new Date().toISOString(),
  };
}

// Create error response
export function errorResponse(
  httpCode: number,
  errorCode: ErrorCode,
  details?: string,
  lang: 'en' | 'ja' = 'ja'
): ApiResponse {
  const baseMessage = ErrorMessages[errorCode]?.[lang] || ErrorMessages[ErrorCode.INTERNAL_ERROR][lang];
  return {
    code: httpCode,
    errorCode,
    message: details ? `${baseMessage}: ${details}` : baseMessage,
    timestamp: new Date().toISOString(),
  };
}

// Custom API Error class
export class ApiError extends Error {
  public httpCode: number;
  public errorCode: ErrorCode;
  public details?: string;

  constructor(httpCode: number, errorCode: ErrorCode, details?: string) {
    super(details || ErrorMessages[errorCode]?.en || 'Unknown error');
    this.httpCode = httpCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

// Validation error
export function validationError(errors: string[]): ApiResponse {
  return {
    code: 400,
    errorCode: ErrorCode.VALIDATION_ERROR,
    message: `Validation failed: ${errors.join(', ')}`,
    timestamp: new Date().toISOString(),
  };
}

// Not found error
export function notFoundError(resource: string): ApiResponse {
  return errorResponse(404, ErrorCode.NOT_FOUND, resource);
}

// Unauthorized error
export function unauthorizedError(reason?: string): ApiResponse {
  return errorResponse(401, ErrorCode.UNAUTHORIZED, reason);
}

// Rate limit error
export function rateLimitError(resetIn: number): ApiResponse {
  return {
    code: 429,
    errorCode: ErrorCode.RATE_LIMITED,
    message: `Too many requests. Try again in ${Math.ceil(resetIn / 1000)} seconds.`,
    timestamp: new Date().toISOString(),
  };
}

// Database error
export function databaseError(operation: string): ApiResponse {
  console.error(`[DB Error] Operation: ${operation}`);
  return errorResponse(500, ErrorCode.DATABASE_ERROR, 'Please try again later');
}

// Log error for monitoring
export function logError(error: Error | ApiError, context?: Record<string, any>): void {
  const timestamp = new Date().toISOString();
  const errorInfo = {
    timestamp,
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error instanceof ApiError && { 
      httpCode: error.httpCode, 
      errorCode: error.errorCode 
    }),
    context,
  };
  console.error('[ERROR]', JSON.stringify(errorInfo, null, 2));
}
