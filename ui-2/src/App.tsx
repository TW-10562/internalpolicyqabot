import { useState, useEffect, useRef, useCallback } from 'react';
import { ToastProvider, useToast } from './context/ToastContext';
import { LanguageProvider } from './context/LanguageContext';
import { useLang } from './context/LanguageContext';
import { ThemeProvider } from './context/ThemeContext';
import LoginPage from './components/pages/LoginPage';
import HomePage from './components/pages/HomePage';
import Popup from './components/modals/Popup';
import ChatInterface from './components/chat/ChatInterface';
import HistoryPage from './components/chat/HistoryPage';
import ProfilePopup from './components/modals/ProfilePopup';
import AdminDashboard from './components/admin/AdminDashboard';
// @ts-ignore
import Messenger from './components/chat/Messenger';
// @ts-ignore
import ContactAdminPopup from './components/modals/ContactAdminPopup';
import BroadcastModal from './components/modals/BroadcastModal';
import { User, FeatureType } from './types';
import {
  createSupportTicket,
  getMyTickets,
  getNotifications as getSupportNotifications,
  markNotificationRead as markSupportNotificationRead,
} from './api/support';
import {
  listNotifications as listAppNotifications,
  markNotificationRead as markAppNotificationRead,

} from './api/notifications';
import { getToken, logout } from './api/auth';
import { logoutFromMicrosoft } from './auth/microsoftAuth';
import { checkSystemHealth } from './api/health';


const POLL_INTERVAL_MS = 30_000; // 30 seconds

