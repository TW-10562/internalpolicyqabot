import request from './request';

export interface SystemResetResult {
  confirmationText: string;
  adminUserName: string;
  adminPassword: string;
  tablesTruncated: string[];
  deletedByTable: Record<string, number>;
  invalidatedSessions: number;
}

const normalize = (raw: any) => {
  if (raw?.ok === true) {
    return { code: 200, result: raw.data };
  }
  if (raw?.ok === false) {
    const errorCode = String(raw?.error?.code || '').toUpperCase();
    const mappedCode =
      errorCode === 'BAD_REQUEST'
        ? 400
        : errorCode === 'FORBIDDEN'
          ? 403
          : errorCode === 'UNAUTHORIZED'
            ? 401
            : 500;
    return {
      code: mappedCode,
      message: raw?.error?.message || 'Request failed',
      errorCode,
    };
  }
  return raw;
};

export async function executeSystemReset(accountPassword: string, confirmationText: string) {
  const raw = await request<any>('/api/system-reset/execute', {
    method: 'POST',
    data: {
      accountPassword,
      confirmationText,
    },
  });
  return normalize(raw) as { code: number; result?: SystemResetResult; message?: string };
}
