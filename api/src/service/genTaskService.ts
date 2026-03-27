import {
  addChatGenTask,
  addSummaryGenTask,
  addTranslateGenTask,
  addFileUploadTask,
  type ChatQueueJobPayload,
} from '@/queue/queue';
import { add, put, queryById } from '@/utils/mapper';
import { formatHumpLineTransfer } from '@/utils';
import KrdGenTask from '@/mysql/model/gen_task.model';
import KrdGenTaskOutput from '@/mysql/model/gen_task_output.model';
import { IGenTask, IGenTaskSer } from '@/types/genTask';
import { IGenTaskOutputSer } from '@/types/genTaskOutput';
import { nanoid } from 'nanoid';
import { ITranslateTaskFormData, translateTask } from '@/service/translateTask';
import { chatTask, IChatTaskFormData } from '../service/chatTask';
import { ISummaryTaskFormData, summaryTask } from '../service/summaryTask';
import { fileUploadTask, IFileUploadTaskFormData } from '../service/fileUploadTask';
import { Op } from 'sequelize';

export type PrepareOutput = {
  sort?: number;
  metadata?: string;
  errorMsg?: string;
};

type GenTaskResponse = {
  taskId: string;
  task?: {
    status: string;
    createdAt: string;
    id: string;
    createBy: string;
  };
};

const enqueue = async (type: string, taskId: string) => {
  switch (type) {
    case 'SUMMARY':
      await addSummaryGenTask(taskId);
      break;
    case 'TRANSLATE':
      await addTranslateGenTask(taskId);
      break;
    case 'FILEUPLOAD':
      await addFileUploadTask(taskId);
      break;
    default:
  }
};

