import { ModelStatic } from 'sequelize';

export const queryConditionsData = async (model: ModelStatic<any>, where: { [key: string]: any }, otherWhere?: any) => {
  const res = await model.findAll({
    raw: true,
    ...otherWhere,
    where,
  });
  return res;
};
