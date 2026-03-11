import { useState, useEffect, useRef } from 'react';
import {
  FileText,
  Users,
  Activity,
  MessageSquare,
  BarChart3,
  AlertTriangle,
  Search,
  Upload,
  Plus,
} from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';
import { getToken } from '../../api/auth';
import { purgeAllUserNotifications } from '../../api/notifications';
import AnalyticsDashboard from './AnalyticsDashboard';
import ChatInterface from '../chat/ChatInterface';
import UserManagement, { UserManagementHandle } from './UserManagement';
import ContactUsersPanel from './ContactUsersPanel';
import DocumentUpload from './DocumentUpload';
import DocumentTable from './DocumentTable';
import ActivityLogComponent from './ActivityLog';
import DeleteMessagesModal from './DeleteMessagesModal';
import TriagePanel from './TriagePanel';
import { User as UserType } from '../../types';

type Tab = 'documents' | 'analytics' | 'users' | 'activity' | 'chat' | 'contact' | 'messages' | 'triage';

interface AdminDashboardProps {
  activeTab?: Tab;
  onTabChange?: (tab: Tab) => void;
  initialTab?: Tab;
  user?: UserType;
}

interface DocumentHistory {
  id: number;
  filename: string;
  size: number;
  mime_type: string;
  created_at: string;
  create_by: string;
  storage_key: string;
  department_code?: 'HR' | 'GA' | 'ACC' | 'OTHER';
}

interface ActivityLog {
  id: string;
  user: string;
  action: string;
  detail: string;
  timestamp: Date;
}