const mergeJson = (raw: string | undefined, patch: Record<string, unknown>): string => {
  const base = (() => {
    try {
      const parsed = JSON.parse(String(raw || '{}'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  })();
  return JSON.stringify({ ...base, ...patch });
};

const estimateChatMaxTokens = (prompt: string): number => {
  const text = String(prompt || '').trim();
  if (!text) return 256;
  if (text.length <= 180) return 320;
  if (text.length <= 600) return 640;
  return 1024;
};

export const handleAddGenTask = async (
  addContent: IGenTask,
  userName: string,
  userId?: number,
  departmentCode: string = 'OTHER',
): Promise<GenTaskResponse> => {
  let taskId = nanoid();
  const addTaskContent = {
    ...addContent,
    id: taskId,
    createBy: userName,
    updateBy: userName,
    status: addContent.type === 'CHAT' ? 'QUEUED' : 'WAIT',
  };

  let outputs: PrepareOutput[] = [];
  let needUpdate = false;
  let isExplainTask = false;
  // Changed to prevent resetting the form_data in the chat.
  let isLongTextGenTask = true;
  let refTaskId: string | undefined;

  switch (addContent.type) {
    case 'CHAT':
      if (Object.keys(addContent.formData).length !== 0) {
        // Ensure downstream processors (queue workers) have access to the authenticated user.
        // We keep this inside formData so it is carried through existing metadata serialization.
        (addContent.formData as any).userName = userName;
        (addContent.formData as any).userId = userId;
        (addContent.formData as any).departmentCode = departmentCode;
        outputs = await chatTask(addContent.formData as IChatTaskFormData);
        refTaskId = (addContent.formData as IChatTaskFormData).taskId;
        if (refTaskId) {
          const existingTask = await queryById<IGenTaskSer>(KrdGenTask, { id: refTaskId });
          if (existingTask) {
            taskId = refTaskId;
            needUpdate = true;
          } else {
            console.warn(`[GenTask] Ignoring stale/non-existent chat taskId: ${refTaskId}`);
          }
        }
      }
      break;
    case 'SUMMARY':
      if (Object.keys(addContent.formData).length !== 0) {
        outputs = await summaryTask(addContent.formData as ISummaryTaskFormData);
      }
      break;
    case 'TRANSLATE':
      if (Object.keys(addContent.formData).length !== 0) {
        outputs = await translateTask(addContent.formData as ITranslateTaskFormData);
      }
      break;
    case 'FILEUPLOAD':
      if (Object.keys(addContent.formData).length !== 0) {
        outputs = await fileUploadTask(addContent.formData as IFileUploadTaskFormData);
      }
      break;
    default:
  }

  let task: IGenTaskSer | undefined;

  if (needUpdate && !isLongTextGenTask) {
    await put<IGenTaskSer>(KrdGenTask, { id: taskId }, { status: addContent.type === 'CHAT' ? 'QUEUED' : 'WAIT', form_data: '新しい会話' });
  } else if (isExplainTask || (isLongTextGenTask && needUpdate)) {
    await put<IGenTaskSer>(KrdGenTask, { id: taskId }, { status: addContent.type === 'CHAT' ? 'QUEUED' : 'WAIT' });
  } else {
    let newAddTaskContent: IGenTaskSer;

    try {
      if (addTaskContent.formData) {
        newAddTaskContent = {
          ...(formatHumpLineTransfer(addTaskContent, 'line') as IGenTaskSer),
          department_code: departmentCode,
          form_data:
            addContent.type === 'CHAT'
              ? '新しい会話'
              : JSON.stringify(addTaskContent.formData),
        };
      }

      if (addContent.type === 'CHAT' && Object.keys(addContent.formData).length === 0) {
        newAddTaskContent = {
          ...(formatHumpLineTransfer(addTaskContent, 'line') as IGenTaskSer),
          department_code: departmentCode,
          form_data: 'NEW CHAT',
          status: 'EMPTY',
        } as IGenTaskSer;
      }
    } catch (e) {
      newAddTaskContent = {
        ...addTaskContent,
        create_by: userName,
        update_by: userName,
        department_code: departmentCode,
        form_data:
          addContent.type === 'CHAT'
            ? '新しい会話'
            : JSON.stringify(addTaskContent.formData),
      } as unknown as IGenTaskSer;
    }

    task = await add<IGenTaskSer>(KrdGenTask, newAddTaskContent);

    if (addContent.type === 'CHAT' && Object.keys(addContent.formData).length === 0) {
      return {
        taskId,
        task: task
          ? {
            status: task.status,
            createdAt: (task.created_at as unknown as Date).toLocaleString('ja', { timeZone: 'Asia/Tokyo' }),
            id: taskId,
            createBy: task.create_by,
          }
          : undefined,
      };
    }
  }

  const results: Promise<IGenTaskOutputSer>[] = [];
  const chatQueueJobs: ChatQueueJobPayload[] = [];
  for (const output of outputs) {
    const requestId = nanoid();
    const traceId = nanoid();
    const outputMetadata = addContent.type === 'CHAT'
      ? mergeJson(output.metadata, {
          taskId,
          requestId,
          traceId,
          queuedAt: new Date().toISOString(),
          userId,
          userName,
          departmentCode,
        })
      : output.metadata;
    const addTaskOutputContent = {
      taskId,
      metadata: outputMetadata,
      departmentCode,
      status: addContent.type === 'CHAT' ? 'QUEUED' : 'WAIT',
      sort: output.sort,
      createBy: userName,
      updateBy: userName,
    };
    const newAddTaskOutputContent =
      formatHumpLineTransfer(addTaskOutputContent, 'line') as IGenTaskOutputSer;
    results.push(
      add<IGenTaskOutputSer>(KrdGenTaskOutput, newAddTaskOutputContent).then((created) => {
        if (addContent.type === 'CHAT' && created?.id) {
          const prompt = String((addContent.formData as IChatTaskFormData)?.prompt || '');
          chatQueueJobs.push({
            taskId,
            outputId: Number(created.id),
            sort: Number(output.sort || 0),
            userId,
            userName,
            requestId,
            traceId,
            enqueuedAt: Date.now(),
            maxTokens: estimateChatMaxTokens(prompt),
          });
        }
        return created;
      }),
    );
  }
  await Promise.all(results);

  try {
    if (addContent.type === 'CHAT') {
      await Promise.all(chatQueueJobs.map((job) => addChatGenTask(job)));
      await put<IGenTaskSer>(KrdGenTask, { id: taskId }, { status: 'QUEUED', update_by: 'JOB' });
    } else {
      await enqueue(addContent.type, taskId);
    }
  } catch (e: any) {
    const reason = e?.message || String(e);
    console.error(`[GenTask] Failed to enqueue ${addContent.type} task ${taskId}:`, reason);
    await put<IGenTaskSer>(KrdGenTask, { id: taskId }, { status: 'FAILED', update_by: 'JOB' });
    await put<IGenTaskOutputSer>(
      KrdGenTaskOutput,
      { task_id: taskId, status: { [Op.in]: ['WAIT', 'QUEUED'] } } as any,
      { status: 'FAILED', content: `Queue enqueue failed: ${reason}`, update_by: 'JOB' },
    );
    throw new Error(`Queue enqueue failed: ${reason}`);
  }

  return {
    taskId,
    task: task
      ? {
        status: task.status,
        createdAt: (task.created_at as unknown as Date).toLocaleString('ja', { timeZone: 'Asia/Tokyo' }),
        id: taskId,
        createBy: task.create_by,
      }
      : undefined,
  };
};
