import { PrepareOutput } from '../service/genTaskService';
import Joi from 'joi';

interface ITranslateTaskFormData {
  sourceText: string;
  sourceLang: string;
  targetLang: string;
}

const translateTask = async (formData: ITranslateTaskFormData) => {
  const judge = Joi.object({
    sourceText: Joi.string().required(),
    sourceLang: Joi.string().required(),
    targetLang: Joi.string().required(),
  });
  await judge.validateAsync(formData);

  const data = JSON.stringify({
    sourceText: formData.sourceText,
    sourceLang: formData.sourceLang,
    targetLang: formData.targetLang
  });
  return [{ metadata: data, sort: 1 } as PrepareOutput];
};

export { translateTask, ITranslateTaskFormData };
