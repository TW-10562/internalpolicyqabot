import { addChatGenTask } from '@/queue/queue';
import KrdGenTask from '@/mysql/model/gen_task.model';
import KrdGenTaskOutput from '@/mysql/model/gen_task_output.model';
import { IGenTaskOutputSer } from '@/types/genTaskOutput';
import { IGenTaskSer } from '@/types/genTask';
import { put, queryList } from '@/utils/mapper';
import { nanoid } from 'nanoid';
import { Op } from 'sequelize';

const STALE_OUTPUT_STATUSES = ['IN_PROCESS', 'PROCESSING', 'RETRIEVING', 'GENERATING', 'STREAMING'];
const STALE_OUTPUT_MS = Math.max(60_000, Number(process.env.CHAT_STALE_OUTPUT_MS || 10 * 60_000));

const parseMetadata = (raw: string | undefined) => {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const estimateMaxTokens = (prompt: string) => {
  const text = String(prompt || '').trim();
  if (!text) return 256;
  if (text.length <= 180) return 320;
  if (text.length <= 600) return 640;
  return 1024;
};

export const recoverStaleChatOutputs = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - STALE_OUTPUT_MS);
  const staleOutputs = await queryList(KrdGenTaskOutput, {
    status: { [Op.in]: STALE_OUTPUT_STATUSES },
    updated_at: { [Op.lte]: cutoff },
  });
  if (!staleOutputs.length) return 0;

  let recovered = 0;
  for (const output of staleOutputs as IGenTaskOutputSer[]) {
    const taskId = String(output.task_id || '').trim();
    const outputId = Number(output.id || 0);
    if (!taskId || !Number.isFinite(outputId) || outputId <= 0) continue;
    const [task] = await queryList(KrdGenTask, { id: taskId }) as IGenTaskSer[];
    if (!task || String(task.type || '').toUpperCase() !== 'CHAT') continue;

    const meta = parseMetadata(output.metadata);
    await put<IGenTaskOutputSer>(
      KrdGenTaskOutput,
      { id: outputId },
      { status: 'QUEUED', update_by: 'JOB' },
    );
    await put<IGenTaskSer>(
      KrdGenTask,
      { id: taskId },
      { status: 'QUEUED', update_by: 'JOB' },
    );
    await addChatGenTask({
      taskId,
      outputId,
      sort: Number((output as any).sort || 0),
      userId: Number.isFinite(Number(meta.userId)) ? Number(meta.userId) : undefined,
      userName: meta.userName ? String(meta.userName) : undefined,
      requestId: meta.requestId ? String(meta.requestId) : nanoid(),
      traceId: meta.traceId ? String(meta.traceId) : undefined,
      enqueuedAt: Date.now(),
      maxTokens: estimateMaxTokens(String(meta.prompt || meta.originalQuery || '')),
    });
    recovered += 1;
  }

  if (recovered > 0) {
    console.log(`[CHAT_RECOVERY] Re-queued ${recovered} stale chat output(s).`);
  }
  return recovered;
};
