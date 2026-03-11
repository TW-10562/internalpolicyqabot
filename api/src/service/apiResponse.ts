export type ApiErrorBody = {
  code: string;
  message: string;
};

export function ok<T>(data: T) {
  return { ok: true, data, error: null as null };
}

export function fail(code: string, message: string) {
  return { ok: false, data: null, error: { code, message } as ApiErrorBody };
}

