import { userType } from '@/types';
import Joi from 'joi';
import { Context } from 'koa';

export const loginSchema = Joi.object({
  userName: Joi.string().min(4).max(64).required(),
  password: Joi.string().min(4).max(128).required()
});

export const userSchema = async (ctx: Context, next: () => Promise<void>) => {
  const { userName, password: pwd } = ctx.request.body as userType;

  try {
    await loginSchema.validateAsync({ userName, password: pwd });
  } catch (error) {
    console.error(ctx.request.body);
    return ctx.app.emit(
      'error',
      {
        code: '400',
        message: 'フォーマットが間違っています',
      },
      ctx,
    );
  }
  await next();
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
