/**
 * Queries Routes - Live Queries and Chat History
 * Production-grade implementation with validation, error handling, and consistency
 */
import Router from 'koa-router';
import { Op } from 'sequelize';
import KrdGenTask from '@/mysql/model/gen_task.model';
import KrdGenTaskOutput from '@/mysql/model/gen_task_output.model';
import { validatePagination, sanitizeString } from '@/utils/validation';
import { successResponse, databaseError, unauthorizedError, logError } from '@/utils/errors';
import { getHistoryMessages, listHistoryConversations } from '@/service/historyPersistenceService';
import { requireAdmin, requireScopedAccess } from '@/controller/auth';

const router = new Router({ prefix: '/api' });
router.use(requireScopedAccess);

const firstHistorySource = (message: any): { document: string; page: number } | undefined => {
  const sourceIds = Array.isArray(message?.source_ids) ? message.source_ids : [];
  const firstSource = sourceIds
    .map((value: unknown) => sanitizeString(String(value || '')))
    .find(Boolean);
  return firstSource ? { document: firstSource, page: 1 } : undefined;
};

/**
 * GET /api/live-queries
 * Returns recent questions from all users (anonymized) for recommendations
 * 
 * Query params:
 * - limit: number (1-50, default 10)
 */
router.get('/live-queries', async (ctx: any) => {
  const requestId = ctx.state.requestId || 'unknown';
  
  try {
    // Validate and sanitize limit parameter
    const rawLimit = ctx.query.limit;
    const limit = Math.min(50, Math.max(1, parseInt(rawLimit as string) || 10));
    
    // Get recent task outputs that are user prompts
    const outputs = await KrdGenTaskOutput.findAll({
      where: {
        status: 'FINISHED',
      },
      order: [['created_at', 'DESC']],
      limit: 50,
      raw: true,
    });
    
    // Filter and transform to get user questions
    const userQueries = outputs
      .filter((output: any) => {
        try {
          const metadata = JSON.parse(output.metadata || '{}');
          const prompt = metadata.prompt?.trim();
          // Validate: must have prompt, min 5 chars, max 1000 chars
          return prompt && prompt.length >= 5 && prompt.length <= 1000;
        } catch {
          return false;
        }
      })
      .slice(0, limit)
      .map((output: any) => {
        const metadata = JSON.parse(output.metadata || '{}');
        const prompt = sanitizeString(metadata.prompt || '');
        const content = prompt.toLowerCase();
        
        // Auto-categorize based on keywords
        let category = 'General';
        if (content.includes('leave') || content.includes('休暇') || content.includes('有給')) {
          category = 'Leave';
        } else if (content.includes('remote') || content.includes('リモート') || content.includes('在宅')) {
          category = 'Remote Work';
        } else if (content.includes('benefit') || content.includes('insurance') || content.includes('保険')) {
          category = 'Benefits';
        } else if (content.includes('expense') || content.includes('salary') || content.includes('給与')) {
          category = 'Finance';
        }
        
        return {
          id: output.id,
          query: prompt,
          category,
          timestamp: output.created_at,
        };
      });
    
    ctx.body = successResponse(userQueries, 'Live queries retrieved successfully');
  } catch (err: any) {
    logError(err, { route: '/api/live-queries', requestId });
    ctx.body = databaseError('live-queries');
  }
});

/**
 * GET /api/chat-history
 * Returns user's chat history with summaries for the History page
 * 
 * Query params:
 * - pageNum: number (min 1, default 1)
 * - pageSize: number (1-100, default 10)
 */