/** Proactive health monitor — must be rendered inside ToastProvider */
function SystemHealthMonitor() {
  const toast = useToast();
  const { t } = useLang();

  useEffect(() => {
    let cancelled = false;
    const HEALTH_POLL_MS = 60_000;

    const runHealthCheck = async () => {
      try {
        const health = await checkSystemHealth();
        if (cancelled) return;
        if (!health.llm) {
          toast.addToast({
            type: 'warning',
            title: t('health.systemNotice'),
            message: t('health.llmUnavailable'),
            duration: 12000,
          });
        }
        if (!health.db) {
          toast.addToast({
            type: 'error',
            title: t('health.serviceDisruption'),
            message: t('health.dbUnavailable'),
            duration: 12000,
          });
        }
      } catch {
        if (cancelled) return;
        toast.addToast({
          type: 'error',
          title: t('health.serviceUnavailable'),
          message: t('health.serverUnreachable'),
          duration: 12000,
        });
      }
    };

    runHealthCheck();
    const interval = setInterval(runHealthCheck, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [t]);

  return null;
}

function AppContent() {
  const { t } = useLang();
  const [user, setUser] = useState<User | null>(null);
  const [activeFeature, setActiveFeature] = useState<FeatureType | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [showContactAdminModal, setShowContactAdminModal] = useState(false);
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Track whether we've done the initial bell-click mark-all-read
  const bellMarkedReadRef = useRef(false);

  // Compute unread count from notification list
  const computeNotificationCount = useCallback((messagesList: any[], userRole: string): number => {
    if (!Array.isArray(messagesList)) return 0;
    return messagesList.filter((msg: any) => {
      if (msg.read) return false;
      // Never count self-sent messages as unread
      if (msg.sentByViewer) return false;
      // App notifications and broadcasts are always counted when unread
      if (msg.sourceType === 'app_notification' || msg.is_broadcast) return true;
      if (userRole === 'admin') return msg.senderRole === 'user';
      return msg.senderRole === 'admin';
    }).length;
  }, []);

  // Local persistence for read states across refresh
  const getViewerKey = (u: User | null) => u?.employeeId || 'anonymous';
  const getReadStorageKeys = (viewerKey: string) => ({
    notification: `read_notification_ids_${viewerKey}`,
    message: `read_message_ids_${viewerKey}`,
    local: `read_local_notification_ids_${viewerKey}`,
  });
  const getHiddenStorageKeys = (viewerKey: string) => ({
    notification: `hidden_notification_ids_${viewerKey}`,
    message: `hidden_message_ids_${viewerKey}`,
    local: `hidden_local_notification_ids_${viewerKey}`,
  });

  const getReadSets = (viewerKey: string) => {
    try {
      const keys = getReadStorageKeys(viewerKey);
      const n = JSON.parse(localStorage.getItem(keys.notification) || '[]');
      const m = JSON.parse(localStorage.getItem(keys.message) || '[]');
      const l = JSON.parse(localStorage.getItem(keys.local) || '[]');
      return { n: new Set<number>(n), m: new Set<number>(m), l: new Set<string>(l) };
    } catch {
      return { n: new Set<number>(), m: new Set<number>(), l: new Set<string>() };
    }
  };
  const getHiddenSets = (viewerKey: string) => {
    try {
      const keys = getHiddenStorageKeys(viewerKey);
      const n = JSON.parse(localStorage.getItem(keys.notification) || '[]');
      const m = JSON.parse(localStorage.getItem(keys.message) || '[]');
      const l = JSON.parse(localStorage.getItem(keys.local) || '[]');
      return { n: new Set<number>(n), m: new Set<number>(m), l: new Set<string>(l) };
    } catch {
      return { n: new Set<number>(), m: new Set<number>(), l: new Set<string>() };
    }
  };
  const addReadId = (notificationId: number | undefined, messageId: number | undefined, localId: string | undefined, viewerKey: string) => {
    const { n, m, l } = getReadSets(viewerKey);
    const keys = getReadStorageKeys(viewerKey);
    let changedN = false, changedM = false, changedL = false;
    if (typeof notificationId === 'number') { n.add(notificationId); changedN = true; }
    if (typeof messageId === 'number') { m.add(messageId); changedM = true; }
    if (localId) { l.add(localId); changedL = true; }
    if (changedN) localStorage.setItem(keys.notification, JSON.stringify(Array.from(n)));
    if (changedM) localStorage.setItem(keys.message, JSON.stringify(Array.from(m)));
    if (changedL) localStorage.setItem(keys.local, JSON.stringify(Array.from(l)));
  };
  const applyViewerState = (arr: any[], viewerKey: string) => {
    if (!Array.isArray(arr)) return [];
    const hidden = getHiddenSets(viewerKey);
    return arr.flatMap((it) => {
      if (!it) return [];
      const localId = it?.id ? String(it.id) : '';
      const isHidden = (it?.notificationId != null && hidden.n.has(it.notificationId))
        || (it?.messageId != null && hidden.m.has(it.messageId))
        || (localId && hidden.l.has(localId));
      if (isHidden) return [];

      // Trust backend read state. Per-user tracking (message_reads / notification_reads)
      // is the source of truth. Optimistic updates are handled via React state in handleMarkAsRead.
      return [{ ...it }];
    });
  };

  // Compose role-specific notification list consistently
  const composeNotifications = (
    role: 'admin' | 'user',
    inbox: any[] = [],
    supportItems: any[] = [],
    appNotifs: any[] = [],
  ) => {
    const messageMap = new Map<string, any>();

    // Exclude messages sent by the current viewer — they should never appear as notifications
    const notSentByViewer = (msg: any) => !msg.sentByViewer;

    if (role === 'admin') {
      const allMessages = [
        ...inbox.filter((msg) => notSentByViewer(msg) && ((msg.senderRole === 'user' && msg.sourceType === 'message') || msg.is_broadcast)),
        ...supportItems.filter((msg) => msg.senderRole === 'user' && msg.sourceType === 'support_ticket'),
        ...appNotifs,
      ];
      for (const msg of allMessages) {
        if (msg && msg.id) {
          messageMap.set(msg.id, { ...msg });
        }
      }
    } else {
      const allMessages = [
        ...inbox.filter((msg) => notSentByViewer(msg) && (msg.senderRole === 'admin' && msg.sourceType === 'message')),
        ...supportItems.filter((msg) => msg.senderRole === 'admin' && msg.sourceType === 'support_reply'),
        ...appNotifs,
      ];
      for (const msg of allMessages) {
        if (msg && msg.id) {
          messageMap.set(msg.id, { ...msg });
        }
      }
    }

    const result = Array.from(messageMap.values());
    result.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Deduplicate: triage reply creates both an app_notification and a message for
    // the same event. When both exist with similar title/body within 2 minutes,
    // keep the message (richer data) and drop the app_notification duplicate.
    const seen = new Map<string, any>();
    const deduped: any[] = [];
    for (const item of result) {
      const title = String(item.subject || item.title || '').trim().toLowerCase().replace(/\s*from\s+\S+$/i, '');
      const body = String(item.message || item.text || '').trim().substring(0, 80).toLowerCase();
      const minute = Math.floor((item.timestamp || 0) / 120000); // 2-min bucket
      const key = `${title}|${body}|${minute}`;
      const existing = seen.get(key);
      if (existing) {
        // Prefer non-app_notification (messages have richer sender data)
        if (existing.sourceType === 'app_notification' && item.sourceType !== 'app_notification') {
          seen.set(key, item);
          const idx = deduped.indexOf(existing);
          if (idx >= 0) deduped[idx] = item;
        }
        // else keep existing, skip this duplicate
      } else {
        seen.set(key, item);
        deduped.push(item);
      }
    }
    return deduped;
  };

  // FIX: Use sender_type from the actual message data instead of assuming by viewer role
  const mapInboxMessages = (rows: any[], role: 'admin' | 'user', currentUserId?: number) =>
    (rows || []).map((m: any) => {
      const senderType = String(m.sender_type || '').toLowerCase();
      const actualSenderRole = senderType === 'admin' ? 'admin' : 'user';
      // Detect if this message was sent by the current viewer using the numeric user ID
      const sentByViewer = currentUserId != null && Number(m.sender_user_id) === currentUserId;
      return {
        id: `msg-${m.id}`,
        messageId: m.id,
        sender: m.sender_email || m.sender_name || m.sender_id,
        senderId: m.sender_id,
        senderRole: actualSenderRole,
        role: actualSenderRole,
        subject: m.subject || '',
        text: m.content,
        message: m.content,
        timestamp: new Date(m.created_at || Date.now()).getTime(),
        read: !!m.is_read,
        sourceType: 'message',
        is_broadcast: !!m.is_broadcast,
        sentByViewer,
        // Mark if sent by the viewer (admin viewing their own sent messages)
        isAdminSent: role === 'admin' && actualSenderRole === 'admin',
        isUserSent: role === 'user' && actualSenderRole === 'user',
      };
    });

  // Map app_notifications to the unified notification format
  const mapAppNotifications = (rows: any[], role: 'admin' | 'user') =>
    (rows || []).map((n: any) => ({
      id: `appnotif-${n.id}`,
      notificationId: n.id,
      sender: 'system',
      senderId: 'system',
      // System notifications appear as from the opposite role for unread counting
      senderRole: role === 'admin' ? 'user' : 'admin',
      role: role === 'admin' ? 'user' : 'admin',
      subject: n.title || '',
      title: n.title || '',
      text: n.body || '',
      message: n.body || '',
      timestamp: new Date(n.created_at || Date.now()).getTime(),
      read: !!n.is_read,
      sourceType: 'app_notification',
    }));

  const mapSupportItems = async (currentUser: User) => {
    const ticketsRes: any = await getMyTickets({ pageNum: 1, pageSize: 50 });
    if (ticketsRes?.code !== 200 || !Array.isArray(ticketsRes?.result?.rows)) {
      return [];
    }

    const rows = ticketsRes.result.rows;
    if (currentUser.role === 'admin') {
      return rows.map((row: any) => ({
        id: `ticket-${row.id}`,
        sender: row.user_name || 'user',
        senderId: String(row.user_id || row.id),
        senderRole: 'user',
        role: 'user',
        subject: row.subject || '',
        text: row.message || '',
        message: row.message || '',
        timestamp: new Date(row.created_at || row.createdAt || Date.now()).getTime(),
        read: row.status === 'resolved' || row.status === 'closed',
        sourceType: 'support_ticket',
      }));
    }

    let supportNotifications: any[] = [];
    try {
      const res: any = await getSupportNotifications(false);
      if (res?.code === 200 && Array.isArray(res?.result)) {
        supportNotifications = res.result;
      }
    } catch {
      supportNotifications = [];
    }
    const notificationByTicketId = new Map<number, any>();
    for (const row of supportNotifications) {
      const relatedId = Number(row?.related_id);
      if (Number.isFinite(relatedId)) {
        notificationByTicketId.set(relatedId, row);
      }
    }

    return rows
      .filter((row: any) => String(row.admin_reply || '').trim().length > 0)
      .map((row: any) => {
        const notification = notificationByTicketId.get(Number(row.id));
        return {
          id: `ticket-reply-${row.id}`,
          notificationId: notification?.id,
          sender: row.admin_name || 'admin',
          senderId: row.admin_name || 'admin',
          senderRole: 'admin',
          role: 'admin',
          subject: row.subject ? `Re: ${row.subject}` : 'Admin Reply',
          text: row.admin_reply,
          message: row.admin_reply,
          timestamp: new Date(row.replied_at || row.updated_at || row.updatedAt || row.created_at || Date.now()).getTime(),
          read: notification ? !!notification.is_read : true,
          sourceType: 'support_reply',
        };
      });
  };

  const loadNotifications = async (currentUser: User) => {
    const token = getToken();
    const viewerKey = getViewerKey(currentUser);
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    let inboxMapped: any[] = [];
    try {
      const inboxRes = await fetch('/dev-api/api/messages/inbox', { headers });
      const inboxData = await inboxRes.json();
      if (inboxData?.code === 200 && Array.isArray(inboxData?.result?.messages)) {
        const currentUserId = inboxData.result.currentUserId != null ? Number(inboxData.result.currentUserId) : undefined;
        inboxMapped = mapInboxMessages(inboxData.result.messages, currentUser.role, currentUserId);
      }
    } catch (err) {
      console.error('Failed to fetch inbox messages:', err);
    }

    let supportItems: any[] = [];
    try {
      supportItems = await mapSupportItems(currentUser);
    } catch (err) {
      console.error('Failed to fetch support items:', err);
    }

    // Fetch app_notifications (system alerts, file processed, escalation notifications)
    let appNotifsMapped: any[] = [];
    try {
      const appRes = await listAppNotifications(1, 50);
      const appData = appRes as any;
      if (appData?.ok !== false && appData?.data?.rows) {
        appNotifsMapped = mapAppNotifications(appData.data.rows, currentUser.role);
      }
      // Detect role changes: the backend returns the current role on every poll.
      // If it differs from the cached frontend state, update immediately.
      const serverScope = appData?.data?._scope;
      if (serverScope?.roleCode && serverScope.roleCode !== currentUser.roleCode) {
        const isAdmin = ['SUPER_ADMIN', 'HR_ADMIN', 'GA_ADMIN', 'ACC_ADMIN'].includes(serverScope.roleCode);
        setUser((prev) => prev ? {
          ...prev,
          role: isAdmin ? 'admin' : 'user',
          roleCode: serverScope.roleCode,
          departmentCode: serverScope.departmentCode || prev.departmentCode,
        } : prev);
      }
    } catch (err) {
      console.error('Failed to fetch app notifications:', err);
    }

    const combined = applyViewerState(
      composeNotifications(currentUser.role as 'admin' | 'user', inboxMapped, supportItems, appNotifsMapped),
      viewerKey,
    );
    setNotifications(combined);
    setUnreadCount(computeNotificationCount(combined, currentUser.role));
  };

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    const syncNotifications = async () => {
      await loadNotifications(user);
      if (cancelled) return;
    };

    syncNotifications();
    const interval = setInterval(syncNotifications, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user]);

  const handleLogin = (userData: User) => {
    setUser(userData);
    bellMarkedReadRef.current = false;
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setActiveFeature(null);
    setShowProfile(false);
    bellMarkedReadRef.current = false;
    logoutFromMicrosoft();
  };

  // Bell click: only toggles the panel (handled by HomePage).
  // Notifications are marked as read ONLY via the explicit per-item "Mark as Read" button.
  const handleNotificationBellClick = () => {
    // no-op — panel toggle is in HomePage
  };

  const handleFeatureClick = (feature: FeatureType) => {
    if (feature === 'contact-admin') {
      setShowContactAdminModal(true);
      return;
    }
    if (feature === 'message') {
      setShowBroadcastModal(true);
      return;
    }
    setActiveFeature(feature);
    setShowProfile(false);
  };

  const handleProfileClick = () => {
    setShowProfile(true);
    setActiveFeature(null);
  };

  const handleMarkAsRead = async (item: any) => {
    if (!item || !item.id) return;

    const viewerKey = getViewerKey(user);
    const localId = item?.id ? String(item.id) : undefined;
    const nextNotifications = notifications.map((n) => (n.id === item.id ? { ...n, read: true } : n));

    setNotifications(nextNotifications);
    if (user) {
      setUnreadCount(computeNotificationCount(nextNotifications, user.role));
    }

    addReadId(item.notificationId, item.messageId, localId, viewerKey);

    // Mark as read on the backend via the appropriate API
    if (item.messageId && item.sourceType === 'message') {
      const token = getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      fetch(`/dev-api/api/messages/mark-read/${item.messageId}`, {
        method: 'PUT',
        headers,
      }).catch((err) => {
        console.error('Failed to mark message as read:', err);
      });
      return;
    }

    if (item.sourceType === 'support_reply' && typeof item.notificationId === 'number') {
      markSupportNotificationRead(item.notificationId).catch((err) => {
        console.error('Failed to mark support notification as read:', err);
      });
      return;
    }

    // App notifications (system alerts, etc.)
    if (item.id?.startsWith?.('appnotif-') && typeof item.notificationId === 'number') {
      markAppNotificationRead(item.notificationId).catch((err) => {
        console.error('Failed to mark app notification as read:', err);
      });
    }
  };

  const handleContactAdminSubmit = async (data: { subject: string; message: string }) => {
    setIsSubmitting(true);
    try {
      if (user?.role === 'user') {
        try {
          await createSupportTicket({ subject: data.subject || t('broadcast.subjectPlaceholder'), message: data.message });
        } catch (apiError) {
          console.error('API error:', apiError);
        }
      }

      setShowContactAdminModal(false);
    } catch (error) {
      console.error('Error sending message:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // handleSendToAll is now handled entirely by BroadcastModal which calls the API directly.
  // This callback is kept for backward compatibility with HomePage props.
  const handleSendToAll = async (_message: string) => {
    // BroadcastModal handles the actual API call via /api/messages/broadcast.
    // Trigger a refresh so the new broadcast appears in notifications.
    if (user) {
      await loadNotifications(user);
    }
  };

  const handleClosePopup = () => {
    setActiveFeature(null);
    setShowProfile(false);
  };

  const getPopupTitle = (): string => {
    if (showProfile) return t('profile.title');
    switch (activeFeature) {
      case 'chat':
        return t('chat.title');
      case 'documents':
        return t('documentTable.title');
      case 'history':
        return t('history.title');
      case 'notifications':
        return t('home.notifications');
      case 'admin':
        return t('admin.title');
      default:
        return '';
    }
  };

  const getPopupContent = () => {
    if (showProfile && user) {
      return <ProfilePopup user={user} onLogout={handleLogout} />;
    }

    switch (activeFeature) {
      case 'chat':
        return <ChatInterface />;
      case 'history':
        return <HistoryPage user={user || undefined} />;
      case 'notifications':
        return <Messenger user={user} />;
      case 'admin':
        return <AdminDashboard user={user || undefined} />;
      default:
        return null;
    }
  };

  if (!user) {
    return (
      <ToastProvider>
        <SystemHealthMonitor />
        <LoginPage onLogin={handleLogin} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <SystemHealthMonitor />
      <HomePage
        user={user}
        onFeatureClick={handleFeatureClick}
        onProfileClick={handleProfileClick}
        notifications={notifications}
        onMarkAsRead={handleMarkAsRead}
        unreadCount={unreadCount}
        onSendToAll={handleSendToAll}
        onNotificationBellClick={handleNotificationBellClick}
      />

      <ContactAdminPopup
        isOpen={showContactAdminModal}
        onClose={() => setShowContactAdminModal(false)}
        onSend={handleContactAdminSubmit}
        isSubmitting={isSubmitting}
      />

      <BroadcastModal
        isOpen={showBroadcastModal}
        onClose={() => setShowBroadcastModal(false)}
      />

      <Popup
        isOpen={activeFeature !== null || showProfile}
        onClose={handleClosePopup}
        title={getPopupTitle()}
        maxWidth={activeFeature === 'admin' ? 'max-w-6xl' : 'max-w-4xl'}
      >
        {getPopupContent()}
      </Popup>
    </ToastProvider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AppContent />
      </LanguageProvider>
    </ThemeProvider>
  );
}

export default App;
