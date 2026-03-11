import { PrepareOutput } from '@/service/genTaskService';
import Joi from 'joi';

interface IChatTaskFormData {
  prompt: string;
  fieldSort: number;
  taskId?: string;
  fileId: number[];
  allFileSearch: boolean;
  useMcp: boolean;
  // injected by server for downstream storage/auditing
  userName?: string;
  userId?: number;
  departmentCode?: string;
  processingPath?: string;
  detectedLanguage?: string;
  ragTriggered?: boolean;
  dualLanguageEnabled?: boolean;
  originalQuery?: string;
  queryForRAG?: string;
  usedFileIds?: number[];
  roleCode?: string;
}

const chatTask = async (formData: IChatTaskFormData) => {
  const judge =
    formData.fieldSort >= 1
      ? Joi.object({
          prompt: Joi.string().required(),
          fieldSort: Joi.number().required(),
          taskId: Joi.string().required(),
          fileId: Joi.array().items(Joi.number()).required(),
          allFileSearch: Joi.boolean().required(),
          useMcp: Joi.boolean().required(),
          processingPath: Joi.string().optional(),
          userId: Joi.number().optional(),
          departmentCode: Joi.string().optional(),
          detectedLanguage: Joi.string().optional(),
          ragTriggered: Joi.boolean().optional(),
          dualLanguageEnabled: Joi.boolean().optional(),
          originalQuery: Joi.string().optional(),
          queryForRAG: Joi.string().optional(),
          usedFileIds: Joi.array().items(Joi.number()).optional(),
          roleCode: Joi.string().optional(),
        }).unknown(true)
      : Joi.object({
          prompt: Joi.string().allow('').required(),
          fieldSort: Joi.number().required(),
          taskId: Joi.string().required(),
          fileId: Joi.array().items(Joi.number()).required(),
          allFileSearch: Joi.boolean().required(),
          useMcp: Joi.boolean().required(),
          processingPath: Joi.string().optional(),
          userId: Joi.number().optional(),
          departmentCode: Joi.string().optional(),
          detectedLanguage: Joi.string().optional(),
          ragTriggered: Joi.boolean().optional(),
          dualLanguageEnabled: Joi.boolean().optional(),
          originalQuery: Joi.string().optional(),
          queryForRAG: Joi.string().optional(),
          usedFileIds: Joi.array().items(Joi.number()).optional(),
          roleCode: Joi.string().optional(),
        }).unknown(true);
  await judge.validateAsync(formData);
  const data = JSON.stringify({
    // NOTE: this metadata is consumed by queue workers.
    userName: formData.userName,
    userId: formData.userId,
    departmentCode: formData.departmentCode,
    prompt: formData.prompt,
    originalQuery: formData.originalQuery,
    queryForRAG: formData.queryForRAG,
    detectedLanguage: formData.detectedLanguage,
    processingPath: formData.processingPath,
    roleCode: formData.roleCode,
    ragTriggered: formData.ragTriggered,
    dualLanguageEnabled: formData.dualLanguageEnabled,
    usedFileIds: formData.usedFileIds,
    fileId: formData.fileId,
    allFileSearch: formData.allFileSearch,
    useMcp: formData.useMcp,
  });
  return [{ metadata: data, sort: formData.fieldSort } as PrepareOutput];
};

export { chatTask, IChatTaskFormData };
