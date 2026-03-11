import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Mail, MailOpen, Send } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';

interface NotificationItem {
  id: string;
  subject?: string;
  title?: string;
  message?: string;
  text?: string;
  timestamp?: number | string | Date;
  read?: boolean;
  is_broadcast?: boolean;
  notificationId?: number;
  messageId?: number;
  senderRole?: 'admin' | 'user';
  role?: 'admin' | 'user';
  sourceType?: 'message' | 'support_reply' | 'support_ticket';
  senderId?: string;
  currentViewerId?: string;

  /** IMPORTANT FLAGS - Used to determine if message was sent by viewer */
  isAdminSent?: boolean;
  isUserSent?: boolean;
}

interface NotificationsPanelProps {
  items: NotificationItem[];
  searchTerm?: string;
  onMarkAsRead?: (item: NotificationItem) => void;
  onClearAll?: (items: NotificationItem[]) => void;
  dimmed?: boolean;
  onSearchChange?: (value: string) => void;
  currentViewerId?: string;
  currentViewerRole?: 'admin' | 'user';
}

/* ===================== LOCAL STORAGE HELPERS ===================== */

const getReadStorageKeys = (viewerKey: string) => ({
  notification: `read_notification_ids_${viewerKey}`,
  message: `read_message_ids_${viewerKey}`,
  local: `read_local_notification_ids_${viewerKey}`,
});

const getReadIdsFromStorage = (viewerKey: string) => {
  try {
    const keys = getReadStorageKeys(viewerKey);
    return {
      notificationIds: new Set<number>(
        JSON.parse(localStorage.getItem(keys.notification) || '[]')
      ),
      messageIds: new Set<number>(
        JSON.parse(localStorage.getItem(keys.message) || '[]')
      ),
      localIds: new Set<string>(
        JSON.parse(localStorage.getItem(keys.local) || '[]')
      ),
    };
  } catch {
    return { notificationIds: new Set(), messageIds: new Set(), localIds: new Set() };
  }
};

const addReadIdToStorage = (notificationId: number | undefined, messageId: number | undefined, localId: string | undefined, viewerKey: string) => {
  const { notificationIds, messageIds, localIds } = getReadIdsFromStorage(viewerKey);
  const keys = getReadStorageKeys(viewerKey);
  if (notificationId != null) {
    notificationIds.add(notificationId);
    localStorage.setItem(
      keys.notification,
      JSON.stringify([...notificationIds])
    );
  }
  if (messageId != null) {
    messageIds.add(messageId);
    localStorage.setItem(
      keys.message,
      JSON.stringify([...messageIds])
    );
  }
  if (localId) {
    localIds.add(localId);
    localStorage.setItem(
      keys.local,
      JSON.stringify([...localIds])
    );
  }
};

const isItemReadInStorage = (item: NotificationItem, viewerKey: string) => {
  const { notificationIds, messageIds, localIds } = getReadIdsFromStorage(viewerKey);
  return (
    (item.notificationId != null &&
      notificationIds.has(item.notificationId)) ||
    (item.messageId != null && messageIds.has(item.messageId)) ||
    localIds.has(String(item.id || ''))
  );
};

/* ===================== COMPONENT ===================== */

