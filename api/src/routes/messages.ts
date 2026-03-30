/**
 * Messages API Routes - User-Admin Communication
 *
 * Read-state strategy:
 *   - Direct (single-recipient) messages: shared `is_read` flag on the message row.
 *   - Broadcast messages: per-user tracking via `message_reads` table in PostgreSQL.
 *     The shared `is_read` on the broadcast row is never mutated by readers.
 */
import Router from 'koa-router';
import Message from '@/mysql/model/message.model';
import { Op } from 'sequelize';
import { requireScopedAccess } from '@/controller/auth';
import { AccessScope, DEPARTMENTS, isDepartmentAdminRole, isSuperAdminRole } from '@/service/rbac';
import { pgPool } from '@/clients/postgres';

const router = new Router({ prefix: '/api/messages' });
router.use(requireScopedAccess);

const getCurrentUser = (ctx: any) => {
  return ctx.state?.user || { userName: 'anonymous', userId: 0 };
};

const getDepartmentFilter = (scope: AccessScope) =>
  isSuperAdminRole(scope.roleCode) ? { [Op.in]: [...DEPARTMENTS] } : scope.departmentCode;

const getUserRecipientIds = (user: any, scope: AccessScope) =>
  Array.from(
    new Set(
      [
        String(user.userName || '').trim(),
        String(user.userId || '').trim(),
        String(scope.userId || '').trim(),
        String(user.empId || '').trim(),
      ].filter((value) => value.length > 0),
    ),
  );

/* ------------------------------------------------------------------ */
/*  Per-user broadcast read-state helpers (PostgreSQL message_reads)   */
/* ------------------------------------------------------------------ */

/** Return the set of broadcast message IDs that `userId` has already read. */
async function getReadBroadcastIds(userId: number, messageIds: number[]): Promise<Set<number>> {
  const readSet = new Set<number>();
  if (messageIds.length === 0) return readSet;
  try {
    const res = await pgPool.query(
      `SELECT message_id FROM message_reads WHERE user_id = $1 AND message_id = ANY($2::int[])`,
      [userId, messageIds],
    );
    for (const r of res.rows) readSet.add(Number(r.message_id));
  } catch {
    // Table may not exist yet – fall back to shared is_read (no-op: readSet stays empty)
  }
  return readSet;
}

/**
 * Overlay per-user read state onto fetched messages.
 * - Direct messages: `is_read` from the DB row is authoritative.
 * - Broadcast messages: `message_reads` table is authoritative.
 */
async function overlayBroadcastReadState(userId: number, messages: any[]): Promise<any[]> {
  const broadcastIds = messages
    .filter((m) => m.is_broadcast)
    .map((m) => Number(m.id))
    .filter(Number.isFinite);

  if (broadcastIds.length === 0) return messages;

  const readSet = await getReadBroadcastIds(userId, broadcastIds);

  return messages.map((m) => {
    if (m.is_broadcast) {
      return { ...m, is_read: readSet.has(Number(m.id)) };
    }
    return m;
  });
}

/** Insert a per-user read entry for a broadcast message. */
async function markBroadcastReadForUser(userId: number, messageId: number): Promise<void> {
  try {
    await pgPool.query(
      `INSERT INTO message_reads (user_id, message_id, read_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id, message_id) DO NOTHING`,
      [userId, messageId],
    );
  } catch (err) {
    console.warn('[Messages] Failed to insert message_reads:', err);
  }
}

/** Bulk-insert per-user read entries for multiple broadcast messages. */
async function markBroadcastsReadBulk(userId: number, messageIds: number[]): Promise<void> {
  if (messageIds.length === 0) return;
  try {
    const values = messageIds.map((mid) => `(${Number(userId)}, ${Number(mid)}, NOW())`).join(',');
    await pgPool.query(
      `INSERT INTO message_reads (user_id, message_id, read_at) VALUES ${values} ON CONFLICT (user_id, message_id) DO NOTHING`,
    );
  } catch (err) {
    console.warn('[Messages] Bulk message_reads insert failed:', err);
  }
}

/**
 * Enrich messages with sender email/name from the user table.
 * The messages table stores sender_id which may be a numeric userId.
 * This looks up the actual email and user_name so the frontend can display them.
 */
