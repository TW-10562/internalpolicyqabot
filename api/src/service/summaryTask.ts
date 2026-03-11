import { PrepareOutput } from '../service/genTaskService';
import Joi from 'joi';

interface ISummaryTaskFormData {
  text: string;
}

const summaryTask = async (formData: ISummaryTaskFormData) => {
  const judge = Joi.object({
    text: Joi.string().required(),
  });
  await judge.validateAsync(formData);

  const data = JSON.stringify({
    text: formData.text,
  });
  return [{ metadata: data, sort: 1 } as PrepareOutput];
};

export { summaryTask, ISummaryTaskFormData };
