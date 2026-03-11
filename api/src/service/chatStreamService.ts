import redis from '@/clients/redis';

export type ChatStreamEventName =
  | 'status'
  | 'chunk'
  | 'replace'
  | 'done'
  | 'error';

export type ChatStreamPayload = Record<string, any>;

type ChatStreamEnvelope = {
  event: ChatStreamEventName;
  payload: ChatStreamPayload;
  ts: number;
};

const CHAT_STREAM_PUBSUB_ENABLED = String(process.env.CHAT_STREAM_PUBSUB_ENABLED || '1') !== '0';

const channelForTask = (taskId: string): string =>
  `chat:live:${String(taskId || '').trim()}`;

export const publishChatStreamEvent = async (
  taskId: string,
  event: ChatStreamEventName,
  payload: ChatStreamPayload = {},
): Promise<void> => {
  if (!CHAT_STREAM_PUBSUB_ENABLED) return;
  const safeTaskId = String(taskId || '').trim();
  if (!safeTaskId) return;
  const envelope: ChatStreamEnvelope = {
    event,
    payload,
    ts: Date.now(),
  };
  try {
    await redis.publish(channelForTask(safeTaskId), JSON.stringify(envelope));
  } catch {
    // Best-effort stream side channel; DB updates remain source-of-truth fallback.
  }
};

export const createChatStreamSubscriber = async (
  taskId: string,
  onEvent: (event: ChatStreamEventName, payload: ChatStreamPayload) => void,
): Promise<{
  close: () => Promise<void>;
}> => {
  const safeTaskId = String(taskId || '').trim();
  if (!CHAT_STREAM_PUBSUB_ENABLED || !safeTaskId) {
    return {
      close: async () => undefined,
    };
  }

  const sub = redis.duplicate();
  const channel = channelForTask(safeTaskId);
  let closed = false;

  const onMessage = (_channel: string, message: string) => {
    if (closed || _channel !== channel) return;
    try {
      const parsed = JSON.parse(String(message || '{}')) as Partial<ChatStreamEnvelope>;
      const event = String(parsed?.event || '').trim() as ChatStreamEventName;
      const payload = parsed?.payload && typeof parsed.payload === 'object'
        ? parsed.payload as ChatStreamPayload
        : {};
      if (!event) return;
      onEvent(event, payload);
    } catch {
      // Ignore malformed messages to keep stream resilient.
    }
  };

  sub.on('message', onMessage);
  await sub.subscribe(channel);

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        sub.off('message', onMessage);
        await sub.unsubscribe(channel);
      } catch {
        // no-op
      }
      try {
        sub.disconnect();
      } catch {
        // no-op
      }
    },
  };
};
