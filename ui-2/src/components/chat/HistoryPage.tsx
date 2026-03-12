import { useEffect, useMemo, useState } from 'react';
import { Clock, Trash2, ChevronRight, User } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';
import { formatDateTimeJP } from '../../lib/dateTime';
import {
  deleteHistoryConversation,
  getHistoryConversation,
  listHistory,
  HistoryConversation,
  HistoryMessage,
  HistoryUserOption,
  listHistoryUsers,
} from '../../api/history';
import { User as UserType } from '../../types';

type ConversationRow = HistoryConversation & {
  user_id?: number;
  user_name?: string;
  emp_id?: string;
  department_code?: string;
};

interface HistoryPageProps {
  user?: UserType;
}

type ChatTurn = {
  id: string;
  askedAt?: string;
  answeredAt?: string;
  question?: string;
  answer?: string;
};

const normalizeTitleForCompare = (value?: string | null) =>
  String(value || '').trim().toLowerCase();

const areRowsEqual = (a: ConversationRow[], b: ConversationRow[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.conversation_id !== right.conversation_id ||
      left.updated_at !== right.updated_at ||
      String(left.last_message || '') !== String(right.last_message || '') ||
      String(left.title || '') !== String(right.title || '') ||
      Number(left.user_id || 0) !== Number(right.user_id || 0)
    ) {
      return false;
    }
  }
  return true;
};

const areMessagesEqual = (a: HistoryMessage[], b: HistoryMessage[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.message_id !== right.message_id ||
      left.role !== right.role ||
      left.created_at !== right.created_at ||
      String(left.original_text || '') !== String(right.original_text || '') ||
      String(left.model_answer_text || '') !== String(right.model_answer_text || '')
    ) {
      return false;
    }
  }
  return true;
};

