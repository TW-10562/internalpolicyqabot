import { Context } from 'koa';

export default (message?: string) => async (ctx: Context) => {
  try {
    let body = {} as { code: string | number; message: string };
    if (ctx.state.buffer) {
      body = {
        code: 200,
        message: 'buffer',
      };
      ctx.body = ctx.state.buffer;
    } else {
      body = {
        code: 200,
        message: message || '操作は成功しました',
      };
      const repObj = {
        code: 200,
        message: message || '操作は成功しました',
      };
      if (ctx.state.formatData) Object.assign(repObj, { result: ctx.state.formatData });
      ctx.body = repObj;
    }
  } catch (error) {
    console.error(error);
    return ctx.app.emit('error', {}, ctx);
  }
};
