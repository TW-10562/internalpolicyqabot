import IndexCon from '@/controller';
import { usePermission } from '@/controller/auth';
import { requireScopedAccess } from '@/controller/auth';
import { formatHandle } from '@/controller/common';
import {
  deleteTaskOutputMid,
  getAddMid,
  getChatTitleMid,
  getListMid,
  getOutputListMid,
  streamTaskOutputMid,
  reNameTaskOutputMid,
  stopTaskOutputMid,
  updateTaskOutputMid,
  sendFeedbackToCache,
  translateContentOnDemandMid,
} from '@/controller/genTask';
import { addEditSchema } from '@/schemas';
import PERMISSIONS from '@/utils/permissions';
import Joi from 'joi';
import Router from 'koa-router';

const router = new Router({ prefix: '/api' });

router.post(
  '/gen-task',
  requireScopedAccess,
  addEditSchema(
    Joi.object({
      type: Joi.string().valid('CHAT', 'SUMMARY', 'TRANSLATE', 'FILEUPLOAD').required(),
      formData: Joi.object().required(),
    }),
  ),
  getAddMid,
  IndexCon(),
);

router.get('/gen-task/list', requireScopedAccess, getListMid, formatHandle, IndexCon());

router.get('/gen-task-output/list', requireScopedAccess, getOutputListMid, formatHandle, IndexCon());
router.get('/gen-task-output/stream', requireScopedAccess, streamTaskOutputMid);

router.put('/gen-task-output/:taskOutputId', requireScopedAccess, updateTaskOutputMid, IndexCon());

router.put('/gen-task-output/rename/:taskId', requireScopedAccess, reNameTaskOutputMid, IndexCon());

router.delete('/gen-task-output/del/:taskId', requireScopedAccess, deleteTaskOutputMid, IndexCon());

router.put('/gen-task-output/stop/:fieldSort', requireScopedAccess, stopTaskOutputMid, IndexCon());

router.get('/gen-task/getChatTitle', requireScopedAccess, getChatTitleMid, IndexCon());

router.post(
  '/gen-task/feedback',
  requireScopedAccess,
  addEditSchema(
    Joi.object({
      taskOutputId: Joi.number().required(),
      cache_signal: Joi.number().valid(0, 1),
      query: Joi.string().allow(''),
      answer: Joi.string().allow(''),
      emoji: Joi.string().valid('like', 'dislike'),
      outputContent: Joi.string().allow(''),
      question: Joi.string().allow(''),
    }),
  ),
  sendFeedbackToCache,
  formatHandle,
  IndexCon(),
);

router.post(
  '/gen-task/translate-on-demand',
  requireScopedAccess,
  addEditSchema(
    Joi.object({
      outputId: Joi.number().required(),
      targetLanguage: Joi.string().valid('ja', 'en').required(),
    }),
  ),
  translateContentOnDemandMid,
  formatHandle,
  IndexCon(),
);

router.post(
  '/gen-task/translate-on-demand/stream',
  requireScopedAccess,
  addEditSchema(
    Joi.object({
      outputId: Joi.number().required(),
      targetLanguage: Joi.string().valid('ja', 'en').required(),
    }),
  ),
  translateContentOnDemandMid,
  formatHandle,
  IndexCon(),
);
export default router;