export default function HistoryPage({ user }: HistoryPageProps) {
  const { t } = useLang();
  const toast = useToast();
  const getDepartmentLabel = (departmentCode?: string | null) => {
    const normalized = String(departmentCode || '').toUpperCase();
    if (normalized === 'HR') return t('common.departments.hr');
    if (normalized === 'GA') return t('common.departments.ga');
    if (normalized === 'ACC') return t('common.departments.acc');
    if (normalized === 'OTHER') return t('common.departments.other');
    return t('common.departments.unknown');
  };

  const [loadingList, setLoadingList] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [pageNum, setPageNum] = useState(1);
  const [total, setTotal] = useState(0);
  const [searchEmpId, setSearchEmpId] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [userOptions, setUserOptions] = useState<HistoryUserOption[]>([]);
  const [userOptionsTotal, setUserOptionsTotal] = useState(0);
  const [userOptionsPage, setUserOptionsPage] = useState(1);
  const [loadingUsers, setLoadingUsers] = useState(false);

  const isSuperAdmin = user?.roleCode === 'SUPER_ADMIN';
  const pageSize = isSuperAdmin ? 100 : 20;
  const userOptionPageSize = 25;
  const resolvedYouLabel = (() => {
    const value = t('chat.you');
    return value === 'chat.you' ? t('chatExport.you') : value;
  })();
  const resolveConversationTitle = (title?: string | null) => {
    const normalized = normalizeTitleForCompare(title);
    if (!normalized) return t('chat.newChat');
    if (normalized === 'new chat' || normalized === 'new conversation' || normalized === '新しいチャット') {
      return t('chat.newChat');
    }
    return String(title);
  };

  const selectedConversation = useMemo(
    () => rows.find((r) => r.conversation_id === selectedConversationId) || null,
    [rows, selectedConversationId],
  );
  const turns = useMemo(() => {
    const byMessageId = new Map<string, HistoryMessage>();
    for (const m of messages) {
      if (!byMessageId.has(m.message_id)) byMessageId.set(m.message_id, m);
    }
    const ordered = Array.from(byMessageId.values()).sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const byTurn = new Map<string, ChatTurn>();
    for (const m of ordered) {
      const [rawId] = String(m.message_id || '').split(':');
      const turnId = rawId || String(new Date(m.created_at).getTime());
      if (!byTurn.has(turnId)) byTurn.set(turnId, { id: turnId });
      const turn = byTurn.get(turnId)!;
      if (m.role === 'user') {
        turn.question = m.original_text;
        turn.askedAt = m.created_at;
      } else if (m.role === 'assistant') {
        turn.answer = m.model_answer_text || m.original_text;
        turn.answeredAt = m.created_at;
      }
    }
    return Array.from(byTurn.values());
  }, [messages]);

  const loadList = async (
    targetPage = pageNum,
    targetUserId: number | null = selectedUserId,
    options?: { silent?: boolean },
  ) => {
    const silent = options?.silent === true;
    if (!silent) setLoadingList(true);
    try {
      const res: any = await listHistory(
        targetPage,
        pageSize,
        isSuperAdmin
          ? (targetUserId != null ? { userId: targetUserId } : { allUsers: true })
          : undefined,
      );
      if (res?.ok && res?.data) {
        const incomingRows = Array.isArray(res.data.rows) ? res.data.rows : [];
        setRows((prev) => (areRowsEqual(prev, incomingRows) ? prev : incomingRows));
        setTotal((prev) => {
          const next = Number(res.data.total || 0);
          return prev === next ? prev : next;
        });
        if (!selectedConversationId && Array.isArray(res.data.rows) && res.data.rows.length > 0) {
          setSelectedConversationId(res.data.rows[0].conversation_id);
        }
      } else {
        setRows([]);
        setTotal(0);
        if (res?.error?.message || res?.message) {
          toast.error(t('common.error'), res?.error?.message || res?.message);
        }
      }
    } catch (err: any) {
      toast.error(t('common.error'), err?.message || t('history.empty'));
    } finally {
      if (!silent) setLoadingList(false);
    }
  };

  const loadMessages = async (conversationId: string, options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) setLoadingMessages(true);
    try {
      const ownerRow = rows.find((r) => r.conversation_id === conversationId);
      const ownerUserId = isSuperAdmin ? Number(ownerRow?.user_id) : undefined;
      const res: any = await getHistoryConversation(
        conversationId,
        isSuperAdmin && Number.isFinite(ownerUserId) ? { userId: ownerUserId } : undefined,
      );
      if (res?.ok && res?.data) {
        const incomingMessages = Array.isArray(res.data.messages) ? res.data.messages : [];
        setMessages((prev) => (areMessagesEqual(prev, incomingMessages) ? prev : incomingMessages));
      } else {
        setMessages([]);
      }
    } catch (err: any) {
      toast.error(t('common.error'), err?.message || t('history.empty'));
      setMessages([]);
    } finally {
      if (!silent) setLoadingMessages(false);
    }
  };

  const loadHistoryUsers = async (targetPage = 1, append = false, query = searchEmpId) => {
    if (!isSuperAdmin) return;
    setLoadingUsers(true);
    try {
      const res: any = await listHistoryUsers(targetPage, userOptionPageSize, { query });
      if (res?.ok && res?.data) {
        const incoming = Array.isArray(res.data.rows) ? res.data.rows : [];
        setUserOptions((prev) => {
          if (!append) return incoming;
          const seen = new Set(prev.map((u) => u.user_id));
          return [...prev, ...incoming.filter((u: HistoryUserOption) => !seen.has(u.user_id))];
        });
        setUserOptionsTotal(Number(res.data.total || 0));
        setUserOptionsPage(targetPage);
      } else if (!append) {
        setUserOptions([]);
        setUserOptionsTotal(0);
        setUserOptionsPage(1);
      }
    } catch {
      if (!append) {
        setUserOptions([]);
        setUserOptionsTotal(0);
        setUserOptionsPage(1);
      }
    } finally {
      setLoadingUsers(false);
    }
  };

  useEffect(() => {
    loadList(1, selectedUserId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin, selectedUserId]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    const timer = window.setTimeout(() => {
      loadHistoryUsers(1, false, searchEmpId);
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin, searchEmpId]);

  // Keep history live while user is on this page (DB is source of truth).
  useEffect(() => {
    const timer = window.setInterval(() => {
      loadList(pageNum, selectedUserId, { silent: true });
      if (selectedConversationId) loadMessages(selectedConversationId, { silent: true });
    }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum, selectedConversationId, isSuperAdmin, selectedUserId]);

  useEffect(() => {
    if (selectedConversationId) {
      loadMessages(selectedConversationId);
    } else {
      setMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversationId]);

  const handleDeleteConversation = async (conversationId: string) => {
    const ok = window.confirm(t('history.deleteConversation'));
    if (!ok) return;

    try {
      const row = rows.find((r) => r.conversation_id === conversationId);
      const ownerUserId = isSuperAdmin ? Number(row?.user_id) : undefined;
      const res: any = await deleteHistoryConversation(
        conversationId,
        isSuperAdmin && Number.isFinite(ownerUserId) ? { userId: ownerUserId } : undefined,
      );
      if (res?.ok) {
        toast.success(t('common.success'), t('history.deleteConversation'));
        if (selectedConversationId === conversationId) {
          setSelectedConversationId(null);
          setMessages([]);
        }
        await loadList(pageNum);
      } else {
        toast.error(t('common.error'), res?.error?.message || res?.message || t('common.error'));
      }
    } catch (err: any) {
      toast.error(t('common.error'), err?.message || t('common.error'));
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const visibleRows = useMemo(() => {
    if (!isSuperAdmin) return rows;
    return rows.filter((r) => {
      const uid = Number(r.user_id);
      if (selectedUserId != null && uid !== selectedUserId) return false;
      return true;
    });
  }, [rows, isSuperAdmin, selectedUserId]);

  useEffect(() => {
    if (!visibleRows.length) {
      setSelectedConversationId(null);
      setMessages([]);
      return;
    }
    const exists = visibleRows.some((r) => r.conversation_id === selectedConversationId);
    if (!exists) setSelectedConversationId(visibleRows[0].conversation_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRows]);

  return (
    <div className="h-full grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 p-4">
      <div className="rounded-xl border border-default bg-surface dark:bg-dark-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-default font-semibold text-foreground dark:text-dark-text">
          {t('history.title')}
        </div>

        {isSuperAdmin && (
          <div className="p-3 border-b border-default space-y-2">
            <input
              value={searchEmpId}
              onChange={(e) => setSearchEmpId(e.target.value)}
              placeholder={t('history.findUserPlaceholder')}
              className="w-full px-3 py-2 rounded-lg border border-default bg-surface dark:bg-dark-surface text-sm"
            />
            <select
              value={selectedUserId == null ? '' : String(selectedUserId)}
              onChange={(e) => {
                setPageNum(1);
                setSelectedUserId(e.target.value ? Number(e.target.value) : null);
              }}
              className="w-full px-3 py-2 rounded-lg border border-default bg-surface dark:bg-dark-surface text-sm"
            >
              <option value="">{t('history.allUsers')}</option>
              {userOptions.map((u) => (
                <option key={u.user_id} value={u.user_id}>
                  {(u.emp_id || u.user_id)} - {u.user_name || '-'} ({getDepartmentLabel(u.department_code)}) · {u.conversation_count}
                </option>
              ))}
            </select>
            {loadingUsers && (
              <div className="text-[11px] text-muted dark:text-dark-text-muted">{t('history.loadingUsers')}</div>
            )}
            {!loadingUsers && userOptionsTotal > userOptions.length && (
              <button
                type="button"
                onClick={() => loadHistoryUsers(userOptionsPage + 1, true, searchEmpId)}
                className="text-[11px] text-primary hover:underline"
              >
                {t('history.loadMoreUsers', { loaded: userOptions.length, total: userOptionsTotal })}
              </button>
            )}
          </div>
        )}

        <div className="max-h-[calc(100vh-260px)] overflow-y-auto">
          {loadingList ? (
            <div className="p-4 text-sm text-muted dark:text-dark-text-muted">{t('common.loading')}</div>
          ) : visibleRows.length === 0 ? (
            <div className="p-4 text-sm text-muted dark:text-dark-text-muted">{t('history.empty')}</div>
          ) : (
            visibleRows.map((row) => {
              const active = selectedConversationId === row.conversation_id;
              return (
                <button
                  key={row.conversation_id}
                  onClick={() => setSelectedConversationId(row.conversation_id)}
                  className={`w-full text-left px-4 py-3 border-b border-default transition-colors ${active ? 'bg-surface-alt dark:bg-dark-border' : 'hover:bg-surface-alt dark:hover:bg-dark-border/70'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground dark:text-dark-text truncate">
                        {resolveConversationTitle(row.title)}
                      </p>
                      <p className="text-xs text-muted dark:text-dark-text-muted truncate mt-1">
                        {row.last_message}
                      </p>
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted dark:text-dark-text-muted">
                        <Clock className="w-3 h-3" />
                        <span>{formatDateTimeJP(row.updated_at)}</span>
                      </div>
                      {isSuperAdmin && (
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted dark:text-dark-text-muted">
                          <User className="w-3 h-3" />
                          <span>{row.emp_id || row.user_id}</span>
                          <span>·</span>
                          <span>{row.user_name || '-'}</span>
                          <span>·</span>
                          <span>{getDepartmentLabel(row.department_code)}</span>
                        </div>
                      )}
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted dark:text-dark-text-muted mt-1" />
                  </div>
                </button>
              );
            })
          )}
        </div>

        {total > pageSize && (
          <div className="px-3 py-2 border-t border-default flex items-center justify-between">
            <button
              className="px-3 py-1 text-xs rounded border border-default"
              disabled={pageNum <= 1}
              onClick={() => {
                const next = Math.max(1, pageNum - 1);
                setPageNum(next);
                loadList(next, selectedUserId);
              }}
            >
              {t('history.prev')}
            </button>
            <span className="text-xs text-muted dark:text-dark-text-muted">{pageNum}/{Math.max(1, Math.ceil(total / pageSize))}</span>
            <button
              className="px-3 py-1 text-xs rounded border border-default"
              disabled={pageNum >= totalPages}
              onClick={() => {
                const next = Math.min(totalPages, pageNum + 1);
                setPageNum(next);
                loadList(next, selectedUserId);
              }}
            >
              {t('history.next')}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-default bg-surface dark:bg-dark-surface p-4 overflow-y-auto">
        {!selectedConversationId ? (
          <p className="text-sm text-muted dark:text-dark-text-muted">{t('history.empty')}</p>
        ) : loadingMessages ? (
          <p className="text-sm text-muted dark:text-dark-text-muted">{t('common.loading')}</p>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-foreground dark:text-dark-text">
                {resolveConversationTitle(selectedConversation?.title)}
              </h3>
              <button
                onClick={() => handleDeleteConversation(selectedConversationId)}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-300 text-red-600 hover:bg-red-50"
              >
                <Trash2 className="w-4 h-4" />
                {t('history.deleteConversation')}
              </button>
            </div>

            <div className="space-y-3">
              {turns.map((turn) => (
                <div
                  key={turn.id}
                  className="rounded-xl border border-default bg-surface-alt dark:bg-dark-border p-3"
                >
                  <div className="pb-2">
                    <p className="text-xs mb-1 text-muted dark:text-dark-text-muted flex items-center justify-between gap-2">
                      <span>{resolvedYouLabel}</span>
                      <span>
                        {turn.askedAt
                          ? formatDateTimeJP(turn.askedAt)
                          : '-'}
                      </span>
                    </p>
                    <p className="text-sm whitespace-pre-wrap text-foreground dark:text-dark-text">
                      {turn.question || '-'}
                    </p>
                  </div>

                  <div className="mt-2 pt-2 border-t border-default">
                    <p className="text-xs mb-1 text-muted dark:text-dark-text-muted flex items-center justify-between gap-2">
                      <span>{t('history.hrBotResponse')}</span>
                      <span>
                        {turn.answeredAt
                          ? formatDateTimeJP(turn.answeredAt)
                          : '-'}
                      </span>
                    </p>
                    <p className="text-sm whitespace-pre-wrap text-foreground dark:text-dark-text">
                      {turn.answer || '-'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
