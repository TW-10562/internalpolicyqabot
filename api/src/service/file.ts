import file from '@/mysql/model/file.model';
import Tag from '@/mysql/model/file_tag.model'
import { IFile } from '@/types/file';

export const putFileInfo = async (datas) => {
  const { id, ...data } = datas;
  const res = await file.update(data, { where: { id: id } });

  return res[0] > 0;
};

export const postNewTag = async (tag) => {
  const existing = await Tag.findOne({ where: { name: tag.name } });
  if (existing) {
    throw new Error('このタグ名はすでに存在しています');
  }
  const res = (await Tag.create(tag)) as any;
  return res || {};
};

export const putTag = async (datas) => {
  const { id, ...data } = datas;
  const res = await Tag.update(data, { where: { id: id } });

  return res[0] > 0;
};

export const delTag = async (id) => {
  const res = await Tag.destroy({ where: { id: id } });
  return res > 0;
};