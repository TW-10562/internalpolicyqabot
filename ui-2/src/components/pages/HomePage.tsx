import {
  MessageSquare,
  History,
  BarChart3,
  FileText,
  Users,
  Activity,
  Send,
  HelpCircle,
  AlertTriangle,
} from 'lucide-react';
import { User, FeatureType } from '../../types';
import { useLang } from '../../context/LanguageContext';
import Header from '../layout/Header';
import ChatInterface from '../chat/ChatInterface';
import HistoryPage from '../chat/HistoryPage';
import NotificationsPanel from '../notifications/NotificationsPanel';
import AdminDashboard from '../admin/AdminDashboard';
import InlineContactAdmin from '../contact/InlineContactAdmin';
import FAQPage from '../faq/FAQPage';
import { useEffect, useState } from 'react';
import { getTriageSummary } from '../../api/triage';

interface HomePageProps {
  user: User;
  onFeatureClick: (feature: FeatureType) => void;
  onProfileClick: () => void;
  notifications?: any[];
  onMarkAsRead?: (item: any) => void;
  unreadCount?: number;
  onSendToAll?: (message: string) => void;
  onNotificationBellClick?: () => void;
  onClearNotifications?: (items: any[]) => void;
}

type Section =
  | 'chat'
  | 'history'
  | 'contact'
  | 'analytics'
  | 'documents'
  | 'users'
  | 'activity'
  | 'triage'
  | 'faq';

