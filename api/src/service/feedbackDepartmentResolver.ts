import { Op } from 'sequelize';
import ChatHistoryMessage from '@/mysql/model/chat_history_message.model';
import File from '@/mysql/model/file.model';

/**
 * Resolve the content department for a task output by looking up
 * which source documents were used to answer the question.
 * Returns the majority department among source docs, or null if unresolvable.
 */
export async function resolveContentDepartment(taskOutputId: number): Promise<string | null> {
  if (!Number.isFinite(taskOutputId) || taskOutputId <= 0) return null;

  const assistant = await ChatHistoryMessage.findOne({
    attributes: ['source_ids'],
    where: { message_id: `${taskOutputId}:assistant` },
    raw: true,
  }) as any;
  if (!assistant?.source_ids) return null;

  let sourceIds: string[];
  try {
    const parsed = typeof assistant.source_ids === 'string'
      ? JSON.parse(assistant.source_ids)
      : assistant.source_ids;
    sourceIds = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return null;
  }
  if (sourceIds.length === 0) return null;

  const files = await File.findAll({
    attributes: ['department_code'],
    where: { storage_key: { [Op.in]: sourceIds } },
    raw: true,
  }) as any[];
  if (files.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const f of files) {
    const dept = String(f.department_code || '').toUpperCase();
    if (dept) counts[dept] = (counts[dept] || 0) + 1;
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [dept, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = dept;
      bestCount = count;
    }
  }
  return best;
}
