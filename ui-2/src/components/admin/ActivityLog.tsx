import {
  Activity,
  Clock,
  FileText,
  UserPlus,
  UserMinus,
  UserCheck,
  AlertTriangle,
  MessageSquare,
  Trash2,
  Shield,
} from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { formatDateTimeJP } from '../../lib/dateTime';
import { exportCsv, exportPdf, stampedFilename, type PdfColumnDef } from '../../lib/export';
import ExportDropdown from '../shared/ExportDropdown';

interface ActivityLog {
  id: string;
  user: string;
  email?: string;
  role?: string;
  department?: string;
  action: string;
  actionRaw?: string;
  detail: string;
  details?: Record<string, any>;
  timestamp: Date;
}

interface ActivityLogProps {
  activities: ActivityLog[];
  showTitle?: boolean;
}

const ACTION_ICON: Record<string, any> = {
  DOCUMENT_UPLOADED: FileText,
  USER_CREATED: UserPlus,
  USER_UPDATED: UserCheck,
  USER_DELETED: UserMinus,
  USER_RESTORED: UserCheck,
  USER_PERMANENTLY_DELETED: Trash2,
  USER_BULK_DELETED: Trash2,
  TRIAGE_TICKET_CREATED: AlertTriangle,
  TRIAGE_TICKET_REUSED: AlertTriangle,
  TRIAGE_STATUS_CHANGED: Shield,
  TRIAGE_REPLY_SENT: MessageSquare,
  TRIAGE_TICKETS_PURGED: Trash2,
};

const ACTION_COLOR: Record<string, string> = {
  DOCUMENT_UPLOADED: 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  USER_CREATED: 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400',
  USER_UPDATED: 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
  USER_DELETED: 'bg-red-50 text-red-500 dark:bg-red-900/30 dark:text-red-400',
  USER_RESTORED: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400',
  USER_PERMANENTLY_DELETED: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400',
  USER_BULK_DELETED: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400',
  TRIAGE_TICKET_CREATED: 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
  TRIAGE_TICKET_REUSED: 'bg-amber-50 text-amber-500 dark:bg-amber-900/30 dark:text-amber-400',
  TRIAGE_STATUS_CHANGED: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400',
  TRIAGE_REPLY_SENT: 'bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400',
  TRIAGE_TICKETS_PURGED: 'bg-red-50 text-red-500 dark:bg-red-900/30 dark:text-red-400',
};

const ACTION_BADGE_COLOR: Record<string, string> = {
  DOCUMENT_UPLOADED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  USER_CREATED: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  USER_UPDATED: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  USER_DELETED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  USER_RESTORED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  USER_PERMANENTLY_DELETED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  USER_BULK_DELETED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  TRIAGE_TICKET_CREATED: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  TRIAGE_TICKET_REUSED: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  TRIAGE_STATUS_CHANGED: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  TRIAGE_REPLY_SENT: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  TRIAGE_TICKETS_PURGED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

function DetailRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="text-muted dark:text-dark-text-muted font-medium min-w-[100px] flex-shrink-0">{label}</span>
      <span className="text-foreground dark:text-dark-text break-all">{value}</span>
    </div>
  );
}