export default function AdminDashboard({ activeTab: controlledTab, onTabChange, initialTab, user }: AdminDashboardProps) {
  const { t } = useLang();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<Tab>(controlledTab || initialTab || 'analytics');
  const [documentHistory, setDocumentHistory] = useState<DocumentHistory[]>([]);
  const [mockActivity, setMockActivity] = useState<ActivityLog[]>([]);
  const [showDeleteMessages, setShowDeleteMessages] = useState(false);
  const [triggerUpload, setTriggerUpload] = useState(false);
  const [purgingNotifications, setPurgingNotifications] = useState(false);
  const [documentSearchQuery, setDocumentSearchQuery] = useState('');
  const userManagementRef = useRef<UserManagementHandle | null>(null);

  const loadAllDocuments = async (): Promise<DocumentHistory[]> => {
    const token = getToken();
    const pageSize = 200;
    let pageNum = 1;
    let total = Number.POSITIVE_INFINITY;
    const all: DocumentHistory[] = [];

    while (all.length < total) {
      const response = await fetch(`/dev-api/api/files?pageNum=${pageNum}&pageSize=${pageSize}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await response.json();
      const rows = data.result?.rows || data.data || data.rows || [];
      const count = Number(data.result?.count ?? data.count ?? rows.length ?? 0);
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      total = Number.isFinite(count) ? count : all.length;
      if (rows.length < pageSize) break;
      pageNum += 1;
    }

    return all;
  };

  // Sync internal tab with controlled prop
  useEffect(() => {
    if (controlledTab && controlledTab !== activeTab) {
      setActiveTab(controlledTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledTab]);

  // Load document history
  useEffect(() => {
    const loadDocumentHistory = async () => {
      try {
        console.log('📂 [AdminDashboard] Fetching document history from database...');
        const files = await loadAllDocuments();
        console.log('✅ [AdminDashboard] Document history loaded:', { total: files.length });
        setDocumentHistory(files);
      } catch (error) {
        console.error('❌ [AdminDashboard] Error fetching document history:', error);
      }
    };

    loadDocumentHistory();
  }, []);

  // Load users and activity
  useEffect(() => {
    console.log('📊 [AdminDashboard] Setting up users and activity...');

    const activities: ActivityLog[] = documentHistory.slice(0, 10).map((doc, index) => ({
      id: String(index + 1),
      user: doc.create_by || t('activity.admin'),
      action: t('activity.documentUploaded'),
      detail: doc.filename,
      timestamp: new Date(doc.created_at),
    }));

    activities.unshift({
      id: 'chat-1',
      user: t('activity.admin'),
      action: t('activity.chatQuery'),
      detail: t('activity.chatDetail'),
      timestamp: new Date(),
    });

    setMockActivity(activities);
  }, [documentHistory, t]);

  const handleDocumentRefresh = async () => {
    try {
      const files = await loadAllDocuments();
      setDocumentHistory(files);
    } catch (refreshError) {
      console.error('❌ [AdminDashboard] Error refreshing document list:', refreshError);
    }
  };

  const handlePurgeAllUserNotifications = async () => {
    const confirmed = window.confirm(
      t('messages.purgeNotificationsConfirm'),
    );
    if (!confirmed) return;

    setPurgingNotifications(true);
    try {
      const res: any = await purgeAllUserNotifications();
      if (res?.ok === true) {
        const total = Number(res?.data?.totalDeleted || 0);
        const scope = String(res?.data?.scope || 'ALL');
        toast.success(
          t('messages.purgeNotificationsSuccessTitle'),
          `${t('messages.purgeNotificationsSuccessBody')} ${total} / ${scope}`,
        );
        return;
      }
      toast.error(
        t('messages.purgeNotificationsErrorTitle'),
        res?.error?.message || res?.message || t('messages.purgeNotificationsErrorBody'),
      );
    } catch (error: any) {
      toast.error(
        t('messages.purgeNotificationsErrorTitle'),
        error?.message || t('messages.purgeNotificationsErrorBody'),
      );
    } finally {
      setPurgingNotifications(false);
    }
  };

  const tabs = [
    { id: 'documents' as Tab, label: t('admin.documents'), icon: FileText },
    { id: 'analytics' as Tab, label: t('admin.analytics'), icon: BarChart3 },
    { id: 'users' as Tab, label: t('admin.users'), icon: Users },
    { id: 'activity' as Tab, label: t('admin.activity'), icon: Activity },
    { id: 'chat' as Tab, label: t('admin.chat'), icon: MessageSquare },
    { id: 'triage' as Tab, label: t('admin.triage'), icon: AlertTriangle },
    { id: 'contact' as Tab, label: t('admin.contact'), icon: Users },
    { id: 'messages' as Tab, label: t('admin.messages'), icon: FileText },
  ];
  const activeTabLabel = tabs.find((tab) => tab.id === activeTab)?.label || '';
  const roleBadgeKey = (() => {
    if (user?.roleCode === 'SUPER_ADMIN') return 'adminScope.badge.superAdmin';
    if (user?.roleCode === 'HR_ADMIN') return 'adminScope.badge.hrAdmin';
    if (user?.roleCode === 'GA_ADMIN') return 'adminScope.badge.gaAdmin';
    if (user?.roleCode === 'ACC_ADMIN') return 'adminScope.badge.accAdmin';
    if (user?.role === 'admin' && user?.departmentCode === 'HR') return 'adminScope.badge.hrAdmin';
    if (user?.role === 'admin' && user?.departmentCode === 'GA') return 'adminScope.badge.gaAdmin';
    if (user?.role === 'admin' && user?.departmentCode === 'ACC') return 'adminScope.badge.accAdmin';
    return '';
  })();

  return (
    <div className="flex flex-col h-full">
      {/* Hide internal tab bar when controlled by external sidebar */}
      {!controlledTab && (
        <div className="flex border-b border-default bg-surface dark:bg-dark-bg-primary transition-colors overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                onTabChange?.(tab.id);
              }}
              className={`flex items-center justify-center gap-2 px-6 py-4 transition-all whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-surface-alt dark:bg-dark-surface border-b-2 border-accent dark:border-accent-strong text-accent dark:text-accent-strong'
                  : 'text-muted dark:text-dark-text-muted hover:bg-surface-alt dark:hover:bg-dark-border hover:text-foreground dark:hover:text-white'
              }`}
            >
              <tab.icon className="w-5 h-5" />
              <span className="font-medium">{tab.label}</span>
            </button>
          ))}
        </div>
      )}

      {activeTab !== 'chat' && (
        <div className="px-4 py-3 border-b border-default bg-surface dark:bg-dark-bg-primary transition-colors">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="app-page-title">{activeTabLabel}</h2>
              {activeTab === 'analytics' && roleBadgeKey ? (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200 dark:border-blue-800/40">
                  {t('adminScope.currentRole')}: {t(roleBadgeKey)}
                </span>
              ) : null}
            </div>
            {activeTab === 'documents' ? (
              <div className="flex items-center gap-3 w-full lg:max-w-3xl">
                <div className="relative flex-1 min-w-0">
                  <div className="input-icon-absolute pointer-events-none">
                    <Search className="w-4 h-4 text-icon-muted dark:text-dark-text-muted icon-current" />
                  </div>
                  <input
                    type="text"
                    value={documentSearchQuery}
                    onChange={(e) => setDocumentSearchQuery(e.target.value)}
                    placeholder={t('documentTable.searchPlaceholder')}
                    className="w-full input-with-icon pr-4 py-2 bg-surface dark:bg-dark-surface border border-default dark:border-default rounded-xl text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors"
                  />
                </div>
                <button
                  onClick={() => setTriggerUpload(true)}
                  className="flex items-center justify-center gap-2 h-10 px-4 btn-primary dark:bg-accent-strong text-on-accent rounded-xl transition-colors cursor-pointer whitespace-nowrap font-medium shadow-sm"
                  title={t('documentTable.upload')}
                >
                  <Upload className="w-4 h-4 icon-current" />
                  <span className="hidden sm:inline">{t('documentTable.upload')}</span>
                </button>
              </div>
            ) : null}
            {activeTab === 'users' ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => userManagementRef.current?.openCsvUpload()}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg btn-success text-on-accent text-sm font-medium transition-colors"
                >
                  <Upload className="w-4 h-4 icon-current" />
                  {t('userManagement.uploadCsv')}
                </button>
                <button
                  onClick={() => userManagementRef.current?.openAddUserModal()}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg btn-primary text-on-accent text-sm font-medium transition-colors"
                >
                  <Plus className="w-4 h-4 icon-current" />
                  {t('userManagement.form.addUserTitle')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}

      <div key={activeTab} className="flex-1 overflow-y-auto p-4 mac-tab-animate bg-app transition-colors">
        {activeTab === 'documents' && (
          <>
            <DocumentUpload
              documentHistory={documentHistory}
              onUploadComplete={() => {
                void handleDocumentRefresh();
              }}
              triggerFileInput={triggerUpload}
              onTriggerReset={() => setTriggerUpload(false)}
              currentUser={user}
            />
            <DocumentTable
              documentHistory={documentHistory}
              onDocumentDeleted={handleDocumentRefresh}
              onUploadClick={() => setTriggerUpload(true)}
              showTitle={false}
              showControls={false}
              searchQuery={documentSearchQuery}
              onSearchQueryChange={setDocumentSearchQuery}
            />
          </>
        )}

        {activeTab === 'analytics' && <AnalyticsDashboard user={user} showHeader={false} />}

        {activeTab === 'chat' && (
          <div className="bg-surface dark:bg-dark-surface border border-default rounded-2xl overflow-hidden animate-section-in flex flex-col h-full shadow-sm transition-colors">
            <div className="flex-1 min-h-0">
              <ChatInterface onSaveToHistory={() => {}} />
            </div>
          </div>
        )}

        {activeTab === 'contact' && (
          <>
            <ContactUsersPanel onOpenDeleteMessages={() => setShowDeleteMessages(true)} />
          </>
        )}

        {activeTab === 'triage' && <TriagePanel currentUser={user} />}

        {activeTab === 'users' && (
          <UserManagement ref={userManagementRef} showTitle={false} showControls={false} currentUser={user} />
        )}

        {activeTab === 'activity' && (
          <ActivityLogComponent activities={mockActivity} showTitle={false} />
        )}

        {activeTab === 'messages' && (
          <div className="space-y-4">
            <button
              onClick={() => setShowDeleteMessages(true)}
              className="w-full px-6 py-3 bg-red-500 hover:bg-red-600 text-white font-semibold rounded-xl transition-colors"
            >
              {t('messages.deleteButton')}
            </button>
            <button
              onClick={handlePurgeAllUserNotifications}
              disabled={purgingNotifications}
              className="w-full px-6 py-3 bg-red-700 hover:bg-red-800 disabled:opacity-60 text-white font-semibold rounded-xl transition-colors"
            >
              {purgingNotifications
                ? t('messages.purgeNotificationsDeleting')
                : t('messages.purgeNotificationsButton')}
            </button>
          </div>
        )}
      </div>

      {/* Delete Messages Modal */}
      <DeleteMessagesModal
        isOpen={showDeleteMessages}
        onClose={() => setShowDeleteMessages(false)}
        onSuccess={handleDocumentRefresh}
      />
    </div>
  );
}