export default function HomePage({
  user,
  onProfileClick,
  notifications = [],
  onMarkAsRead,
  unreadCount = 0,
  onSendToAll,
  onNotificationBellClick,
  onClearNotifications,
}: HomePageProps) {
  const { t } = useLang();

  const [activeSection, setActiveSection] = useState<Section>(
    user.role === 'admin' ? 'analytics' : 'chat'
  );

  const [chatFocusTick, setChatFocusTick] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [notifSearch, setNotifSearch] = useState('');
  const [showNotificationPanel, setShowNotificationPanel] = useState(false);
  const [triageOpenCount, setTriageOpenCount] = useState(0);

  useEffect(() => {
    if (user.role !== 'admin') {
      setTriageOpenCount(0);
      return;
    }

    let mounted = true;
    const loadTriageSummary = async () => {
      try {
        const res: any = await getTriageSummary();
        if (!mounted) return;
        if (res?.code === 200) {
          setTriageOpenCount(Number(res?.result?.openCount || 0));
        }
      } catch {
        // ignore polling failures
      }
    };

    loadTriageSummary();
    const timer = setInterval(loadTriageSummary, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [user.role, user.roleCode, user.employeeId]);

  return (
    <div className="h-[100dvh] min-h-[100dvh] flex flex-col overflow-hidden bg-app">
      {/* Header */}
      <Header
        user={user}
        onProfileClick={onProfileClick}
        onNotificationBellClick={() => {
          onNotificationBellClick?.();
          const next = !showNotificationPanel;
          setShowNotificationPanel(next);
          // NOTE: Removed auto-mark behavior. Messages should only be marked as read
          // when user explicitly clicks "Mark as Read" button, not when opening panel.
        }}
        notifications={notifications}
        onMarkAsRead={onMarkAsRead}
        unreadCount={unreadCount}
        onSendToAll={onSendToAll}
        notificationSearch={notifSearch}
        onNotificationSearchChange={setNotifSearch}
      />

      {/* Main */}
     <main className="mac-glass-page flex-1 min-h-0 overflow-hidden bg-surface dark:bg-dark-gradient transition-colors px-2 pt-2 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-3 lg:px-3 lg:pb-2">
        <div className={`h-full min-h-0 gap-4 overflow-hidden flex flex-col lg:grid ${showNotificationPanel ? 'lg:grid-cols-[72px_minmax(0,1fr)] xl:grid-cols-[72px_minmax(0,1fr)_320px]' : 'lg:grid-cols-[72px_minmax(0,1fr)]'}`}>
          {/* Sidebar */}
          <aside className="hidden lg:block h-full min-h-0">
            <div className="left-sidebar h-full rounded-xl overflow-hidden
  mac-border-highlight border-l border-t border-b">
              <div className="sidebar-inner h-full overflow-y-auto flex flex-col items-center gap-3 pt-4">
                {sidebarButtons(
                  user.role,
                  user.roleCode,
                  activeSection,
                  setActiveSection,
                  setChatFocusTick,
                  t,
                  triageOpenCount,
                )}
              </div>
            </div>
          </aside>

          {/* Main content */}
          <section
            key={activeSection}
            className="relative h-full min-h-0 min-w-0 rounded-xl mac-glass mac-glass-translucent mac-border-highlight mac-tab-animate overflow-hidden flex flex-col"
          >
            {user.role !== 'admin' && activeSection === 'chat' && (
              <ChatInterface
                focusSignal={chatFocusTick}
                onUserTyping={setIsTyping}
              />
            )}

            {user.role !== 'admin' && activeSection === 'history' && (
              <HistoryPage user={user} />
            )}

            {user.role !== 'admin' && activeSection === 'contact' && (
              <InlineContactAdmin userId={user.employeeId} />
            )}

            {user.role === 'admin' && activeSection === 'history' && (
              <HistoryPage user={user} />
            )}

            {user.role === 'admin' && activeSection !== 'history' && (
              <AdminDashboard
                activeTab={activeSection as any}
                onTabChange={(t) => setActiveSection(t as Section)}
                initialTab="analytics"
                user={user}
              />
            )}

            {user.role !== 'admin' && activeSection === 'faq' && (
              <FAQPage user={user} />
            )}
          </section>

          {/* Notifications */}
          {showNotificationPanel && (
            <>
              <button
                type="button"
                aria-label={t('notificationsPanel.title')}
                onClick={() => setShowNotificationPanel(false)}
                className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-[1px] xl:hidden"
              />
              <section
                className="fixed inset-x-3 top-20 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-50 rounded-2xl mac-glass mac-glass-translucent mac-border-highlight shadow-xl overflow-hidden xl:hidden"
              >
                <NotificationsPanel
                  items={notifications as any}
                  searchTerm={notifSearch}
                  onMarkAsRead={onMarkAsRead}
                  onClearAll={onClearNotifications}
                  onSearchChange={setNotifSearch}
                  dimmed={isTyping}
                  currentViewerId={user.employeeId}
                  currentViewerRole={user.role}
                />
              </section>
              <section
                className="hidden xl:block h-full min-h-0 min-w-0 rounded-xl mac-glass mac-glass-translucent mac-border-highlight shadow-sm overflow-hidden"
              >
                <NotificationsPanel
                  items={notifications as any}
                  searchTerm={notifSearch}
                  onMarkAsRead={onMarkAsRead}
                  onClearAll={onClearNotifications}
                  onSearchChange={setNotifSearch}
                  dimmed={isTyping}
                  currentViewerId={user.employeeId}
                  currentViewerRole={user.role}
                />
              </section>
            </>
          )}
        </div>
      </main>

      {/* Mobile nav */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-50 border-t border-default bg-surface/95 backdrop-blur shadow-lg pb-[env(safe-area-inset-bottom)]">
        <nav className="flex items-center justify-start gap-2 overflow-x-auto px-3 py-2 sm:justify-center">
          {navButtons(
            user.role,
            user.roleCode,
            activeSection,
            setActiveSection,
            setChatFocusTick,
            t,
            true,
            triageOpenCount,
          )}
        </nav>
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */

function navButtons(
  role: string,
  roleCode: User['roleCode'] | undefined,
  active: Section,
  setActive: (v: Section) => void,
  setChatFocusTick: (fn: any) => void,
  t: (k: string) => string,
  compact = false,
  triageOpenCount = 0,
) {
  const isSuperAdmin = roleCode === 'SUPER_ADMIN';
  const btn = (key: Section, icon: JSX.Element) => (
    <button
      key={key}
      title={t(`nav.${key}`)}
      aria-label={t(`nav.${key}`)}
      onClick={() => {
        setActive(key);
        if (key === 'chat') setChatFocusTick((v: number) => v + 1);
      }}
      className={`${
        compact ? 'h-11 min-w-[2.75rem] shrink-0' : 'w-12 h-12'
      } flex items-center justify-center rounded-xl transition-all
        ${active === key ? 'btn-primary text-on-accent' : 'text-muted hover:bg-surface-alt hover:text-accent'}`}
    >
      <span className="relative inline-flex">
        {icon}
        {key === 'triage' && triageOpenCount > 0 ? (
          <span className="absolute -top-2 -right-2 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold leading-none flex items-center justify-center">
            {triageOpenCount > 99 ? '99+' : triageOpenCount}
          </span>
        ) : null}
      </span>
    </button>
  );

  return role !== 'admin'
    ? [
        btn('chat', <MessageSquare className="w-5 h-5" />),
        btn('history', <History className="w-5 h-5" />),
        btn('faq', <HelpCircle className="w-5 h-5" />),
        btn('contact', <Send className="w-5 h-5" />),
      ]
    : [
        btn('analytics', <BarChart3 className="w-5 h-5" />),
        btn('documents', <FileText className="w-5 h-5" />),
        ...(isSuperAdmin ? [btn('users', <Users className="w-5 h-5" />)] : []),
        ...(isSuperAdmin ? [btn('history', <History className="w-5 h-5" />)] : []),
        btn('chat', <MessageSquare className="w-5 h-5" />),
        btn('triage', <AlertTriangle className="w-5 h-5" />),
        btn('activity', <Activity className="w-5 h-5" />),
        btn('contact', <Send className="w-5 h-5" />),
      ];
}

function sidebarButtons(
  role: string,
  roleCode: User['roleCode'] | undefined,
  active: Section,
  setActive: (v: Section) => void,
  setChatFocusTick: (fn: any) => void,
  t: (k: string) => string,
  triageOpenCount = 0,
) {
  const isSuperAdmin = roleCode === 'SUPER_ADMIN';
  const create = (key: Section, icon: JSX.Element) => (
    <button
      key={key}
      title={t(`nav.${key}`)}
      aria-label={t(`nav.${key}`)}
      onClick={() => {
        setActive(key);
        if (key === 'chat') setChatFocusTick((v: number) => v + 1);
      }}
      className={`sidebar-btn ${active === key ? 'active' : ''}`}
    >
      <span className="relative inline-flex">
        {icon}
        {key === 'triage' && triageOpenCount > 0 ? (
          <span className="absolute -top-2 -right-2 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold leading-none flex items-center justify-center">
            {triageOpenCount > 99 ? '99+' : triageOpenCount}
          </span>
        ) : null}
      </span>
    </button>
  );

  return role !== 'admin' ? (
    <>
      {create('chat', <MessageSquare className="w-5 h-5" />)}
      {create('history', <History className="w-5 h-5" />)}
      {create('faq', <HelpCircle className="w-5 h-5" />)}
      {create('contact', <Send className="w-5 h-5" />)}
    </>
  ) : (
    <>
      {create('analytics', <BarChart3 className="w-5 h-5" />)}
      {create('documents', <FileText className="w-5 h-5" />)}
      {isSuperAdmin ? create('users', <Users className="w-5 h-5" />) : null}
      {isSuperAdmin ? create('history', <History className="w-5 h-5" />) : null}
      {create('chat', <MessageSquare className="w-5 h-5" />)}
      {create('triage', <AlertTriangle className="w-5 h-5" />)}
      {create('activity', <Activity className="w-5 h-5" />)}
      {create('contact', <Send className="w-5 h-5" />)}
    </>
  );
}
