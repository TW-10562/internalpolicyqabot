import { Context } from 'koa';

export default function errHandlerFn(err: any, ctx: Context) {
  let status = 500;
  switch (err.code) {
    case '400':
      status = 400;
      break;
    case '401':
      status = 401;
      break;
    case '403':
      status = 403;
      break;
    case '409':
      status = 409;
      break;
    default:
      status = 500;
      break;
  }

  const message = typeof err === 'string' ? err : err?.message || 'Internal server error';
  const logAuthErrors = process.env.LOG_AUTH_ERRORS === '1';
  if (status >= 500) {
    console.error('Unhandled error caught by errHandler:', err);
  } else if ((status === 401 || status === 403) && logAuthErrors) {
    console.warn('Auth/permission response:', { status, message });
  } else if (status !== 401 && status !== 403) {
    console.warn('Handled request error:', { status, message });
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
