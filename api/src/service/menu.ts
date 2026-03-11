import Menu from '@/mysql/model/menu.model';
import { menusSqlType } from '@/types/menu';
import { Op } from 'sequelize';

export const getRoutersSer = async () => {
  const firstRes = (await Menu.findAll({
    where: {
      status: '0',
      [Op.or]: [{ menu_type: 'M' }, { menu_type: 'C' }],
    },
  })) as unknown as menusSqlType[];

  return firstRes;
};

export const getMenusSer = async (params: { [key: string]: unknown }) => {
  const res = await Menu.findAll({
    raw: true,
    where: params,
  });

  return res;
};
