import { Context } from 'koa';

export default function errHandlerFn(err: any, ctx: Context) {
  // Some call sites historically emit strings (`code: '400'`), others numbers.
  // Normalize and tolerate missing/invalid inputs to avoid crashing the server.
  const rawCode = err?.code ?? err?.status;
  const parsedCode =
    typeof rawCode === 'number'
      ? rawCode
      : typeof rawCode === 'string'
        ? Number.parseInt(rawCode, 10)
        : NaN;

  const status =
    Number.isFinite(parsedCode) && parsedCode >= 400 && parsedCode <= 599
      ? parsedCode
      : 500;

  const message = typeof err === 'string' ? err : err?.message || 'Internal server error';
  const logAuthErrors = process.env.LOG_AUTH_ERRORS === '1';
  if (status >= 500) {
    console.error('Unhandled error caught by errHandler:', err);
  } else if ((status === 401 || status === 403) && logAuthErrors) {
    console.warn('Auth/permission response:', { status, message });
  } else if (status !== 401 && status !== 403) {
    console.warn('Handled request error:', { status, message });
  }

  if (!ctx) {
    // If someone emitted the event without ctx, we can only log; do not throw.
    console.error('errHandler invoked without Koa ctx (caller likely used ctx.app.emit without ctx arg).', {
      status,
      message,
    });
    return;
  }

  ctx.status = status;
  // Provide a consistent error shape. Include stack trace in non-production for debugging.
  const body: any = {
    code: status,
    message,
  };
  if (process.env.NODE_ENV !== 'production' && err?.stack) {
    body.stack = err.stack;
  }

  ctx.body = body;
}