async function enrichSenderInfo(messages: any[]): Promise<any[]> {
  const senderUserIds = [...new Set(
    messages.map((m) => Number(m.sender_user_id)).filter(Number.isFinite),
  )];
  if (senderUserIds.length === 0) return messages;

  const senderMap = new Map<number, { user_name: string; email: string }>();
  try {
    const res = await pgPool.query(
      `SELECT user_id, user_name, COALESCE(email, '') AS email
       FROM "user" WHERE user_id = ANY($1::bigint[])`,
      [senderUserIds],
    );
    for (const r of res.rows) {
      senderMap.set(Number(r.user_id), { user_name: r.user_name, email: r.email });
    }
    // Fall back to sys_user for any IDs not found in "user" table
    const missing = senderUserIds.filter((id) => !senderMap.has(id));
    if (missing.length > 0) {
      const res2 = await pgPool.query(
        `SELECT user_id, user_name, COALESCE(email, '') AS email
         FROM sys_user WHERE user_id = ANY($1::bigint[])`,
        [missing],
      );
      for (const r of res2.rows) {
        senderMap.set(Number(r.user_id), { user_name: r.user_name, email: r.email });
      }
    }
  } catch {
    // If lookup fails, fall back to existing sender_id values
  }

  return messages.map((m) => {
    const info = senderMap.get(Number(m.sender_user_id));
    return {
      ...m,
      sender_email: info?.email || '',
      sender_name: info?.user_name || m.sender_id,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Where-clause builders (audience logic – unchanged from prior fix)  */
/* ------------------------------------------------------------------ */

function buildInboxWhere(scope: AccessScope, user: any) {
  const isAdmin = isDepartmentAdminRole(scope.roleCode) || isSuperAdminRole(scope.roleCode);
  if (isAdmin) {
    return {
      department_code: getDepartmentFilter(scope),
      [Op.or]: [
        { recipient_type: 'admin', sender_type: 'user' },
        { sender_user_id: scope.userId, sender_type: 'admin' },
        { is_broadcast: true, sender_type: 'admin' },
      ],
    };
  }
  const recipientIds = getUserRecipientIds(user, scope);
  return {
    [Op.or]: [
      {
        department_code: scope.departmentCode,
        recipient_id: { [Op.in]: recipientIds },
        recipient_type: 'user',
        sender_type: 'admin',
      },
      { is_broadcast: true, sender_type: 'admin' },
    ],
  };
}

function buildDirectWhere(scope: AccessScope, user: any) {
  const isAdmin = isDepartmentAdminRole(scope.roleCode) || isSuperAdminRole(scope.roleCode);
  if (isAdmin) {
    return {
      recipient_type: 'admin',
      sender_type: 'user',
      department_code: getDepartmentFilter(scope),
    };
  }
  const recipientIds = getUserRecipientIds(user, scope);
  return {
    department_code: scope.departmentCode,
    recipient_id: { [Op.in]: recipientIds },
    recipient_type: 'user',
    sender_type: 'admin',
  };
}

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

// POST /send - Send message
router.post('/send', async (ctx: any) => {
  try {
    const user = getCurrentUser(ctx);
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    const { subject, content, recipientId, parentId } = ctx.request.body;

    if (!subject || !content) {
      ctx.body = { code: 400, message: 'Subject and content required' };
      return;
    }

    const isAdmin = isDepartmentAdminRole(scope.roleCode) || isSuperAdminRole(scope.roleCode);
    const message = await Message.create({
      sender_id: String(user.userName || user.userId),
      sender_user_id: Number(user.userId),
      sender_type: isAdmin ? 'admin' : 'user',
      recipient_id: isAdmin ? recipientId : 'admin',
      recipient_type: isAdmin ? 'user' : 'admin',
      subject,
      content,
      parent_id: parentId || null,
      is_read: false,
      is_broadcast: false,
      department_code: scope.departmentCode,
    });

    ctx.body = { code: 200, message: 'Message sent successfully', result: { id: message.id } };
  } catch (err) {
    ctx.body = { code: 500, message: 'Failed to send message' };
  }
});

// POST /broadcast - Admin broadcast to all
router.post('/broadcast', async (ctx: any) => {
  try {
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    if (!(isDepartmentAdminRole(scope.roleCode) || isSuperAdminRole(scope.roleCode))) {
      ctx.body = { code: 403, message: 'Admin only' };
      return;
    }

    const { subject, content } = ctx.request.body;
    const message = await Message.create({
      sender_id: String(scope.userId),
      sender_user_id: scope.userId,
      sender_type: 'admin',
      recipient_id: 'all',
      recipient_type: 'all',
      subject,
      content,
      is_broadcast: true,
      department_code: scope.departmentCode,
    });

    ctx.body = { code: 200, message: 'Broadcast sent', result: { id: message.id } };
  } catch (err) {
    ctx.body = { code: 500, message: 'Failed to broadcast' };
  }
});

// GET /inbox - Get messages for user, with per-user broadcast read state
router.get('/inbox', async (ctx: any) => {
  try {
    const user = getCurrentUser(ctx);
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    const where = buildInboxWhere(scope, user);

    const messages = await Message.findAll({ where, order: [['created_at', 'DESC']], limit: 50 });
    const plain = messages.map((m: any) => (m.get ? m.get({ plain: true }) : m));

    // Overlay per-user read state for broadcast messages
    const withReadState = await overlayBroadcastReadState(scope.userId, plain);

    // Enrich with sender email/name from the user table
    const enriched = await enrichSenderInfo(withReadState);
    const unreadCount = enriched.filter((m: any) => !m.is_read).length;

    ctx.body = { code: 200, result: { messages: enriched, unreadCount, currentUserId: scope.userId } };
  } catch (err) {
    console.error('[Messages] Inbox error:', err);
    ctx.body = { code: 500, message: 'Failed to fetch messages' };
  }
});

// GET /broadcast/history - Admin broadcast history
router.get('/broadcast/history', async (ctx: any) => {
  try {
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    if (!(isDepartmentAdminRole(scope.roleCode) || isSuperAdminRole(scope.roleCode))) {
      ctx.body = { code: 403, message: 'Admin only' };
      return;
    }

    const { pageNum = 1, pageSize = 50 } = ctx.query;
    const limit = Math.max(1, Number(pageSize) || 50);
    const offset = (Math.max(1, Number(pageNum) || 1) - 1) * limit;

    const where = {
      is_broadcast: true,
      department_code: isSuperAdminRole(scope.roleCode) ? { [Op.in]: [...DEPARTMENTS] } : scope.departmentCode,
    } as any;
    const { rows, count } = await Message.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit,
      offset,
    });

    ctx.body = {
      code: 200,
      result: {
        rows,
        count,
        pageNum: Number(pageNum) || 1,
        pageSize: limit,
      },
    };
  } catch (err) {
    console.error('[Messages] Broadcast history error:', err);
    ctx.body = { code: 500, message: 'Failed to fetch broadcast history' };
  }
});

// GET /unread-count  (per-user aware)
router.get('/unread-count', async (ctx: any) => {
  try {
    const user = getCurrentUser(ctx);
    const scope = (ctx.state?.accessScope || {}) as AccessScope;

    // Direct messages: shared is_read is correct for single-recipient
    const directUnread = await Message.count({
      where: { ...buildDirectWhere(scope, user), is_read: false, is_broadcast: false },
    });

    // Broadcast messages: per-user read state from message_reads
    // Scope to viewer's department and exclude self-sent broadcasts
    const broadcastWhere: any = {
      is_broadcast: true,
      sender_type: 'admin',
      department_code: isSuperAdminRole(scope.roleCode) ? { [Op.in]: [...DEPARTMENTS] } : scope.departmentCode,
      sender_user_id: { [Op.ne]: scope.userId },
    };
    const broadcasts = await Message.findAll({
      raw: true,
      attributes: ['id'],
      where: broadcastWhere,
    });
    const broadcastIds = broadcasts.map((b: any) => Number(b.id)).filter(Number.isFinite);
    const readBroadcastSet = await getReadBroadcastIds(scope.userId, broadcastIds);
    const broadcastUnread = broadcastIds.filter((id) => !readBroadcastSet.has(id)).length;

    ctx.body = { code: 200, result: { count: directUnread + broadcastUnread } };
  } catch (err) {
    ctx.body = { code: 500, result: { count: 0 } };
  }
});

// PUT /mark-read/:id  (per-user for broadcasts, shared for direct)
router.put('/mark-read/:id', async (ctx: any) => {
  try {
    const user = getCurrentUser(ctx);
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    const messageId = Number(ctx.params?.id);

    if (!Number.isFinite(messageId)) {
      ctx.body = { code: 400, message: 'Invalid id' };
      return;
    }

    // Peek at the message to decide which read-state path to use
    const msg = await Message.findByPk(messageId, { raw: true, attributes: ['id', 'is_broadcast'] });
    if (!msg) {
      ctx.body = { code: 404, message: 'Not found' };
      return;
    }

    if ((msg as any).is_broadcast) {
      // Broadcast: per-user read tracking – never mutate the shared row
      await markBroadcastReadForUser(scope.userId, messageId);
      ctx.body = { code: 200, message: 'Marked as read' };
      return;
    }

    // Direct message: update shared is_read (existing authorization logic)
    const isAdmin = isDepartmentAdminRole(scope.roleCode) || isSuperAdminRole(scope.roleCode);
    let authWhere: any;
    if (isAdmin) {
      authWhere = {
        id: messageId,
        recipient_type: 'admin',
        sender_type: 'user',
        department_code: getDepartmentFilter(scope),
      };
    } else {
      const recipientIds = getUserRecipientIds(user, scope);
      authWhere = {
        id: messageId,
        department_code: scope.departmentCode,
        recipient_id: { [Op.in]: recipientIds },
        recipient_type: 'user',
        sender_type: 'admin',
      };
    }

    await Message.update({ is_read: true }, { where: authWhere });
    ctx.body = { code: 200, message: 'Marked as read' };
  } catch (err) {
    ctx.body = { code: 500, message: 'Failed' };
  }
});

// PUT /mark-all-read  (per-user for broadcasts, shared for direct)
router.put('/mark-all-read', async (ctx: any) => {
  try {
    const user = getCurrentUser(ctx);
    const scope = (ctx.state?.accessScope || {}) as AccessScope;

    // 1. Direct messages: update shared is_read flag
    await Message.update({ is_read: true }, { where: buildDirectWhere(scope, user) });

    // 2. Broadcast messages: bulk-insert per-user read entries
    const broadcasts = await Message.findAll({
      raw: true,
      attributes: ['id'],
      where: { is_broadcast: true, sender_type: 'admin' },
    });
    const broadcastIds = broadcasts.map((b: any) => Number(b.id)).filter(Number.isFinite);
    await markBroadcastsReadBulk(scope.userId, broadcastIds);

    ctx.body = { code: 200, message: 'All marked as read' };
  } catch (err) {
    ctx.body = { code: 500, message: 'Failed' };
  }
});

// /delete - Admin only: Permanently delete messages
const purgeMessagesHandler = async (ctx: any) => {
  try {
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    if (!(isDepartmentAdminRole(scope.roleCode) || isSuperAdminRole(scope.roleCode))) {
      ctx.body = { code: 403, message: 'Admin only' };
      return;
    }

    const { deleteUserMessages, deleteAdminMessages } = ctx.request.body;

    if (!deleteUserMessages && !deleteAdminMessages) {
      ctx.body = { code: 400, message: 'At least one scope must be selected' };
      return;
    }

    // Build where clause based on selected scopes
    const whereConditions: any[] = [];

    if (deleteUserMessages) {
      whereConditions.push({ sender_type: 'user' });
    }

    if (deleteAdminMessages) {
      whereConditions.push({ sender_type: 'admin' });
    }

    const where = {
      department_code: isSuperAdminRole(scope.roleCode) ? { [Op.in]: [...DEPARTMENTS] } : scope.departmentCode,
      ...(whereConditions.length > 1 ? { [Op.or]: whereConditions } : whereConditions[0]),
    } as any;

    const deletedCount = await Message.destroy({ where });
    const remainingCount = await Message.count({ where });

    console.log(`[Messages] Permanently deleted ${deletedCount} messages from database. Remaining matching: ${remainingCount}`);

    ctx.body = {
      code: 200,
      message: 'Messages deleted permanently',
      result: {
        deletedCount,
        remainingCount,
      }
    };
  } catch (err) {
    console.error('[Messages] Delete error:', err);
    ctx.body = { code: 500, message: 'Failed to delete messages' };
  }
};

router.delete('/delete', purgeMessagesHandler);
router.post('/delete', purgeMessagesHandler);

// POST /delete-batch - Delete specific messages by IDs (used by Clear All in notifications)
router.post('/delete-batch', async (ctx: any) => {
  try {
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    const { ids } = ctx.request.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      ctx.body = { code: 400, message: 'ids array required' };
      return;
    }

    const numericIds = ids.map(Number).filter(Number.isFinite);
    if (numericIds.length === 0) {
      ctx.body = { code: 400, message: 'No valid ids' };
      return;
    }

    // Scope deletion to user's department for safety
    const where = {
      id: { [Op.in]: numericIds },
      department_code: isSuperAdminRole(scope.roleCode) ? { [Op.in]: [...DEPARTMENTS] } : scope.departmentCode,
    } as any;

    const deletedCount = await Message.destroy({ where });
    ctx.body = { code: 200, message: 'Messages deleted', result: { deletedCount } };
  } catch (err) {
    console.error('[Messages] Delete-batch error:', err);
    ctx.body = { code: 500, message: 'Failed to delete messages' };
  }
});

export default router;