export default function ActivityLogComponent({ activities, showTitle = true }: ActivityLogProps) {
  const { t } = useLang();

  const buildExportRows = () => {
    const headers = ['Timestamp', 'User', 'Email', 'Role', 'Department', 'Action', 'Detail'];
    const rows = activities.map((a) => [
      formatDateTimeJP(a.timestamp),
      a.user,
      a.email || '',
      a.role || '',
      a.department || '',
      a.action,
      a.detail,
    ]);
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const { headers, rows } = buildExportRows();
    exportCsv(stampedFilename('activity-logs'), headers, rows);
  };

  const handleExportPdf = async () => {
    const { rows } = buildExportRows();
    const pdfHeaders: PdfColumnDef[] = [
      { header: 'Timestamp', width: 2 },
      { header: 'User', width: 2 },
      { header: 'Email', width: 2 },
      { header: 'Role', width: 1 },
      { header: 'Department', width: 1 },
      { header: 'Action', width: 2 },
      { header: 'Detail', width: 4 },
    ];
    await exportPdf({
      title: 'Activity Logs',
      subtitle: `${activities.length} records`,
      headers: pdfHeaders,
      rows,
      filename: stampedFilename('activity-logs'),
      orientation: 'landscape',
    });
  };

  return (
    <div className="space-y-4">
      {showTitle ? (
        <div className="flex items-center justify-between">
          <h3 className="app-page-title transition-colors">{t('activity.title')}</h3>
          {activities.length > 0 && <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />}
        </div>
      ) : (
        activities.length > 0 && (
          <div className="flex justify-end">
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
          </div>
        )
      )}

      {activities.length === 0 ? (
        <div className="text-center text-muted dark:text-dark-text-muted text-sm py-8">
          No activity yet.
        </div>
      ) : (
        <div className="space-y-3">
          {activities.map((activity) => {
            const raw = activity.actionRaw || '';
            const IconComponent = ACTION_ICON[raw] || Activity;
            const iconColor = ACTION_COLOR[raw] || 'bg-[#F0F4FF] text-[#1d2089] dark:bg-dark-surface-alt dark:text-dark-accent-blue';
            const badgeColor = ACTION_BADGE_COLOR[raw] || 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
            const details = activity.details || {};

            return (
              <div
                key={activity.id}
                className="bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-2xl p-4 hover:bg-[#F6F6F6] dark:hover:bg-dark-border transition-colors shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${iconColor}`}>
                    <IconComponent className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* Header: email + action badge + timestamp */}
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <span className="text-sm font-semibold text-foreground dark:text-dark-text transition-colors truncate">
                        {activity.email || activity.user}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${badgeColor}`}>
                        {activity.action}
                      </span>
                      {activity.role && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          {activity.role}
                        </span>
                      )}
                      {activity.department && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300">
                          {activity.department}
                        </span>
                      )}
                    </div>

                    {/* Detail summary */}
                    {activity.detail && (
                      <p className="text-sm text-foreground dark:text-dark-text mb-2 transition-colors">
                        {activity.detail}
                      </p>
                    )}

                    {/* Rich details for specific action types */}
                    {(raw.startsWith('TRIAGE_') || raw.startsWith('USER_') || raw === 'DOCUMENT_UPLOADED') && Object.keys(details).length > 0 && (
                      <div className="mt-2 p-2.5 bg-[#F6F6F6] dark:bg-dark-bg-primary rounded-xl space-y-1.5 border border-[#E8E8E8] dark:border-dark-border">
                        {details.filename && <DetailRow label={t('documentTable.fileName')} value={details.filename} />}
                        {details.departmentCode && <DetailRow label={t('documentTable.department')} value={details.departmentCode} />}
                        {details.issueType && <DetailRow label={t('triage.issueType')} value={details.issueType} />}
                        {details.routingMode && <DetailRow label="Routing" value={`${details.routingMode} (${details.routingSource || '-'})`} />}
                        {details.status && <DetailRow label={t('documentTable.status')} value={details.status} />}
                        {details.reply && <DetailRow label={t('triage.replyToUser')} value={details.reply} />}
                        {details.adminReply && <DetailRow label={t('triage.replyToUser')} value={details.adminReply} />}
                        {details.employeeId && <DetailRow label={t('userManagement.table.employeeId')} value={details.employeeId} />}
                        {details.roleCode && <DetailRow label={t('userManagement.table.role')} value={details.roleCode} />}
                        {details.mimeType && <DetailRow label="Type" value={details.mimeType} />}
                        {details.size != null && <DetailRow label={t('documentTable.size')} value={`${(Number(details.size) / 1024 / 1024).toFixed(2)} MB`} />}
                      </div>
                    )}

                    {/* Timestamp */}
                    <div className="flex items-center gap-1 text-xs text-[#9CA3AF] dark:text-dark-text-muted mt-2 transition-colors">
                      <Clock className="w-3 h-3" />
                      <span>{formatDateTimeJP(activity.timestamp)}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
