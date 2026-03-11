import AppNotification from '@/mysql/model/app_notification.model';
import Notification from '@/mysql/model/notification.model';
import seq from '@/mysql/db/seq.db';
import { Op } from 'sequelize';

export type NotificationType =
  | 'system_alert'
  | 'meeting_summary_ready'
  | 'translation_completed'
  | 'file_processed'
  | 'chat_reply_ready'
  | 'custom';

export type CreateNotificationInput = {
  userId?: number | null;
  departmentCode: string;
  type: NotificationType;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
};

const json = (value: unknown) => {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
};

export function buildNotificationInsert(input: CreateNotificationInput) {
  return {
    user_id: input.userId,
    department_code: input.departmentCode,
    type: input.type,
    title: String(input.title || '').trim(),
    body: String(input.body || '').trim(),
    payload_json: json(input.payload || {}),
    is_read: false,
    created_at: new Date(),
  };
}

export async function createNotification(input: CreateNotificationInput) {
  const row = buildNotificationInsert(input);
  if (!row.title || !row.body) {
    throw new Error('validation_error');
  }
  return seq.transaction(async (transaction) => {
    const created = await AppNotification.create(row as any, { transaction }) as any;
    return created.dataValues || created;
  });
}

export async function listNotifications(userId: number, pageNum: number, pageSize: number, departmentCode?: string, includeDepartmentBroadcast = true) {
  const limit = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const offset = (Math.max(1, Number(pageNum) || 1) - 1) * limit;
  const userOrBroadcastWhere = includeDepartmentBroadcast
    ? {
      [Op.or]: [
        // Always include direct notifications for this user.
        { user_id: userId },
        // Department broadcasts apply to the viewer's scope only.
        ...(departmentCode ? [{ user_id: null, department_code: departmentCode }] : [{ user_id: null }]),
      ],
    }
    : { user_id: userId };
  const { rows, count } = await AppNotification.findAndCountAll({
    raw: true,
    where: {
      type: { [Op.ne]: 'chat_reply_ready' },
      ...userOrBroadcastWhere,
    } as any,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  return {
    rows: rows.map((row: any) => ({
      id: row.id,
      user_id: row.user_id,
      type: row.type,
      title: row.title,
      body: row.body,
      payload_json: (() => {
        try {
          return typeof row.payload_json === 'string' ? JSON.parse(row.payload_json || '{}') : row.payload_json || {};
        } catch {
          return {};
        }
      })(),
      is_read: !!row.is_read,
      created_at: row.created_at,
      read_at: row.read_at,
    })),
    total: count,
    page_num: Math.max(1, Number(pageNum) || 1),
    page_size: limit,
  };
}

export async function markNotificationAsRead(userId: number, id: number) {
  return seq.transaction(async (transaction) => {
    const [updated] = await AppNotification.update(
      { is_read: true, read_at: new Date() } as any,
      { where: { id, user_id: userId }, transaction },
    );
    return updated > 0;
  });
}

export async function purgeUserNotifications(params?: { departmentCode?: string }) {
  const where = params?.departmentCode ? { department_code: params.departmentCode } : undefined;

  return seq.transaction(async (transaction) => {
    const appDeleted = await AppNotification.destroy({
      where: where as any,
      transaction,
    });

    const legacyDeleted = await Notification.destroy({
      where: where as any,
      transaction,
    });

    return {
      appDeleted,
      legacyDeleted,
      totalDeleted: Number(appDeleted || 0) + Number(legacyDeleted || 0),
    };
  });
}
