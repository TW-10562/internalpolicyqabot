import { useState, useEffect } from 'react';
import { ToastProvider } from './context/ToastContext';
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
import { getToken } from './api/auth';
 
 
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
  const [notificationBellClicked, setNotificationBellClicked] = useState(false);

  // FRESH notification count logic - completely independent from old logic
  const computeNotificationCount = (messagesList: any[], userRole: string): number => {
    if (!Array.isArray(messagesList) || notificationBellClicked) return 0;
    return messagesList.filter((msg: any) => {
      if (userRole === 'admin') return msg.senderRole === 'user' && !msg.read;
      return msg.senderRole === 'admin' && !msg.read;
    }).length;
  };

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
  const hideNotificationItems = (items: any[], viewerKey: string) => {
    const { n, m, l } = getHiddenSets(viewerKey);
    const keys = getHiddenStorageKeys(viewerKey);
    let changedN = false;
    let changedM = false;
    let changedL = false;

    for (const item of items || []) {
      if (!item) continue;
      if (typeof item.notificationId === 'number') {
        n.add(item.notificationId);
        changedN = true;
      } else if (typeof item.messageId === 'number') {
        m.add(item.messageId);
        changedM = true;
      } else if (item.id) {
        l.add(String(item.id));
        changedL = true;
      }
    }

    if (changedN) localStorage.setItem(keys.notification, JSON.stringify(Array.from(n)));
    if (changedM) localStorage.setItem(keys.message, JSON.stringify(Array.from(m)));
    if (changedL) localStorage.setItem(keys.local, JSON.stringify(Array.from(l)));
  };
  const applyViewerState = (arr: any[], viewerKey: string) => {
    if (!Array.isArray(arr)) return [];
    const { n, m, l } = getReadSets(viewerKey);
    const hidden = getHiddenSets(viewerKey);
    return arr.flatMap((it) => {
      if (!it) return [];
      const localId = it?.id ? String(it.id) : '';
      const isHidden = (it?.notificationId != null && hidden.n.has(it.notificationId))
        || (it?.messageId != null && hidden.m.has(it.messageId))
        || (localId && hidden.l.has(localId));
      if (isHidden) return [];

      const isRead = (it?.notificationId != null && n.has(it.notificationId))
        || (it?.messageId != null && m.has(it.messageId))
        || (localId && l.has(localId));
      return [{ ...it, read: isRead || !!it.read }];
    });
  };
  // Compose role-specific notification list consistently
  const composeNotifications = (
    role: 'admin' | 'user',
    inbox: any[] = [],
    supportItems: any[] = [],
  ) => {
    const messageMap = new Map<string, any>();

    if (role === 'admin') {
      const allMessages = [
        ...inbox.filter((msg) => msg.senderRole === 'user' && msg.sourceType === 'message'),
        ...supportItems.filter((msg) => msg.senderRole === 'user' && msg.sourceType === 'support_ticket'),
      ];
      for (const msg of allMessages) {
        if (msg && msg.id) {
          messageMap.set(msg.id, { ...msg });
        }
      }
    } else {
      const allMessages = [
        ...inbox.filter((msg) => msg.senderRole === 'admin' && msg.sourceType === 'message'),
        ...supportItems.filter((msg) => msg.senderRole === 'admin' && msg.sourceType === 'support_reply'),
      ];
      for (const msg of allMessages) {
        if (msg && msg.id) {
          messageMap.set(msg.id, { ...msg });
        }
      }
    }

    const result = Array.from(messageMap.values());
    result.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return result;
  };

  const mapInboxMessages = (rows: any[], role: 'admin' | 'user') =>
    (rows || []).map((m: any) => ({
      id: `msg-${m.id}`,
      messageId: m.id,
      sender: m.sender_id,
      senderId: m.sender_id,
      senderRole: role === 'admin' ? 'user' : 'admin',
      role: role === 'admin' ? 'user' : 'admin',
      subject: m.subject || '',
      text: m.content,
      message: m.content,
      timestamp: new Date(m.created_at || Date.now()).getTime(),
      read: !!m.is_read,
      sourceType: 'message',
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
        inboxMapped = mapInboxMessages(inboxData.result.messages, currentUser.role);
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

    const combined = applyViewerState(
      composeNotifications(currentUser.role as 'admin' | 'user', inboxMapped, supportItems),
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
    const interval = setInterval(syncNotifications, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user]);
 
  const handleLogin = (userData: User) => {
    setUser(userData);
  };
 
  const handleLogout = () => {
    setUser(null);
    setActiveFeature(null);
    setShowProfile(false);
  };

  const handleNotificationBellClick = () => {
    setNotificationBellClicked(true);
    setUnreadCount(0);
    setTimeout(() => setNotificationBellClicked(false), 50);
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

    if (item.messageId) {
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
 
  const handleSendToAll = async (message: string) => {
    try {
      console.log('Broadcasting to all users:', message);
      alert(t('broadcast.success'));
    } catch (error) {
      console.error('Error broadcasting:', error);
      alert(t('broadcast.deleteError'));
    }
  };
 
  const handleClosePopup = () => {
    setActiveFeature(null);
    setShowProfile(false);
  };

  const handleClearNotifications = (itemsToClear: any[]) => {
    if (!user || user.role !== 'user' || !Array.isArray(itemsToClear) || itemsToClear.length === 0) return;

    const viewerKey = getViewerKey(user);
    const idsToClear = new Set(itemsToClear.map((item) => String(item?.id || '')));
    hideNotificationItems(itemsToClear, viewerKey);

    const filtered = notifications.filter((item) => !idsToClear.has(String(item?.id || '')));
    setNotifications(filtered);
    setUnreadCount(computeNotificationCount(filtered, user.role));
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
        <LoginPage onLogin={handleLogin} />
      </ToastProvider>

    );
  }
 
  return (
    <ToastProvider>
      <HomePage
        user={user}
        onFeatureClick={handleFeatureClick}
        onProfileClick={handleProfileClick}
        notifications={notifications}
        onMarkAsRead={handleMarkAsRead}
        unreadCount={unreadCount}
        onSendToAll={handleSendToAll}
        onNotificationBellClick={handleNotificationBellClick}
        onClearNotifications={handleClearNotifications}
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
 
 
