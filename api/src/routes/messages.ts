/**
 * Messages API Routes - User-Admin Communication
 */
import Router from 'koa-router';
import Message from '@/mysql/model/message.model';
import { Op } from 'sequelize';
import { requireScopedAccess } from '@/controller/auth';
import { AccessScope, isDepartmentAdminRole, isSuperAdminRole } from '@/service/rbac';

const router = new Router({ prefix: '/api/messages' });
router.use(requireScopedAccess);

const getCurrentUser = (ctx: any) => {
  return ctx.state?.user || { userName: 'anonymous', userId: 0 };
};

const getDepartmentFilter = (scope: AccessScope) =>
  isSuperAdminRole(scope.roleCode) ? { [Op.in]: ['HR', 'GA', 'ACC', 'OTHER'] } : scope.departmentCode;

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

// GET /inbox - Get messages for user
router.get('/inbox', async (ctx: any) => {
  try {
    const user = getCurrentUser(ctx);
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    const isAdmin = isDepartmentAdminRole(scope.roleCode) || isSuperAdminRole(scope.roleCode);

    let where;
    if (isAdmin) {
      // Admin sees:
      // 1. All user queries sent to admin
      // 2. All messages sent by admin (their own sent messages)
      where = {
        department_code: getDepartmentFilter(scope),
        [Op.or]: [
          { recipient_type: 'admin', sender_type: 'user' },
          { sender_user_id: scope.userId, sender_type: 'admin' },
        ],
      };
    } else {
      const recipientIds = getUserRecipientIds(user, scope);
      // Users must only see direct admin-to-user messages addressed to them.
      where = {
        department_code: scope.departmentCode,
        recipient_id: { [Op.in]: recipientIds },
        recipient_type: 'user',
        sender_type: 'admin',
      };
    }

    const messages = await Message.findAll({ where, order: [['created_at', 'DESC']], limit: 50 });
    const unreadCount = await Message.count({ where: { ...where, is_read: false } });

    ctx.body = { code: 200, result: { messages, unreadCount } };
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
      department_code: isSuperAdminRole(scope.roleCode) ? { [Op.in]: ['HR', 'GA', 'ACC', 'OTHER'] } : scope.departmentCode,
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

// GET /unread-count
router.get('/unread-count', async (ctx: any) => {
  try {
    const user = getCurrentUser(ctx);
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    const isAdmin = isDepartmentAdminRole(scope.roleCode) || isSuperAdminRole(scope.roleCode);

    let where;
    if (isAdmin) {
      where = {
        recipient_type: 'admin',
        sender_type: 'user',
        is_read: false,
        department_code: getDepartmentFilter(scope),
      };
    } else {
      const recipientIds = getUserRecipientIds(user, scope);
      where = {
        is_read: false,
        department_code: scope.departmentCode,
        recipient_id: { [Op.in]: recipientIds },
        recipient_type: 'user',
        sender_type: 'admin',
      };
    }

    const count = await Message.count({ where });
    ctx.body = { code: 200, result: { count } };
  } catch (err) {
    ctx.body = { code: 500, result: { count: 0 } };
  }
});

// PUT /mark-read/:id
router.put('/mark-read/:id', async (ctx: any) => {
  try {
    const user = getCurrentUser(ctx);
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    const isAdmin = isDepartmentAdminRole(scope.roleCode) || isSuperAdminRole(scope.roleCode);
    const { id } = ctx.params;

    let where: any;
    if (isAdmin) {
      where = {
        id,
        recipient_type: 'admin',
        sender_type: 'user',
        department_code: getDepartmentFilter(scope),
      };
    } else {
      const recipientIds = getUserRecipientIds(user, scope);
      where = {
        id,
        department_code: scope.departmentCode,
        recipient_id: { [Op.in]: recipientIds },
        recipient_type: 'user',
        sender_type: 'admin',
      };
    }

    await Message.update(
      { is_read: true },
      { where },
    );
    ctx.body = { code: 200, message: 'Marked as read' };
  } catch (err) {
    ctx.body = { code: 500, message: 'Failed' };
  }
});

// PUT /mark-all-read
router.put('/mark-all-read', async (ctx: any) => {
  try {
    const user = getCurrentUser(ctx);
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    const isAdmin = isDepartmentAdminRole(scope.roleCode) || isSuperAdminRole(scope.roleCode);

    let where;
    if (isAdmin) {
      where = {
        recipient_type: 'admin',
        sender_type: 'user',
        department_code: getDepartmentFilter(scope),
      };
    } else {
      const recipientIds = getUserRecipientIds(user, scope);
      where = {
        department_code: scope.departmentCode,
        recipient_id: { [Op.in]: recipientIds },
        recipient_type: 'user',
        sender_type: 'admin',
      };
    }

    await Message.update({ is_read: true }, { where });
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
      department_code: isSuperAdminRole(scope.roleCode) ? { [Op.in]: ['HR', 'GA', 'ACC'] } : scope.departmentCode,
      ...(whereConditions.length > 1 ? { [Op.or]: whereConditions } : whereConditions[0]),
    } as any;

    // Permanently delete messages (hard delete - Sequelize destroy is hard delete by default)
    // This completely removes all matching messages from the database
    const deletedCount = await Message.destroy({ 
      where
    });
    
    // Verify deletion by counting remaining messages of the same type
    const remainingCount = await Message.count({ where });
    
    console.log(`[Messages] Permanently deleted ${deletedCount} messages from database. Remaining matching: ${remainingCount}`);

    ctx.body = { 
      code: 200, 
      message: 'Messages deleted permanently',
      result: { 
        deletedCount,
        remainingCount: remainingCount // For verification
      }
    };
  } catch (err) {
    console.error('[Messages] Delete error:', err);
    ctx.body = { code: 500, message: 'Failed to delete messages' };
  }
};

router.delete('/delete', purgeMessagesHandler);
router.post('/delete', purgeMessagesHandler);

export default router;