router.get('/chat-history', async (ctx: any) => {
  const requestId = ctx.state.requestId || 'unknown';
  const user = ctx.state.user;
  
  // Auth check
  if (!user?.userName) {
    ctx.body = unauthorizedError('User authentication required');
    return;
  }
  
  // Validate pagination
  const { pageNum, pageSize } = validatePagination(ctx.query.pageNum, ctx.query.pageSize);
  
  try {
    // Sanitize username for query
    const userName = sanitizeString(user.userName);
    const userId = Number(user.userId);

    // Primary source of truth: persistent PostgreSQL history tables (not session cache).
    if (Number.isFinite(userId) && userId > 0) {
      const persistent = await listHistoryConversations({ userId, pageNum, pageSize });
      if (persistent.total > 0) {
        const rows = await Promise.all(
          persistent.rows.map(async (conv) => {
            const detail = await getHistoryMessages({ userId, conversationId: String(conv.conversation_id) });
            const messages = Array.isArray(detail?.messages) ? detail!.messages : [];
            const userMsg = messages.find((m: any) => m.role === 'user');
            const assistantMsg = messages.find((m: any) => m.role === 'assistant');

            const query = sanitizeString(String(userMsg?.original_text || conv.title || 'Chat'));
            let answer = sanitizeString(String(assistantMsg?.original_text || conv.last_message || 'No response available'));
            if (answer.length > 200) answer = `${answer.slice(0, 200)}...`;

            return {
              id: conv.conversation_id,
              query: query || 'Chat',
              answer: answer || 'No response available',
              timestamp: conv.updated_at,
              source: firstHistorySource(assistantMsg),
            };
          }),
        );

        ctx.body = successResponse({
          rows,
          total: persistent.total,
          pageNum: persistent.page_num,
          pageSize: persistent.page_size,
        }, 'Chat history retrieved successfully');
        return;
      }
    }

    ctx.body = successResponse({
      rows: [],
      total: 0,
      pageNum,
      pageSize,
    }, 'Chat history retrieved successfully');
  } catch (err: any) {
    logError(err, { route: '/api/chat-history', requestId, userName: user.userName });
    ctx.body = databaseError('chat-history');
  }
});

/**
 * GET /api/recent-chats
 * Returns last 3 chats for the sidebar toggle (lightweight)
 */
router.get('/recent-chats', async (ctx: any) => {
  const requestId = ctx.state.requestId || 'unknown';
  const user = ctx.state.user;
  
  // Auth check
  if (!user?.userName) {
    ctx.body = unauthorizedError('User authentication required');
    return;
  }
  
  try {
    // Sanitize username
    const userName = sanitizeString(user.userName);
    const userId = Number(user.userId);

    // Primary source of truth: persistent PostgreSQL history tables.
    if (Number.isFinite(userId) && userId > 0) {
      const persistent = await listHistoryConversations({ userId, pageNum: 1, pageSize: 3 });
      if (persistent.total > 0) {
        const recentChats = persistent.rows.map((r) => ({
          id: r.conversation_id,
          title: sanitizeString(String(r.title || 'New Chat').substring(0, 50)),
          createdAt: r.updated_at,
        }));
        ctx.body = successResponse(recentChats, 'Recent chats retrieved successfully');
        return;
      }
    }

    ctx.body = successResponse([], 'Recent chats retrieved successfully');
  } catch (err: any) {
    logError(err, { route: '/api/recent-chats', requestId, userName: user.userName });
    ctx.body = databaseError('recent-chats');
  }
});

/**
 * GET /api/admin/users
 * Returns list of users with their activity stats (admin only)
 */
