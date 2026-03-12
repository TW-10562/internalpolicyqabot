import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw, Trash2, X } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';
import { formatDateTimeJP } from '../../lib/dateTime';
import {
  listTriageTickets,
  purgeTriageTickets,
  sendTriageReply,
  TriageStatus,
  TriageTicket,
  updateTriageTicketStatus,
} from '../../api/triage';
import { User as UserType } from '../../types';

const STATUS_ORDER: TriageStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'];

const statusClass = (status: TriageStatus) => {
  if (status === 'OPEN') return 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300';
  if (status === 'IN_PROGRESS') return 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
  if (status === 'RESOLVED') return 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300';
  return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
};

interface TriagePanelProps {
  currentUser?: UserType;
}

export default function TriagePanel({ currentUser }: TriagePanelProps) {
  const { t } = useLang();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [purging, setPurging] = useState(false);
  const [showPurgeDialog, setShowPurgeDialog] = useState(false);
  const [purgePassword, setPurgePassword] = useState('');
  const [tickets, setTickets] = useState<TriageTicket[]>([]);
  const [replyDraft, setReplyDraft] = useState<Record<number, string>>({});
  const strictDepartment = currentUser?.roleCode === 'HR_ADMIN'
    ? 'HR'
    : currentUser?.roleCode === 'GA_ADMIN'
      ? 'GA'
      : currentUser?.roleCode === 'ACC_ADMIN'
        ? 'ACC'
        : null;

  const loadTickets = async () => {
    setLoading(true);
    try {
      const res: any = await listTriageTickets(1, 100);
      if (res?.code === 200) {
        const rows = Array.isArray(res?.result)
          ? res.result
          : Array.isArray(res?.result?.rows)
            ? res.result.rows
            : [];
        const safeRows = strictDepartment
          ? rows.filter((r: TriageTicket) => String(r.department_code || '').toUpperCase() === strictDepartment)
          : rows;
        setTickets(safeRows);
      } else {
        setTickets([]);
        toast.error(t('common.error'), res?.message || t('triage.loadFailed'));
      }
    } catch (e: any) {
      setTickets([]);
      toast.error(t('common.error'), e?.message || t('triage.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTickets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strictDepartment]);

  const grouped = useMemo(() => {
    const open = tickets.filter((x) => x.status === 'OPEN' || x.status === 'IN_PROGRESS');
    const closed = tickets.filter((x) => x.status === 'RESOLVED' || x.status === 'REJECTED');
    return { open, closed };
  }, [tickets]);

  const updateStatus = async (ticketId: number, status: TriageStatus) => {
    setUpdatingId(ticketId);
    try {
      const res: any = await updateTriageTicketStatus(ticketId, status);
      if (res?.code === 200) {
        toast.success(t('common.success'), t('triage.statusUpdated'));
        await loadTickets();
      } else {
        toast.error(t('common.error'), res?.message || t('triage.updateFailed'));
      }
    } catch (e: any) {
      toast.error(t('common.error'), e?.message || t('triage.updateFailed'));
    } finally {
      setUpdatingId(null);
    }
  };

  const handleReply = async (ticketId: number) => {
    const replyText = String(replyDraft[ticketId] || '').trim();
    if (!replyText) return;
    setUpdatingId(ticketId);
    try {
      const res: any = await sendTriageReply(ticketId, replyText);
      if (res?.code === 200) {
        setReplyDraft((prev) => ({ ...prev, [ticketId]: '' }));
        toast.success(t('common.success'), t('triage.replySent'));
      } else {
        toast.error(t('common.error'), res?.message || t('triage.updateFailed'));
      }
    } catch (e: any) {
      toast.error(t('common.error'), e?.message || t('triage.updateFailed'));
    } finally {
      setUpdatingId(null);
    }
  };

  const closePurgeDialog = () => {
    if (purging) return;
    setShowPurgeDialog(false);
    setPurgePassword('');
  };

  const handlePurge = async () => {
    if (!purgePassword.trim()) {
      toast.error(t('common.error'), t('triage.purgePasswordRequired'));
      return;
    }
    setPurging(true);
    try {
      const res: any = await purgeTriageTickets(purgePassword);
      if (res?.code === 200) {
        const deleted = Number(res?.result?.deletedTickets || 0);
        toast.success(t('common.success'), t('triage.purgeSuccess', { count: deleted }));
        await loadTickets();
        closePurgeDialog();
      } else {
        toast.error(t('common.error'), res?.message || t('triage.purgeFailed'));
      }
    } catch (e: any) {
      toast.error(t('common.error'), e?.message || t('triage.purgeFailed'));
    } finally {
      setPurging(false);
    }
  };

  return (
    <>
      <div className="space-y-4 mac-tab-animate">
      <div className="bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-2xl p-4 shadow-sm transition-colors">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            <h3 className="app-page-title">{t('triage.title')}</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setShowPurgeDialog(true);
                setPurgePassword('');
              }}
              disabled={purging || loading}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-red-200 text-red-600 text-sm hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-4 h-4" />
              {purging ? t('triage.purging') : t('triage.purgeButton')}
            </button>
            <button
              onClick={loadTickets}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-default text-sm hover:bg-surface-alt dark:hover:bg-dark-border transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              {t('triage.refresh')}
            </button>
          </div>
        </div>
        <p className="text-sm text-muted dark:text-dark-text-muted mt-2">
          {t('triage.subtitle', { open: grouped.open.length, total: tickets.length })}
        </p>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-default bg-surface dark:bg-dark-surface p-5 text-sm text-muted dark:text-dark-text-muted">
          {t('common.loading')}
        </div>
      ) : tickets.length === 0 ? (
        <div className="rounded-2xl border border-default bg-surface dark:bg-dark-surface p-5 text-sm text-muted dark:text-dark-text-muted">
          {t('triage.empty')}
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map((ticket) => (
            <div key={ticket.id} className="rounded-2xl border border-[#E8E8E8] dark:border-dark-border bg-white dark:bg-dark-surface p-4 shadow-sm transition-colors">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground dark:text-dark-text">#{ticket.id}</span>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusClass(ticket.status)}`}>
                    {ticket.status}
                  </span>
                  <span className="px-2 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    {ticket.department_code}
                  </span>
                </div>
                <div className="text-xs text-muted dark:text-dark-text-muted">
                  {formatDateTimeJP(ticket.updated_at)}
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
                <div className="text-sm">
                  <p className="text-xs text-muted dark:text-dark-text-muted mb-1">{t('triage.reportedBy')}</p>
                  <p className="text-foreground dark:text-dark-text">
                    {ticket.created_by_user_name || '-'} ({ticket.created_by_emp_id || ticket.created_by})
                  </p>
                </div>
                <div className="text-sm">
                  <p className="text-xs text-muted dark:text-dark-text-muted mb-1">{t('triage.assignedTo')}</p>
                  <p className="text-foreground dark:text-dark-text">
                    {ticket.assigned_to_user_name
                      ? `${ticket.assigned_to_user_name} (${ticket.assigned_to_emp_id || ticket.assigned_to})`
                      : t('triage.unassigned')}
                  </p>
                </div>
              </div>

              <div className="space-y-2 text-sm mb-3">
                <p><span className="font-semibold">{t('triage.issueType')}:</span> {ticket.issue_type}</p>
                <p><span className="font-semibold">{t('triage.userQuestion')}:</span> {ticket.user_query_original || '-'}</p>
                <p><span className="font-semibold">{t('triage.userComment')}:</span> {ticket.user_comment || '-'}</p>
                <p><span className="font-semibold">{t('triage.expectedAnswer')}:</span> {ticket.expected_answer || '-'}</p>
                <p><span className="font-semibold">{t('triage.assistantAnswer')}:</span> {ticket.assistant_answer || '-'}</p>
              </div>

              <div className="mb-3">
                <label className="block text-xs text-muted dark:text-dark-text-muted mb-1">{t('triage.replyToUser')}</label>
                <textarea
                  rows={2}
                  value={replyDraft[ticket.id] || ''}
                  onChange={(e) => setReplyDraft((prev) => ({ ...prev, [ticket.id]: e.target.value }))}
                  placeholder={t('triage.replyPlaceholder')}
                  className="w-full bg-surface dark:bg-dark-surface border border-default rounded-lg px-3 py-2 text-sm text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors"
                />
                <div className="mt-2">
                  <button
                    onClick={() => handleReply(ticket.id)}
                    disabled={updatingId === ticket.id || !String(replyDraft[ticket.id] || '').trim()}
                    className="px-3 py-1.5 rounded-lg text-xs border border-default hover:bg-surface-alt dark:hover:bg-dark-border disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('triage.sendReply')}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {STATUS_ORDER.map((status) => (
                  <button
                    key={status}
                    onClick={() => updateStatus(ticket.id, status)}
                    disabled={updatingId === ticket.id || ticket.status === status}
                    className="px-3 py-1.5 rounded-lg text-xs border border-default hover:bg-surface-alt dark:hover:bg-dark-border disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {status}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      </div>

      {showPurgeDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closePurgeDialog} />
          <div className="relative w-full max-w-md bg-white dark:bg-dark-surface rounded-2xl border border-[#E8E8E8] dark:border-dark-border shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[#E8E8E8] dark:border-dark-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-red-500" />
                <h4 className="text-base font-semibold text-foreground dark:text-dark-text">
                  {t('triage.purgeDialogTitle')}
                </h4>
              </div>
              <button
                type="button"
                onClick={closePurgeDialog}
                disabled={purging}
                className="p-1 rounded-md text-muted hover:text-foreground dark:text-dark-text-muted dark:hover:text-dark-text disabled:opacity-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <p className="text-sm text-muted dark:text-dark-text-muted">
                {t('triage.purgeDialogDescription')}
              </p>
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
                {t('triage.purgeIrreversible')}
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground dark:text-dark-text mb-1">
                  {t('triage.purgePasswordLabel')}
                </label>
                <input
                  type="password"
                  value={purgePassword}
                  onChange={(e) => setPurgePassword(e.target.value)}
                  placeholder={t('triage.purgePasswordPlaceholder')}
                  className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors"
                  autoFocus
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={closePurgeDialog}
                  disabled={purging}
                  className="px-4 py-2 rounded-lg border border-default text-sm text-foreground dark:text-dark-text hover:bg-surface-alt dark:hover:bg-dark-border disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={handlePurge}
                  disabled={purging || !purgePassword.trim()}
                  className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {purging ? t('triage.purging') : t('triage.purgeButton')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
