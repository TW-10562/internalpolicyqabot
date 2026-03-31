import AppNotification from '@/mysql/model/app_notification.model';
import Notification from '@/mysql/model/notification.model';
import seq from '@/mysql/db/seq.db';
import { pgPool } from '@/clients/postgres';
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

/**
 * List notifications for a user, with per-user read state from notification_reads table.
 * This ensures each user has independent read/unread tracking.
 */
export async function listNotifications(userId: number, pageNum: number, pageSize: number, departmentCode?: string, includeDepartmentBroadcast = true) {
  const limit = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const offset = (Math.max(1, Number(pageNum) || 1) - 1) * limit;
  const userOrBroadcastWhere = includeDepartmentBroadcast
    ? {
      [Op.or]: [
        // For department admins (departmentCode defined), scope direct notifications to their department.
        // For super admins (departmentCode undefined), show all direct notifications.
        ...(departmentCode
          ? [{ user_id: userId, department_code: departmentCode }]
          : [{ user_id: userId }]),
        ...(departmentCode ? [{ user_id: null, department_code: departmentCode }] : [{ user_id: null }]),
      ],
    }
    : (departmentCode
        ? { user_id: userId, department_code: departmentCode }
        : { user_id: userId });
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

  // Fetch per-user read state from notification_reads table
  const notifIds = rows.map((r: any) => Number(r.id)).filter((id) => Number.isFinite(id));
  const readSet = new Set<number>();
  if (notifIds.length > 0) {
    try {
      const readRes = await pgPool.query(
        `SELECT notification_id FROM notification_reads WHERE user_id = $1 AND notification_id = ANY($2::bigint[])`,
        [userId, notifIds],
      );
      for (const r of readRes.rows) {
        readSet.add(Number(r.notification_id));
      }
    } catch {
      // Fall back to DB is_read flag if notification_reads table fails
    }
  }

  return {
    rows: rows.map((row: any) => {
      const id = Number(row.id);
      // For direct notifications (user_id matches), use DB is_read OR per-user tracking.
      // For broadcast notifications (user_id=null), ONLY use per-user tracking.
      const isBroadcast = row.user_id == null;
      const isRead = readSet.has(id) || (!isBroadcast && !!row.is_read);

      return {
        id,
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
        is_read: isRead,
        created_at: row.created_at,
        read_at: row.read_at,
      };
    }),
    total: count,
    page_num: Math.max(1, Number(pageNum) || 1),
    page_size: limit,
  };
}

/**
 * Mark a notification as read for a specific user.
 * Uses the per-user notification_reads table so each admin has independent read state.
 * Also updates the DB is_read flag for direct (non-broadcast) notifications.
 */
export async function markNotificationAsRead(userId: number, id: number, departmentCode?: string) {
  // Validate the notification exists and is visible to this user
  const notification = await AppNotification.findOne({
    raw: true,
    where: {
      id,
      [Op.or]: [
        { user_id: userId },
        // Broadcast notifications (user_id=null) scoped to user's department
        ...(departmentCode
          ? [{ user_id: null, department_code: departmentCode }]
          : [{ user_id: null }]),
      ],
    } as any,
  }) as any;

  if (!notification) {
    return false;
  }

  // Insert into per-user read tracking (upsert)
  try {
    await pgPool.query(
      `INSERT INTO notification_reads (user_id, notification_id, read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, notification_id) DO NOTHING`,
      [userId, id],
    );
  } catch (err) {
    console.warn('[notificationService] Failed to insert notification_reads:', err);
  }

  // Also update the DB is_read flag for direct notifications (where user_id matches)
  // This preserves backward compatibility. We do NOT update broadcast (user_id=null) rows.
  const [updated] = await AppNotification.update(
    { is_read: true, read_at: new Date() } as any,
    { where: { id, user_id: userId } },
  );
  return updated > 0 || notification.user_id == null; // true for broadcasts (read tracked via notification_reads)
}

/**
 * Mark all notifications as read for a specific user.
 */
export async function markAllNotificationsAsRead(userId: number, departmentCode?: string) {
  // Get all notification IDs visible to this user
  const userOrBroadcastWhere = departmentCode
    ? {
      [Op.or]: [
        { user_id: userId, department_code: departmentCode },
        { user_id: null, department_code: departmentCode },
      ],
    }
    : {
      [Op.or]: [
        { user_id: userId },
        { user_id: null },
      ],
    };

  const rows = await AppNotification.findAll({
    raw: true,
    attributes: ['id', 'user_id'],
    where: {
      type: { [Op.ne]: 'chat_reply_ready' },
      ...userOrBroadcastWhere,
    } as any,
  });

  if (rows.length === 0) return 0;

  const notifIds = rows.map((r: any) => Number(r.id)).filter((id) => Number.isFinite(id));
  const directIds = rows.filter((r: any) => r.user_id != null && Number(r.user_id) === userId).map((r: any) => Number(r.id));

  // Bulk insert per-user read tracking using parameterized query
  if (notifIds.length > 0) {
    const params: (number | null)[] = [userId];
    const valueClauses = notifIds.map((nid, i) => {
      params.push(nid);
      return `($1, $${i + 2}, NOW())`;
    });
    await pgPool.query(
      `INSERT INTO notification_reads (user_id, notification_id, read_at) VALUES ${valueClauses.join(',')} ON CONFLICT (user_id, notification_id) DO NOTHING`,
      params,
    ).catch((err) => console.warn('[notificationService] Bulk read insert failed:', err));
  }

  // Update DB is_read only for direct notifications
  if (directIds.length > 0) {
    await AppNotification.update(
      { is_read: true, read_at: new Date() } as any,
      { where: { id: { [Op.in]: directIds }, user_id: userId } },
    );
  }

  return notifIds.length;
}

/**
 * Delete specific app notifications by ID.
 * Only deletes notifications visible to the given user (direct or broadcast in their department).
 */
export async function deleteNotificationsByIds(userId: number, ids: number[], departmentCode?: string) {
  if (ids.length === 0) return 0;
  const where: any = {
    id: { [Op.in]: ids },
    [Op.or]: [
      { user_id: userId },
      ...(departmentCode ? [{ user_id: null, department_code: departmentCode }] : [{ user_id: null }]),
    ],
  };
  const deleted = await AppNotification.destroy({ where });
  // Clean up per-user read tracking for deleted notifications
  if (ids.length > 0) {
    pgPool.query(
      `DELETE FROM notification_reads WHERE notification_id = ANY($1::bigint[])`,
      [ids],
    ).catch(() => {});
  }
  return Number(deleted || 0);
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

    // Clean up notification_reads for purged notifications.
    // app_notifications lives in MySQL so we cannot cross-join to find orphaned rows.
    // When purging all (no department filter), truncate all read tracking.
    // When purging by department, we accept minor orphaned rows — they are harmless
    // and will be ignored since the parent notification no longer exists.
    if (!params?.departmentCode) {
      pgPool.query('DELETE FROM notification_reads')
        .catch((err) => console.warn('[notificationService] Failed to clean up notification_reads after purge:', err));
    }

    return {
      appDeleted,
      legacyDeleted,
      totalDeleted: Number(appDeleted || 0) + Number(legacyDeleted || 0),
    };
  });
}