router.get('/admin/users', requireAdmin, async (ctx: any) => {
  const requestId = ctx.state.requestId || 'unknown';
  
  try {
    // Get query counts per user from tasks
    const queryCounts = await KrdGenTask.findAll({
      attributes: [
        'create_by',
        [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count'],
        [require('sequelize').fn('MAX', require('sequelize').col('created_at')), 'lastActive']
      ],
      where: { type: 'CHAT' },
      group: ['create_by'],
      raw: true,
    });
    
    // Build user list from active users
    const userList = queryCounts.map((q: any, index: number) => ({
      id: String(index + 1),
      name: q.create_by === 'admin' ? 'Administrator' : q.create_by,
      employeeId: q.create_by,
      department: q.create_by === 'admin' ? 'Administration' : 'General',
      lastActive: q.lastActive,
      queries: parseInt(q.count) || 0,
    }));
    
    // Sort by queries descending
    userList.sort((a: any, b: any) => b.queries - a.queries);
    
    ctx.body = successResponse(userList, 'Users retrieved successfully');
  } catch (err: any) {
    logError(err, { route: '/api/admin/users', requestId });
    ctx.body = databaseError('admin-users');
  }
});

/**
 * GET /api/admin/activity
 * Returns recent activity log (admin only)
 */
router.get('/admin/activity', requireAdmin, async (ctx: any) => {
  const requestId = ctx.state.requestId || 'unknown';
  const { limit = 20 } = ctx.query;
  
  try {
    // Get recent tasks as activity
    const tasks = await KrdGenTask.findAll({
      order: [['created_at', 'DESC']],
      limit: Math.min(50, parseInt(limit as string) || 20),
      raw: true,
    });
    
    // Get recent task outputs for more detail
    const outputs = await KrdGenTaskOutput.findAll({
      order: [['created_at', 'DESC']],
      limit: 30,
      raw: true,
    });
    
    const activities: any[] = [];
    
    // Add task activities
    tasks.forEach((task: any) => {
      const out = task as any;
      let detail = 'Chat session';
      
      // Try to get actual query from related output
      const relatedOutput = outputs.find((o: any) => o.task_id === out.id);
      if (relatedOutput) {
        try {
          const metadata = JSON.parse((relatedOutput as any).metadata || '{}');
          // Prefer originalQuery over prompt
          if (metadata.originalQuery) {
            detail = metadata.originalQuery;
          } else if (metadata.prompt) {
            let cleanPrompt = metadata.prompt;
            // Extract original query from RAG prompt if present
            if (cleanPrompt.includes('ORIGINAL QUERY:')) {
              const match = cleanPrompt.match(/ORIGINAL QUERY:\s*([^\n]+)/);
              cleanPrompt = match ? match[1].trim() : cleanPrompt;
            }
            if (cleanPrompt.includes('[COMPANY DOCUMENTS')) {
              cleanPrompt = cleanPrompt.split('[COMPANY DOCUMENTS')[0].trim();
            }
            detail = cleanPrompt;
          }
        } catch {}
      }
      
      activities.push({
        id: out.id,
        user: out.create_by || 'Unknown',
        action: out.type === 'CHAT' ? 'Chat query' : out.type,
        detail: sanitizeString(detail.replace(/【.*】/g, '').trim()).substring(0, 100),
        timestamp: out.created_at,
      });
    });
    
    ctx.body = successResponse(activities, 'Activity retrieved successfully');
  } catch (err: any) {
    logError(err, { route: '/api/admin/activity', requestId });
    ctx.body = databaseError('admin-activity');
  }
});

/**
 * GET /api/admin/stats
 * Returns dashboard statistics
 */
router.get('/admin/stats', requireAdmin, async (ctx: any) => {
  const requestId = ctx.state.requestId || 'unknown';
  
  try {
    // Get various counts
    const totalChats = await KrdGenTask.count({ where: { type: 'CHAT' } });
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayChats = await KrdGenTask.count({
      where: {
        type: 'CHAT',
        created_at: { [Op.gte]: today },
      },
    });
    
    // Get unique users
    const uniqueUsers = await KrdGenTask.findAll({
      attributes: [[require('sequelize').fn('DISTINCT', require('sequelize').col('create_by')), 'user']],
      where: { type: 'CHAT' },
      raw: true,
    });
    
    ctx.body = successResponse({
      totalChats,
      todayChats,
      activeUsers: uniqueUsers.length,
      avgResponseTime: '2.5s', // Placeholder
    }, 'Stats retrieved successfully');
  } catch (err: any) {
    logError(err, { route: '/api/admin/stats', requestId });
    ctx.body = databaseError('admin-stats');
  }
});

export default router;
