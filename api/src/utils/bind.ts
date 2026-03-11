import { queryConditionsData } from '../service';

export const bindCheck = async (model: any, where: { [key: string]: string[] }): Promise<any[]> => {
  const res = await queryConditionsData(model, where);
  return res;
};
