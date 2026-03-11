import redis from '@/clients/redis';

export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatSource = {
  docId: string;
  title?: string;
  page?: number;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number; // unix ms
  sources?: ChatSource[];
};

const streamKey = (taskId: string) => `chat:stream:${taskId}`;
const metaKey = (taskId: string) => `chat:meta:${taskId}`;
const userIndexKey = (userName: string) => `chat:user:${userName}:tasks`;

const safeJson = (v: unknown) => {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return 'null';
  }
};

/**
 * Redis-based chat persistence.
 *
 * - Messages are stored in a Redis Stream per taskId
 * - Per-user index is stored in a ZSET keyed by last activity
 * - Title is stored in a small hash for fast list rendering
 */
export class ChatStoreRedis {
  async appendMessage(args: {
    taskId: string;
    userName: string;
    role: ChatRole;
    content: string;
    sources?: ChatSource[];
    createdAt?: number;
    maxLen?: number;
  }): Promise<void> {
    const { taskId, userName, role, content } = args;
    const createdAt = args.createdAt ?? Date.now();
    const maxLen = args.maxLen ?? 2000;

    // XADD stream with approximate trimming.
    await redis.xadd(
      streamKey(taskId),
      'MAXLEN',
      '~',
      String(maxLen),
      '*',
      'role',
      role,
      'content',
      content,
      'createdAt',
      String(createdAt),
      'sources',
      safeJson(args.sources ?? []),
    );

    // Update per-user index (latest activity first)
    await redis.zadd(userIndexKey(userName), createdAt, taskId);
    // Keep index bounded
    await redis.zremrangebyrank(userIndexKey(userName), 0, -201);

    // Minimal meta
    await redis.hset(metaKey(taskId), 'userName', userName, 'updatedAt', String(createdAt));
    await redis.expire(metaKey(taskId), 60 * 60 * 24 * 30).catch(() => undefined); // 30 days
    await redis.expire(streamKey(taskId), 60 * 60 * 24 * 30).catch(() => undefined);
  }

  async setTitle(taskId: string, title: string): Promise<void> {
    await redis.hset(metaKey(taskId), 'title', title);
  }

  async getRecentTasks(userName: string, limit = 10): Promise<{ taskId: string; title: string; updatedAt: number }[]> {
    const taskIds = await redis.zrevrange(userIndexKey(userName), 0, Math.max(0, limit - 1));
    if (!taskIds.length) return [];

    const metas = await Promise.all(taskIds.map((id) => redis.hgetall(metaKey(id))));
    return taskIds.map((taskId, i) => {
      const m = metas[i] || {};
      return {
        taskId,
        title: m.title || 'New Chat',
        updatedAt: Number(m.updatedAt || 0),
      };
    });
  }

  async getHistory(userName: string, pageNum = 1, pageSize = 10) {
    const start = (pageNum - 1) * pageSize;
    const end = start + pageSize - 1;
    const [taskIds, total] = await Promise.all([
      redis.zrevrange(userIndexKey(userName), start, end),
      redis.zcard(userIndexKey(userName)),
    ]);

    // For each task, fetch last user prompt + last assistant response (cheap)
    const rows = await Promise.all(
      taskIds.map(async (taskId) => {
        // Get last ~20 entries then pick recent user/assistant
        const entries = await redis.xrevrange(streamKey(taskId), '+', '-', 'COUNT', 20);
        let query = '';
        let answer = '';
        let sources: ChatSource[] = [];
        let ts = 0;

        for (const [id, fields] of entries) {
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[String(fields[i])] = String(fields[i + 1]);
          const role = (obj.role as ChatRole) || 'assistant';
          const createdAt = Number(obj.createdAt || 0);
          const content = obj.content || '';
          const s = (() => {
            try {
              return JSON.parse(obj.sources || '[]') as ChatSource[];
            } catch {
              return [];
            }
          })();

          if (!ts) ts = createdAt;
          if (!answer && role === 'assistant' && content.trim()) {
            answer = content;
            sources = s;
          }
          if (!query && role === 'user' && content.trim()) {
            query = content;
          }
          if (query && answer) break;
        }

        const meta = await redis.hgetall(metaKey(taskId));
        return {
          id: taskId,
          query: query || meta.title || 'Chat',
          answer: answer ? (answer.length > 200 ? `${answer.slice(0, 200)}...` : answer) : 'No response available',
          timestamp: ts || Number(meta.updatedAt || 0) || Date.now(),
          source: sources?.[0]
            ? { document: sources[0].title || sources[0].docId, page: sources[0].page || 1 }
            : undefined,
        };
      }),
    );

    return {
      rows,
      total,
      pageNum,
      pageSize,
    };
  }
}

export const chatStoreRedis = new ChatStoreRedis();
