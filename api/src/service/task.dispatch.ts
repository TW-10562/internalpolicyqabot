import KrdGenTask from '@/mysql/model/gen_task.model';
import KrdGenTaskOutput from '@/mysql/model/gen_task_output.model';
import { IGenTaskSer } from '@/types/genTask';
import { IGenTaskOutputSer } from '@/types/genTaskOutput';
import { put, queryById, queryList } from '@/utils/mapper';
import { formatSingleLanguageOutput } from '@/utils/translation';
import { detectMessageLanguage } from '@/service/languageRouting';
import dayjs from 'dayjs';
import { Op } from 'sequelize';

type AviaryCallbackFunctionRes = {
  outputId: number;
  isOk: boolean;
  content?: string;
  error?: string;
  language?: 'ja' | 'en';
};

type AviaryCallbackFunction = (outputId: number, metadata: string) => AviaryCallbackFunctionRes;

const OUTPUT_PROCESS_TIMEOUT_MS = Math.max(60_000, Number(process.env.CHAT_PROCESS_TIMEOUT_MS || 60_000));
const CHAT_OUTPUT_TIMEOUT_BUFFER_MS = Math.max(
  5_000,
  Number(process.env.CHAT_OUTPUT_TIMEOUT_BUFFER_MS || 15_000),
);
const CHAT_OUTPUT_PROCESS_TIMEOUT_MS = Math.max(
  OUTPUT_PROCESS_TIMEOUT_MS,
  Number(process.env.CHAT_OUTPUT_PROCESS_TIMEOUT_MS || 0),
  Number(process.env.RAG_LLM_TIMEOUT_MS || 90_000) + CHAT_OUTPUT_TIMEOUT_BUFFER_MS,
);

const CHAT_FALLBACK_TEXT_EN = 'A temporary error occurred while generating the answer. Please try again shortly.';
const CHAT_FALLBACK_TEXT_JA = '回答生成中に一時的な問題が発生しました。しばらくしてから再度お試しください。';

const resolveChatFallbackLanguage = (metadata: string | undefined): 'ja' | 'en' => {
  const raw = String(metadata || '').trim();
  if (!raw) return 'en';
  try {
    const parsed = JSON.parse(raw);
    const explicit = String(parsed?.detectedLanguage || '').trim().toLowerCase();
    if (explicit === 'ja' || explicit === 'en') return explicit;
    const probe = String(parsed?.originalQuery || parsed?.prompt || '').trim();
    return detectMessageLanguage(probe);
  } catch {
    return detectMessageLanguage(raw);
  }
};

const buildChatFallbackContent = (language: 'ja' | 'en'): string =>
  formatSingleLanguageOutput(language === 'ja' ? CHAT_FALLBACK_TEXT_JA : CHAT_FALLBACK_TEXT_EN, language);

