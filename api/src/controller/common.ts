import { formatHumpLineTransfer } from '@/utils';
import { Context } from 'koa';
import { ModelStatic, Op } from 'sequelize';

export const formatHandle = async (ctx: Context, next: () => Promise<void>) => {
  const res = formatHumpLineTransfer(ctx.state.formatData);
  ctx.state.formatData = res;
  await next();
};

export const verifyMid =
  (sqlNames: string[], Model: ModelStatic<any>, judge?: string) => async (ctx: Context, next: () => Promise<void>) => {
    try {
      const { body } = ctx.request;

      const res = formatHumpLineTransfer(body, 'line');
      const whereOpt = {};

      if (judge) {
        Object.assign(whereOpt, { [judge]: { [Op.ne]: res[judge] } });
      }

      sqlNames.forEach((item, index) => {
        if (res[item]) {
          Object.assign(whereOpt, { [sqlNames[index]]: res[item] });
        }
      });

      const isRepeat = await Model.findOne({
        raw: true,
        attributes: [...sqlNames],
        where: whereOpt,
      });

      if (isRepeat) {
        console.error(ctx.request.body);
        ctx.app.emit(
          'error',
          {
            code: '400',
            message: '内容が既に存在します',
          },
          ctx,
        );
        return;
      }
    } catch (error) {
      console.error(error);
      ctx.app.emit(
        'error',
        {
          code: '500',
          message: 'サーバー内部エラー',
        },
        ctx,
      );
    }

    await next();
  };
