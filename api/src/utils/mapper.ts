import { FindOptions, Includeable, ModelStatic, Optional, Op } from 'sequelize';

export const queryPage = async <T extends { pageNum?: number; pageSize?: number; order?: [string, 'ASC' | 'DESC'][]; params?: any; }>(
  model: ModelStatic<any>,
  queryParams: T,
  conditions?: {
    otherWhere?: FindOptions;
    include?: Includeable[] | Includeable;
  },
) => {
  const { pageNum = 1, pageSize = 10, order = [['created_at', 'DESC']], params, ...param } = queryParams;

  const directives = {};
  if (queryParams.pageNum) {
    Object.assign(directives, {
      offset: (Number(pageNum) - 1) * Number(pageSize),
      limit: Number(pageSize),
    });
  }
  if (conditions?.include) {
    Object.assign(directives, { include: conditions.include });
  }

  const where: Record<string, any> = { ...params };

  if (Array.isArray(params?.tags) && params.tags?.length > 0) {
    where.tag = { [Op.in]: params.tags.map(Number) };
    delete where.tags;
  }

  if (params?.fileName) {
    where.filename = {
      [Op.like]: `%${params.fileName}%`
    };
    delete where.fileName;
  }

  if (params?.beginTime && params?.endTime) {
    where.created_at = {
      [Op.between]: [params.beginTime, params.endTime + " " + "23:59:59"]
    };
    delete where.beginTime;
    delete where.endTime;
  } else if (params?.beginTime) {
    where.created_at = {
      [Op.gte]: params.beginTime
    };
    delete where.beginTime;
  } else if (params?.endTime) {
    where.created_at = {
      [Op.lte]: params.endTime + " " + "23:59:59"
    }
    delete where.endTime;
  }

  const res = await model.findAndCountAll({
    distinct: true,
    ...directives,
    where: {
      ...where,
      ...param
    },
    order,
    ...conditions?.otherWhere,
  });

  const list = {
    count: res.count,
    rows: res.rows || {},
  };

  return list;
};

export const queryList = async (model: ModelStatic<any>, where?: { [key: string]: any }, otherWhere?: any) => {
  // Ensure a valid object for Sequelize 'where' to avoid Object.keys(undefined)
  const safeWhere = where && typeof where === 'object' ? where : {};
  const res = await model.findAll({
    raw: true,
    ...otherWhere,
    where: safeWhere,
  });

  return res;
};

export const queryById = async <T>(
  model: ModelStatic<any>,
  where: { [id: string]: number | string },
  conditions?: {
    otherWhere?: FindOptions;
    include?: Includeable[] | Includeable;
  },
): Promise<T> => {
  const res = await model.findOne({
    where,
    ...conditions,
  });
  return (res ? res.dataValues : null) as T;
};

export const add = async <T extends Optional<any, any>>(model: ModelStatic<any>, data: T) => {
  try {
    const res = await model.create(data);
    return res.dataValues;
  } catch (error) {
    console.log(error);
  }
};

export const addAll = async <T extends Optional<any, string>[]>(model: ModelStatic<any>, data: T) => {
  const res = await model.bulkCreate(data);

  return res;
};

export const del = async (
  model: ModelStatic<any>,
  where: {
    [id: string]: any;
  },
) => {
  await model.destroy({ where });
};

export const getDetail = async <T>(
  model: ModelStatic<any>,
  where: { [id: string]: number },
  conditions?: {
    otherWhere?: FindOptions;
    include?: Includeable[] | Includeable;
  },
): Promise<T> => {
  const res = await model.findOne({
    where,
    ...conditions,
  });
  return (res ? res.dataValues : null) as T;
};

export const put = async <T>(
  model: ModelStatic<any>,
  where: { [id: string]: number | number[] | string | string[] | any },
  data: T,
) => {
  const res = await model.update(data, { where });
  return res;
};

export const queryConditionsData = async (model: ModelStatic<any>, where: { [key: string]: any }, otherWhere?: any) => {
  const res = await model.findAll({
    raw: true,
    ...otherWhere,
    where,
  });

  return res;
};

export const queryOne = async (model: ModelStatic<any>, where: { [key: string]: any }, otherWhere?: any) => {
  const res = await model.findOne({
    raw: true,
    ...otherWhere,
    where,
  });

  return res;
};

export const queryConditionsDataByOrder = async (
  model: ModelStatic<any>,
  where: { [key: string]: any },
  order: [string, 'ASC' | 'DESC'][],
  otherWhere?: any,
) => {
  const res = await model.findAll({
    raw: true,
    ...otherWhere,
    where,
    order,
  });

  return res;
};