const resolveOutputProcessTimeoutMs = (type: string): number =>
  type === 'CHAT' ? CHAT_OUTPUT_PROCESS_TIMEOUT_MS : OUTPUT_PROCESS_TIMEOUT_MS;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const execute = async (
  type: string,
  taskId: string,
  callback: (outputId: number, metadata: string) => Promise<AviaryCallbackFunctionRes>,
) => {
  console.log(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] job start, type: ${type}, taskId: ${taskId}`);

  let task = await queryById<IGenTaskSer>(KrdGenTask, { id: taskId });
  if (!task) {
    console.log(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] error happen, task [${taskId}] not exist!`);
    await put<IGenTaskOutputSer>(
      KrdGenTaskOutput,
      { task_id: taskId, status: { [Op.in]: ['WAIT', 'IN_PROCESS'] } } as any,
      {
        status: 'FAILED',
        content: 'Task not found',
        update_by: 'JOB',
      },
    );
    return;
  }
  if (task.status === 'CANCEL') {
    console.log(
      `[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] job end, type: ${type}, taskId: ${taskId}, task status is CANCEL1`,
    );
    return;
  }
  if (task.status !== 'WAIT') {
    console.log(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] stop! task [${taskId}] status is [${task.status}]`);
  }

  await put<IGenTaskSer>(KrdGenTask, { id: taskId }, { status: 'IN_PROCESS', update_by: 'JOB' });

  let outputs = await queryList(KrdGenTaskOutput, { task_id: taskId, status: 'WAIT' });

  if (type === 'QUESTION_GEN') {
    let flag = true;
    for (const output of outputs) {
      if (task.status === 'CANCEL') {
        console.log(
          `[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] job end, type: ${type}, taskId: ${taskId}, task status is CANCEL2`,
        );
        return;
      }

      // eslint-disable-next-line no-await-in-loop
      const curOutputs = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: output.id } });
      const curOutput = curOutputs[0];

      if (curOutput.status === 'CANCEL') {
        console.log(
          `[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] type: ${type}, taskId: ${taskId}, outputId: ${output.id}, output status is CANCEL2`,
        );
      } else {
        // eslint-disable-next-line no-await-in-loop
        await put<IGenTaskOutputSer>(KrdGenTaskOutput, { id: output.id }, { status: 'IN_PROCESS', update_by: 'JOB' });
        // eslint-disable-next-line no-await-in-loop
        let result: AviaryCallbackFunctionRes;
        const timeoutMs = resolveOutputProcessTimeoutMs(type);
        try {
          result = await withTimeout(
            callback(output.id, output.metadata),
            timeoutMs,
            `Task ${taskId} output ${output.id}`,
          );
        } catch (error: any) {
          const reason = error?.message || String(error);
          await put<IGenTaskOutputSer>(
            KrdGenTaskOutput,
            { id: output.id },
            { status: 'FAILED', content: `Processing failed: ${reason}`, update_by: 'JOB' },
          );
          result = { outputId: output.id, isOk: false, error: reason };
        }
        if (!result.isOk) {
          flag = false;
        }
      }
    }

    task = await queryById<IGenTaskSer>(KrdGenTask, { id: taskId });

    if (task.status === 'CANCEL') {
      console.log(
        `[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] job end, type: ${type}, taskId: ${taskId}, task status is CANCEL2`,
      );
      return;
    }

    if (flag) {
      await put<IGenTaskSer>(KrdGenTask, { id: taskId }, { status: 'FINISHED', update_by: 'JOB' });
    } else {
      await put<IGenTaskSer>(KrdGenTask, { id: taskId }, { status: 'FAILED', update_by: 'JOB' });
    }
  } else {
    await Promise.all(
      outputs.map((output) =>
        put<IGenTaskOutputSer>(KrdGenTaskOutput, { id: output.id }, { status: 'IN_PROCESS', update_by: 'JOB' }),
      ),
    );

    outputs = await queryList(KrdGenTaskOutput, { task_id: taskId, status: 'IN_PROCESS' });

    await Promise.all(
      outputs.map(async (output) => {
        const timeoutMs = resolveOutputProcessTimeoutMs(type);
        try {
          return await withTimeout(
            callback(output.id, output.metadata),
            timeoutMs,
            `Task ${taskId} output ${output.id}`,
          );
        } catch (error: any) {
          const reason = error?.message || String(error);
          if (type === 'CHAT') {
            const fallbackLanguage = resolveChatFallbackLanguage(output.metadata);
            const safeContent = buildChatFallbackContent(fallbackLanguage);
            await put<IGenTaskOutputSer>(
              KrdGenTaskOutput,
              { id: output.id },
              { status: 'FINISHED', content: safeContent, update_by: 'JOB' },
            );
            return {
              outputId: output.id,
              isOk: true,
              content: safeContent,
              error: reason,
              language: fallbackLanguage,
            };
          }
          await put<IGenTaskOutputSer>(
            KrdGenTaskOutput,
            { id: output.id },
            { status: 'FAILED', content: `Processing failed: ${reason}`, update_by: 'JOB' },
          );
          return { outputId: output.id, isOk: false, error: reason };
        }
      }),
    ).then(async (values) => {
      let flag = true;

      for (const r of values) {
        if (!r.isOk) {
          if (type === 'CHAT') {
            const fallbackLanguage = r.language || 'en';
            const safeContent = buildChatFallbackContent(fallbackLanguage);
            await put<IGenTaskOutputSer>(
              KrdGenTaskOutput,
              { id: r.outputId },
              { status: 'FINISHED', content: safeContent, update_by: 'JOB' },
            );
            continue;
          }
          flag = false;
          break;
        }
      }

      task = await queryById<IGenTaskSer>(KrdGenTask, { id: taskId });
      if (task.status === 'CANCEL') {
        console.log(
          `[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] job end, type: ${type}, taskId: ${taskId}, task status is CANCEL2`,
        );
        return;
      }
      if (flag || type === 'CHAT') {
        await put<IGenTaskSer>(KrdGenTask, { id: taskId }, { status: 'FINISHED', update_by: 'JOB' });
      } else {
        await put<IGenTaskSer>(KrdGenTask, { id: taskId }, { status: 'FAILED', update_by: 'JOB' });
      }
    });
  }
  console.log(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] job end, type: ${type}, taskId: ${taskId}`);
};

export { AviaryCallbackFunction, AviaryCallbackFunctionRes, execute };
