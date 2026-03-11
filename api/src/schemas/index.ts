import Joi from 'joi';
import { Context } from 'koa';

export const addEditSchema = (judge: Joi.ObjectSchema<any>) => async (ctx: Context, next: () => Promise<void>) => {
  try {
    const list = ctx.request.body;
    const validated = await judge.validateAsync(list, {
      abortEarly: false,
      convert: true,
    });
    ctx.request.body = validated;

    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit(
      'error',
      {
        code: '400',
        message: 'アップロードパラメータを確認してください',
      },
      ctx,
    );
  }
};

export const judgeIdSchema = () => async (ctx: Context, next: () => Promise<void>) => {
  try {
    const list = ctx.request.path.split('/');
    const ids = list[list.length - 1];
    const idsList = ids.split(',');

    ctx.state.ids = idsList;
  } catch (error) {
    console.error(ctx.request.body);
    return ctx.app.emit('error', {
      code: '400',
      message: 'IDのフォーマットが間違っています',
    }, ctx);
  }
  await next();
};
