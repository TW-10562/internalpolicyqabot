import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Trash2, ChevronRight, User, CalendarDays, X } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';
import { formatDateTimeJP, formatDateJP } from '../../lib/dateTime';
import { exportCsv, exportPdf, stampedFilename, type PdfColumnDef } from '../../lib/export';
import ExportDropdown from '../shared/ExportDropdown';
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
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
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
  const [selectedDate, setSelectedDate] = useState('');
  const [showCalendar, setShowCalendar] = useState(false);
  const calendarRef = useRef<HTMLDivElement>(null);

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
  const selectedConversationUserLabel = useMemo(() => {
    if (!selectedConversation) return resolvedYouLabel;
    if (!isSuperAdmin) return resolvedYouLabel;
    return (
      String(selectedConversation.user_name || '').trim() ||
      String(selectedConversation.emp_id || '').trim() ||
      String(selectedConversation.user_id || '').trim() ||
      resolvedYouLabel
    );
  }, [isSuperAdmin, resolvedYouLabel, selectedConversation]);
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
      // message_id formats: "outputId:user", "outputId:assistant",
      // or scoped: "convId:outputId:user", "convId:outputId:assistant"
      const parts = String(m.message_id || '').split(':');
      const rawId = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
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

  /* ---------------------------------------------------------------- */
  /*  Export All Conversations (fetches ALL pages + messages)           */
  /* ---------------------------------------------------------------- */

  const fetchAllConversationsWithMessages = async () => {
    // Step 1: Fetch all conversation rows across all pages
    const allRows: ConversationRow[] = [];
    const fetchPageSize = 100;
    let page = 1;
    let totalConvs = 0;

    setExportProgress('Fetching conversations...');

    // First request to know total
    const opts: any = isSuperAdmin
      ? (selectedUserId != null ? { userId: selectedUserId } : { allUsers: true })
      : {};
    if (selectedDate) {
      opts.dateFrom = selectedDate;
      opts.dateTo = selectedDate;
    }

    const firstRes: any = await listHistory(1, fetchPageSize, Object.keys(opts).length > 0 ? opts : undefined);
    if (!firstRes?.ok || !firstRes?.data) throw new Error('Failed to fetch conversations');

    const firstRows: ConversationRow[] = Array.isArray(firstRes.data.rows) ? firstRes.data.rows : [];
    allRows.push(...firstRows);
    totalConvs = Number(firstRes.data.total || firstRows.length);
    const totalPages = Math.ceil(totalConvs / fetchPageSize);

    // Fetch remaining pages
    for (page = 2; page <= totalPages; page++) {
      setExportProgress(`Fetching conversations (${allRows.length}/${totalConvs})...`);
      const res: any = await listHistory(page, fetchPageSize, Object.keys(opts).length > 0 ? opts : undefined);
      if (res?.ok && Array.isArray(res?.data?.rows)) {
        allRows.push(...res.data.rows);
      }
    }

    // Step 2: For each conversation, fetch its messages
    // Sort conversations: most recent first (for export ordering)
    allRows.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    type ExportTurn = {
      conversationTitle: string;
      userName: string;
      empId: string;
      department: string;
      askedAt: string;
      question: string;
      answeredAt: string;
      answer: string;
    };

    const allTurns: ExportTurn[] = [];

    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      setExportProgress(`Fetching messages (${i + 1}/${allRows.length})...`);

      try {
        const ownerUserId = isSuperAdmin ? Number(row.user_id) : undefined;
        const msgRes: any = await getHistoryConversation(
          row.conversation_id,
          isSuperAdmin && Number.isFinite(ownerUserId) ? { userId: ownerUserId } : undefined,
        );
        if (msgRes?.ok && Array.isArray(msgRes?.data?.messages)) {
          const msgs: HistoryMessage[] = msgRes.data.messages;
          // Build turns from messages (same logic as the turns memo)
          const byId = new Map<string, HistoryMessage>();
          for (const m of msgs) {
            if (!byId.has(m.message_id)) byId.set(m.message_id, m);
          }
          const ordered = Array.from(byId.values()).sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
          );
          const turnMap = new Map<string, { question?: string; answer?: string; askedAt?: string; answeredAt?: string }>();
          for (const m of ordered) {
            const parts = String(m.message_id || '').split(':');
            const rawId = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
            const turnId = rawId || String(new Date(m.created_at).getTime());
            if (!turnMap.has(turnId)) turnMap.set(turnId, {});
            const turn = turnMap.get(turnId)!;
            if (m.role === 'user') {
              turn.question = m.original_text;
              turn.askedAt = m.created_at;
            } else if (m.role === 'assistant') {
              turn.answer = m.model_answer_text || m.original_text;
              turn.answeredAt = m.created_at;
            }
          }

          const convTitle = resolveConversationTitle(row.title);
          const userName = row.user_name || row.emp_id || '';
          for (const turn of turnMap.values()) {
            allTurns.push({
              conversationTitle: convTitle,
              userName,
              empId: row.emp_id || '',
              department: row.department_code || '',
              askedAt: turn.askedAt ? formatDateTimeJP(turn.askedAt) : '',
              question: turn.question || '',
              answeredAt: turn.answeredAt ? formatDateTimeJP(turn.answeredAt) : '',
              answer: turn.answer || '',
            });
          }
        }
      } catch {
        // Skip conversations that fail to load — don't block the whole export
      }
    }

    return { allRows, allTurns, totalConvs };
  };

  const handleExportAllCsv = async () => {
    setExporting(true);
    try {
      const { allTurns, totalConvs } = await fetchAllConversationsWithMessages();
      setExportProgress('Generating CSV...');

      const headers = isSuperAdmin
        ? ['Conversation', 'User', 'Employee ID', 'Department', 'Asked At', 'Question', 'Answered At', 'Answer']
        : ['Conversation', 'Asked At', 'Question', 'Answered At', 'Answer'];

      const rowData = allTurns.map((t) =>
        isSuperAdmin
          ? [t.conversationTitle, t.userName, t.empId, t.department, t.askedAt, t.question, t.answeredAt, t.answer]
          : [t.conversationTitle, t.askedAt, t.question, t.answeredAt, t.answer],
      );
      exportCsv(stampedFilename('all-conversations'), headers, rowData);
      toast.success('Export complete', `${totalConvs} conversations exported`);
    } catch (err: any) {
      toast.error('Export failed', err?.message || 'Could not export conversations');
    } finally {
      setExporting(false);
      setExportProgress('');
    }
  };

  const handleExportAllPdf = async () => {
    setExporting(true);
    try {
      const { allTurns, totalConvs } = await fetchAllConversationsWithMessages();
      setExportProgress('Generating PDF...');

      const pdfHeaders: PdfColumnDef[] = isSuperAdmin
        ? [
            { header: 'Conversation', width: 2 },
            { header: 'User', width: 1.2 },
            { header: 'Dept', width: 0.7, align: 'center' },
            { header: 'Asked At', width: 1.5 },
            { header: 'Question', width: 4 },
            { header: 'Answered At', width: 1.5 },
            { header: 'Answer', width: 4 },
          ]
        : [
            { header: 'Conversation', width: 2 },
            { header: 'Asked At', width: 1.5 },
            { header: 'Question', width: 5 },
            { header: 'Answered At', width: 1.5 },
            { header: 'Answer', width: 5 },
          ];

      const rowData = allTurns.map((t) =>
        isSuperAdmin
          ? [t.conversationTitle, t.userName, t.department, t.askedAt, t.question, t.answeredAt, t.answer]
          : [t.conversationTitle, t.askedAt, t.question, t.answeredAt, t.answer],
      );
      await exportPdf({
        title: 'All Conversations — Full Export',
        subtitle: `${totalConvs} conversations, ${allTurns.length} Q&A turns`,
        headers: pdfHeaders,
        rows: rowData,
        filename: stampedFilename('all-conversations'),
        orientation: 'landscape',
      });
      toast.success('Export complete', `${totalConvs} conversations exported`);
    } catch (err: any) {
      toast.error('Export failed', err?.message || 'Could not export conversations');
    } finally {
      setExporting(false);
      setExportProgress('');
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Export Single Conversation (full content, no truncation)         */
  /* ---------------------------------------------------------------- */

  const handleExportChatCsv = () => {
    if (!turns.length) return;
    const title = resolveConversationTitle(selectedConversation?.title);
    const headers = ['#', 'User', 'Asked At', 'Question', 'Answered At', 'Answer'];
    const rowData = turns.map((turn, i) => [
      i + 1,
      selectedConversationUserLabel,
      turn.askedAt ? formatDateTimeJP(turn.askedAt) : '',
      turn.question || '',
      turn.answeredAt ? formatDateTimeJP(turn.answeredAt) : '',
      turn.answer || '',
    ]);
    exportCsv(stampedFilename(`chat-${title.slice(0, 30).replace(/[^a-z0-9]/gi, '_')}`), headers, rowData);
  };

  const handleExportChatPdf = async () => {
    if (!turns.length) return;
    const title = resolveConversationTitle(selectedConversation?.title);
    const pdfHeaders: PdfColumnDef[] = [
      { header: '#', width: 0.4, align: 'center' },
      { header: 'User', width: 1.5 },
      { header: 'Asked At', width: 1.5 },
      { header: 'Question', width: 5 },
      { header: 'Answered At', width: 1.5 },
      { header: 'Answer', width: 5 },
    ];
    const rowData = turns.map((turn, i) => [
      i + 1,
      selectedConversationUserLabel,
      turn.askedAt ? formatDateTimeJP(turn.askedAt) : '',
      turn.question || '',
      turn.answeredAt ? formatDateTimeJP(turn.answeredAt) : '',
      turn.answer || '',
    ]);
    await exportPdf({
      title: `Chat: ${title}`,
      subtitle: `${turns.length} Q&A turns`,
      headers: pdfHeaders,
      rows: rowData,
      filename: stampedFilename(`chat-${title.slice(0, 30).replace(/[^a-z0-9]/gi, '_')}`),
      orientation: 'landscape',
    });
  };

  const loadList = async (
    targetPage = pageNum,
    targetUserId: number | null = selectedUserId,
    options?: { silent?: boolean; date?: string },
  ) => {
    const silent = options?.silent === true;
    const effectiveDate = options?.date ?? selectedDate;
    if (!silent) setLoadingList(true);
    try {
      const opts: any = isSuperAdmin
        ? (targetUserId != null ? { userId: targetUserId } : { allUsers: true })
        : {};
      if (effectiveDate) {
        opts.dateFrom = effectiveDate;
        opts.dateTo = effectiveDate;
      }
      const res: any = await listHistory(
        targetPage,
        pageSize,
        Object.keys(opts).length > 0 ? opts : undefined,
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
    loadList(1, selectedUserId, { date: selectedDate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin, selectedUserId, selectedDate]);

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
      loadList(pageNum, selectedUserId, { silent: true, date: selectedDate });
      if (selectedConversationId) loadMessages(selectedConversationId, { silent: true });
    }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum, selectedConversationId, isSuperAdmin, selectedUserId, selectedDate]);

  // Close calendar when clicking outside
  useEffect(() => {
    if (!showCalendar) return;
    const handleClick = (e: MouseEvent) => {
      if (calendarRef.current && !calendarRef.current.contains(e.target as Node)) {
        setShowCalendar(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showCalendar]);

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
    <div className="h-full min-h-0 grid grid-cols-1 gap-4 overflow-hidden p-3 sm:p-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="flex min-h-[260px] flex-col rounded-xl border border-default bg-surface dark:bg-dark-surface overflow-hidden lg:min-h-0">
        <div className="px-4 py-3 border-b border-default flex items-center justify-between gap-2">
          <span className="font-semibold text-foreground dark:text-dark-text">{t('history.title')}</span>
          {visibleRows.length > 0 && (
            <ExportDropdown
              onExportCsv={handleExportAllCsv}
              onExportPdf={handleExportAllPdf}
              disabled={exporting}
              label=""
            />
          )}
        </div>

        {/* Date picker bar */}
        <div className="px-3 py-2 border-b border-default flex items-center justify-between gap-2 relative">
          <span className="text-[11px] text-muted dark:text-dark-text-muted">
            {t('history.totalConversations', { count: total })}
          </span>
          <div className="flex items-center gap-1.5" ref={calendarRef}>
            {selectedDate && (
              <span className="text-[11px] font-medium text-primary dark:text-blue-400">
                {selectedDate}
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowCalendar((v) => !v)}
              className={`p-1.5 rounded-lg border transition-colors ${
                selectedDate
                  ? 'border-primary/40 bg-primary/10 text-primary dark:border-blue-600/40 dark:bg-blue-900/20 dark:text-blue-400'
                  : 'border-default text-muted dark:text-dark-text-muted hover:text-foreground dark:hover:text-dark-text hover:bg-surface-alt dark:hover:bg-dark-border'
              }`}
              title={t('history.dateFilter')}
            >
              <CalendarDays className="w-4 h-4" />
            </button>
            {selectedDate && (
              <button
                type="button"
                onClick={() => { setSelectedDate(''); setPageNum(1); setShowCalendar(false); }}
                className="p-1 rounded-lg text-muted dark:text-dark-text-muted hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                title={t('history.clearFilter')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}

            {showCalendar && (
              <div className="absolute right-3 top-full mt-1 z-20 bg-surface dark:bg-dark-surface border border-default rounded-xl shadow-lg p-3 min-w-[240px]">
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => {
                    setSelectedDate(e.target.value);
                    setPageNum(1);
                    setShowCalendar(false);
                  }}
                  className="w-full px-3 py-2 rounded-lg border border-default bg-surface dark:bg-dark-surface text-sm text-foreground dark:text-dark-text"
                  autoFocus
                />
                <div className="flex gap-1.5 mt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedDate(formatDateJP(new Date()).replace(/\//g, '-'));
                      setPageNum(1);
                      setShowCalendar(false);
                    }}
                    className="flex-1 px-2 py-1.5 text-[11px] rounded-lg border border-default hover:bg-surface-alt dark:hover:bg-dark-border text-foreground dark:text-dark-text transition-colors"
                  >
                    {t('history.today')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const d = new Date(); d.setDate(d.getDate() - 1);
                      setSelectedDate(formatDateJP(d).replace(/\//g, '-'));
                      setPageNum(1);
                      setShowCalendar(false);
                    }}
                    className="flex-1 px-2 py-1.5 text-[11px] rounded-lg border border-default hover:bg-surface-alt dark:hover:bg-dark-border text-foreground dark:text-dark-text transition-colors"
                  >
                    {t('history.yesterday')}
                  </button>
                </div>
                {selectedDate && (
                  <button
                    type="button"
                    onClick={() => { setSelectedDate(''); setPageNum(1); setShowCalendar(false); }}
                    className="w-full mt-1.5 px-2 py-1.5 text-[11px] rounded-lg border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    {t('history.clearFilter')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {isSuperAdmin && (
          <div className="p-3 border-b border-default space-y-2">
            <input
              value={searchEmpId}
              onChange={(e) => setSearchEmpId(e.target.value)}
              placeholder={t('history.findUserPlaceholder')}
              className="w-full px-3 py-2 rounded-lg border border-default bg-surface dark:bg-dark-surface text-sm text-foreground dark:text-dark-text"
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

        <div className="min-h-0 flex-1 overflow-y-auto">
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

      <div className="min-h-[320px] min-w-0 rounded-xl border border-default bg-surface dark:bg-dark-surface p-4 overflow-y-auto lg:min-h-0">
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
              <div className="flex items-center gap-2">
                {turns.length > 0 && (
                  <ExportDropdown onExportCsv={handleExportChatCsv} onExportPdf={handleExportChatPdf} />
                )}
                <button
                  onClick={() => handleDeleteConversation(selectedConversationId)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
                >
                  <Trash2 className="w-4 h-4" />
                  {t('history.deleteConversation')}
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {turns.map((turn) => (
                <div
                  key={turn.id}
                  className="rounded-xl border border-default bg-surface-alt dark:bg-dark-border p-3"
                >
                  <div className="pb-2">
                    <p className="text-xs mb-1 text-muted dark:text-dark-text-muted flex items-center justify-between gap-2">
                      <span>{selectedConversationUserLabel}</span>
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

      {/* Export progress overlay */}
      {exporting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-surface dark:bg-dark-surface border border-default rounded-2xl shadow-xl px-8 py-6 flex flex-col items-center gap-3 max-w-sm">
            <div className="w-8 h-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
            <p className="text-sm font-medium text-foreground dark:text-dark-text">Exporting conversations...</p>
            {exportProgress && (
              <p className="text-xs text-muted dark:text-dark-text-muted">{exportProgress}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