export default function NotificationsPanel({
  items,
  searchTerm = '',
  onMarkAsRead,
  onClearAll,
  dimmed = false,
  onSearchChange,
  currentViewerId,
  currentViewerRole = 'user',
}: NotificationsPanelProps) {
  const { t } = useLang();
  const viewerKey = currentViewerId || 'anonymous';
  const containerRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [localItems, setLocalItems] = useState<NotificationItem[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);

  const formatTimestamp = (value?: number | string | Date) => {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString();
  };

  /* ---------- INIT ---------- */
  useEffect(() => {
    const map = new Map<string, NotificationItem>();
    for (const it of items || []) {
      if (!it?.id) continue;
      const read = isItemReadInStorage(it, viewerKey) || it.read;
      map.set(it.id, { ...it, read });
    }
    setLocalItems([...map.values()]);
    setIsInitialized(true);
  }, [items, viewerKey]);

  /* ---------- FILTER ---------- */
  const filtered = useMemo(() => {
    const q = searchTerm.toLowerCase();
    return [...localItems]
      .sort(
        (a, b) =>
          new Date(b.timestamp || 0).getTime() -
          new Date(a.timestamp || 0).getTime()
      )
      .filter(
        (n) =>
          !q ||
          (n.subject || n.title || '')
            .toLowerCase()
            .includes(q) ||
          (n.message || n.text || '').toLowerCase().includes(q)
      );
  }, [localItems, searchTerm]);
  const visibleItems = useMemo(() => {
    return filtered.filter((item) => {
      const senderRole = String(item.senderRole || item.role || '').toLowerCase();
      if (currentViewerRole === 'admin') {
        return senderRole === 'user' && (item.messageId != null || item.sourceType === 'support_ticket');
      }
      return senderRole === 'admin' && (item.messageId != null || item.sourceType === 'support_reply');
    });
  }, [filtered, currentViewerRole]);
  const canClearAll = currentViewerRole === 'user' && visibleItems.length > 0 && typeof onClearAll === 'function';

  /* ===================== RENDER ===================== */

  return (
    <aside
      className={`h-full w-full bg-white dark:bg-dark-surface flex flex-col overflow-hidden transition-colors ${
        dimmed ? 'opacity-60' : 'opacity-100'
      }`}
    >
      {/* HEADER */}
      <div className="p-4 border-b border-[#E8E8E8] dark:border-dark-border dark:bg-dark-bg-primary flex items-center gap-3 flex-shrink-0 transition-colors">
        <div className="p-2 bg-[#F0F4FF] dark:bg-blue-900/30 rounded-lg transition-colors">
          <Bell className="w-4 h-4 text-[#1d2089] dark:text-[#60a5fa] flex-shrink-0 transition-colors" />
        </div>
        <h3 className="text-sm font-semibold text-[#232333] dark:text-dark-text flex-1 truncate transition-colors">
          {t('notificationsPanel.title')}
        </h3>
        <div className="flex items-center gap-2 flex-shrink-0">
          {canClearAll && (
            <button
              type="button"
              onClick={() => {
                const idsToClear = new Set(visibleItems.map((item) => item.id));
                onClearAll?.(visibleItems);
                setExpandedId(null);
                setLocalItems((prev) => prev.filter((item) => !idsToClear.has(item.id)));
              }}
              className="text-xs px-3 py-1.5 rounded-lg border border-[#D4DAFF] text-[#1d2089] bg-[#F8FAFF] hover:bg-[#EEF3FF] transition-colors"
            >
              {t('notificationsPanel.clearAll')}
            </button>
          )}
          {onSearchChange && (
            <input
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={t('notificationsPanel.searchPlaceholder')}
              className="bg-[#F6F6F6] dark:bg-dark-border text-xs text-[#232333] dark:text-dark-text px-3 py-1.5 rounded-lg border border-[#E8E8E8] dark:border-dark-border flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-[#1d2089] dark:focus:ring-[#60a5fa] transition-colors"
            />
          )}
        </div>
      </div>

      {/* MESSAGE LIST - Only vertical scrolling */}
      <div 
        ref={containerRef} 
        className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-2 w-full"
        style={{ overscrollBehavior: 'contain' }}
      >
        {!isInitialized ? (
          <p className="text-[#6E7680] text-center text-xs">
            {t('notificationsPanel.loading')}
          </p>
        ) : visibleItems.length === 0 ? (
          <p className="text-[#6E7680] text-center text-xs">
            {searchTerm ? t('notificationsPanel.noResults') : t('notificationsPanel.noNotifications')}
          </p>
        ) : (
          visibleItems.map((message) => {
            const messageRead = message.read === true;

            /* ===================== VIEWER PERSPECTIVE COMPUTATION ===================== */
            // Step 1: Determine if message was sent by current viewer
            // Use senderId comparison. For admins, their ID might be 'admin' or their employeeId
            let isSentByViewer = false;
            
            if (currentViewerId && message.senderId) {
              // Direct ID comparison
              isSentByViewer = message.senderId === currentViewerId;
              // For admins: if senderId is 'admin' and viewer is admin, it's sent by viewer
              if (!isSentByViewer && currentViewerRole === 'admin' && message.senderId === 'admin') {
                isSentByViewer = true;
              }
            }

            // Step 2: If not sent by viewer, it was received
            const isReceivedByViewer = !isSentByViewer;

            // Step 3: A message is "new" if it was received and not yet read
            const isNew = isReceivedByViewer && !messageRead;

            /* ===================== DETERMINE UI STATE ===================== */
            let borderColor = 'border-[#E8E8E8]';
            let bgColor = 'bg-[#F6F6F6]';
            let textColor = 'text-[#6E7680]';
            let badgeColor = '';
            let badgeText = '';
            let icon = null;
            let showMarkAsReadBtn = false;

            if (isSentByViewer) {
              // SENT MESSAGE: Green accent
              borderColor = 'border-green-200';
              bgColor = 'bg-green-50';
              textColor = 'text-green-700';
              icon = <Send className="w-4 h-4 text-green-600 flex-shrink-0" />;
              badgeColor = '';
              badgeText = '';
            } else if (isNew) {
              // NEW MESSAGE: Blue accent
              borderColor = 'border-[#1d2089]/30';
              bgColor = 'bg-[#F0F4FF]';
              textColor = 'text-[#1d2089]';
              icon = <Mail className="w-4 h-4 text-[#1d2089] flex-shrink-0" />;
              badgeColor = 'bg-[#1d2089] text-white';
              badgeText = t('notificationsPanel.new');
              showMarkAsReadBtn = true;
            } else if (isReceivedByViewer && messageRead) {
              // READ MESSAGE: Gray
              borderColor = 'border-[#E8E8E8]';
              bgColor = 'bg-[#F6F6F6]';
              textColor = 'text-[#6E7680]';
              icon = <MailOpen className="w-4 h-4 text-[#9CA3AF] flex-shrink-0" />;
            }

            const isExpanded = expandedId === message.id;
            const messageText = message.message || message.text || '';
            const messageTitle = message.subject || message.title || t('notificationsPanel.noTitle') || 'Untitled';
            const timeText = formatTimestamp(message.timestamp);
            const directionText = isSentByViewer
              ? (t('notificationsPanel.sent') || 'Sent')
              : (t('notificationsPanel.received') || 'Received');

            const handleMarkAsRead = () => {
              addReadIdToStorage(message.notificationId, message.messageId, String(message.id), viewerKey);
              setLocalItems((prev) =>
                prev.map((item) =>
                  item.id === message.id ? { ...item, read: true } : item
                )
              );
              onMarkAsRead?.(message);
            };

            const handleToggleExpand = () => {
              setExpandedId(isExpanded ? null : message.id);
            };

            return (
              <div
                key={message.id}
                className={`border rounded-lg p-3 transition-all overflow-hidden w-full ${borderColor} ${bgColor}`}
              >
                {/* HEADER - For SENT messages: Icon + Title on same line (no badge) */}
                {isSentByViewer && (
                  <div className="flex gap-2 items-center mb-2 w-full min-w-0">
                    {icon}
                    <h4 
                      className={`text-sm font-semibold ${textColor} cursor-pointer truncate`}
                      onClick={handleToggleExpand}
                      title={messageTitle}
                    >
                      {messageTitle}
                    </h4>
                  </div>
                )}

                {/* HEADER - For READ messages: Icon + Title on same line */}
                {!isSentByViewer && isReceivedByViewer && messageRead && (
                  <div className="flex gap-2 items-center mb-2 w-full min-w-0">
                    {icon}
                    <h4 
                      className={`text-sm font-semibold ${textColor} cursor-pointer truncate`}
                      onClick={handleToggleExpand}
                      title={messageTitle}
                    >
                      {messageTitle}
                    </h4>
                  </div>
                )}

                {/* HEADER - For NEW messages: Icon on top, Title and badges below */}
                {isNew && (
                  <div className="flex gap-2 items-start mb-2 w-full">
                    {icon}
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                      {/* NEW Badge and Mark as Read Button */}
                      <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
                        {badgeText && (
                          <span className={`text-[10px] px-2 py-1 rounded whitespace-nowrap flex-shrink-0 ${badgeColor}`}>
                            {badgeText}
                          </span>
                        )}
                        {showMarkAsReadBtn && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMarkAsRead();
                            }}
                            className="text-[10px] text-white bg-[#1d2089] hover:bg-[#0E4BD9] px-2 py-1 rounded-md whitespace-nowrap flex-shrink-0 transition-colors"
                          >
                            {t('notificationsPanel.markAsRead')}
                          </button>
                        )}
                      </div>

                      {/* Title - Truncated when collapsed, wrapped when expanded */}
                      <h4 
                        className={`text-sm font-semibold ${textColor} cursor-pointer ${!isExpanded ? 'truncate' : 'break-words whitespace-normal'}`}
                        onClick={handleToggleExpand}
                        title={messageTitle}
                      >
                        {messageTitle}
                      </h4>
                    </div>
                  </div>
                )}

                {/* CONTENT AREA - Collapsible */}
                {timeText && (
                  <p className="ml-6 mb-2 text-[10px] text-[#9CA3AF]">
                    {directionText}: {timeText}
                  </p>
                )}

                {!isExpanded ? (
                  // COLLAPSED VIEW: Show preview
                  <div 
                    className="cursor-pointer text-xs text-[#6E7680] space-y-1 ml-6"
                    onClick={handleToggleExpand}
                  >
                    <p className="line-clamp-2 break-words">
                      {messageText || t('notificationsPanel.noContent') || 'No content'}
                    </p>
                    <p className="text-[10px] text-[#9CA3AF] italic">
                      {t('notificationsPanel.clickToExpand') || 'Click to expand'}
                    </p>
                  </div>
                ) : (
                  // EXPANDED VIEW: Show full content
                  <div 
                    className="mt-2 pt-2 border-t border-[#E8E8E8] ml-6 space-y-2"
                    onClick={handleToggleExpand}
                  >
                    <p 
                      className="text-xs whitespace-pre-wrap break-words overflow-hidden w-full text-[#232333]"
                      style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}
                    >
                      <span>{messageText}</span>
                    </p>
                    
                    {/* Click to collapse hint - bottom right */}
                    <p className="text-[10px] text-[#9CA3AF] text-right italic cursor-pointer hover:text-[#6E7680]">
                      {t('notificationsPanel.clickToCollapse') || 'Click to collapse'}
                    </p>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
