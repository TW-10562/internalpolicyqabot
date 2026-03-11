import { PrepareOutput } from '../service/genTaskService';
import Joi from 'joi';

interface IFileUploadTaskFormData {
  files: Buffer[];
  tags: number[];
  userName: string;
}

const fileUploadTask = async (formData: IFileUploadTaskFormData) => {
  const judge = Joi.object({
    files: Joi.array().required(),
    tags: Joi.array().items(Joi.number()).required(),
    userName: Joi.string().required(),
  });
  await judge.validateAsync(formData);

  const data = JSON.stringify({
    files: formData.files,
    tags: formData.tags,
    userName: formData.userName,
  });
  return [{ metadata: data, sort: 1 } as PrepareOutput];
};

export { fileUploadTask, IFileUploadTaskFormData };
