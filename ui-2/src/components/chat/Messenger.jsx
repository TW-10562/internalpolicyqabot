import { useState, useEffect } from 'react';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import { getMyTickets, createSupportTicket, replyToTicket } from '../../api/support';
import { CheckCircle, X } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { formatDateJP, formatDateTimeJP, formatTimeJP } from '../../lib/dateTime';
 
export default function Messenger({ user, onUnreadCountChange, onNotificationsChange })  {
  const { t, lang } = useLang();
  const [messages, setMessages] = useState([]);
  const [supportTickets, setSupportTickets] = useState([]);
  const [loadingTickets, setLoadingTickets] = useState(false);
  const [showSuccessPopup, setShowSuccessPopup] = useState(false);
  const [successMessage, setSuccessMessage] = useState(t('contactAdmin.messageSent'));
  const [adminTickets, setAdminTickets] = useState([]);
  const [replyForTicket, setReplyForTicket] = useState({}); // { [ticketId]: replyText }

  const safeDate = (item) => {
    if (!item) return null;
    if (item.timestamp) return new Date(item.timestamp);
    if (item.createdAt) return new Date(item.createdAt);
    if (item.created_at) return new Date(item.created_at);
    if (item.date && item.time) return new Date(`${item.date} ${item.time}`);
    if (item.date) return new Date(item.date);
    return null;
  };

  const prettyTime = (item) => {
    const d = safeDate(item);
    if (!d || isNaN(d.getTime())) return '';
    return formatTimeJP(d);
  };
 
  // Load messages from localStorage on mount AND sync with parent
  useEffect(() => {
    loadMessagesFromStorage();
    if (user?.role === 'admin') {
      loadAllTicketsForAdmin();
    } else {
      loadSupportTickets();
    }
  }, []);
 
  // Whenever messages change, notify parent and update unread count
  useEffect(() => {
    const filteredNotifications = messages.filter((m) => {
      if (user?.role === 'admin') return m.senderRole === 'user';
      return m.senderRole === 'admin';
    });
    const unreadCount = filteredNotifications.filter(m => !m.read).length;
   
    // Call parent callbacks
    if (onUnreadCountChange) {
      onUnreadCountChange(unreadCount);
    }
    if (onNotificationsChange) {
      onNotificationsChange(filteredNotifications);
    }
  }, [messages, user, onUnreadCountChange, onNotificationsChange]);
 
  // Load messages from localStorage
  const loadMessagesFromStorage = () => {
    const storedMessages = localStorage.getItem('notifications_messages');
    if (storedMessages) {
      try {
        const parsed = JSON.parse(storedMessages);
        console.log('Loaded messages from storage:', parsed);
        setMessages(parsed);
      } catch (e) {
        console.error('Error loading messages:', e);
      }
    }
  };
 
  // Fetch last 3 support tickets (questions asked to admin) from database
  const loadSupportTickets = async () => {
    setLoadingTickets(true);
    try {
      const response = await getMyTickets({ pageNum: 1, pageSize: 3 });
      if (response.code === 200 && response.result?.rows) {
        // Transform database rows into ticket objects
        const tickets = response.result.rows.map((row) => {
          return {
            id: row.id,
            question: row.subject || row.title || row.message || '',
            message: row.message || row.description || '',
            timestamp: new Date(row.createdAt || row.created_at || row.timestamp),
            status: row.status || 'PENDING',
          };
        });
        setSupportTickets(tickets);
      } else {
        setSupportTickets([]);
      }
    } catch (error) {
      console.error('Error loading support tickets:', error);
      setSupportTickets([]);
    } finally {
      setLoadingTickets(false);
    }
  };

  // Admin: load latest tickets across users
  const loadAllTicketsForAdmin = async () => {
    setLoadingTickets(true);
    try {
      const response = await getMyTickets({ pageNum: 1, pageSize: 20 });
      if (response.code === 200 && response.result?.rows) {
        setAdminTickets(response.result.rows);
      } else {
        setAdminTickets([]);
      }
    } catch (error) {
      console.error('Error loading admin tickets:', error);
      setAdminTickets([]);
    } finally {
      setLoadingTickets(false);
    }
  };
 
  const sendMessage = ({ subject, message }) => {
    console.log('sendMessage called:', { subject, message, userRole: user?.role });
    const now = new Date();
    const msg = {
      id: Date.now().toString(),
      sender: user.name || t('user.role.user'),
      senderId: user?.role === 'admin' ? 'admin' : user?.employeeId || 'user',
      senderRole: user.role,
      role: user.role,
      subject: subject || '',
      text: message || '',
      message: message || '',
      time: formatTimeJP(now),
      date: formatDateJP(now),
      timestamp: now.getTime(),
      read: user?.role === 'admin' ? true : false,
    };
   
    const updatedMessages = [...messages, msg];
    console.log('Updated messages:', updatedMessages);
    setMessages(updatedMessages);
   
    // Store in localStorage immediately
    localStorage.setItem('notifications_messages', JSON.stringify(updatedMessages));
    console.log('Saved to localStorage');
   
    // Show success popup
    setSuccessMessage(t('contactAdmin.messageSent'));
    setShowSuccessPopup(true);
    setTimeout(() => setShowSuccessPopup(false), 3000);
   
    // Try to create support ticket in backend (for users)
    if (user.role === 'user' && (subject || message)) {
      createSupportTicket({ subject: subject || t('broadcast.subjectPlaceholder'), message })
        .then((response) => {
          console.log('Support ticket created:', response);
          loadSupportTickets();
        })
        .catch(err => {
          console.error('Failed to create support ticket:', err);
        });
    }
  };
 
  // Mark message as read - find the message in the full array
  const markAsRead = (messageToMark) => {
    console.log('markAsRead called:', messageToMark);
    const updatedMessages = messages.map((m) =>
      m.id === messageToMark.id ? { ...m, read: true } : m
    );
    setMessages(updatedMessages);
    localStorage.setItem('notifications_messages', JSON.stringify(updatedMessages));
    console.log('Message marked as read');
  };
 
  const notifications = messages.filter((m) => {
    if (user?.role === 'admin') return m.senderRole === 'user';
    return m.senderRole === 'admin';
  });
 
  const unreadCount = notifications.filter(m => !m.read).length;
 
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      backgroundColor: '#1a1a2e',
      color: '#fff'
    }}>
      {/* Header */}
      <div style={{
        padding: '20px 24px',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(0,0,0,0.2)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: '0 0 4px 0', fontSize: '24px', fontWeight: '700' }}>
              {user?.role === 'admin' ? t('messenger.userQuestions') : t('messenger.adminMessages')}
            </h2>
            <p style={{ margin: 0, fontSize: '13px', color: '#999' }}>
              {t('messenger.messageCount', { count: notifications.length })}
              {unreadCount > 0 && ` • ${t('messenger.unreadCount', { count: unreadCount })}`}
            </p>
          </div>
          {unreadCount > 0 && (
            <span style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '32px',
              height: '32px',
              backgroundColor: '#ef4444',
              color: '#fff',
              borderRadius: '50%',
              fontSize: '14px',
              fontWeight: 'bold'
            }}>
              {unreadCount}
            </span>
          )}
        </div>
      </div>
 
      {/* Messages List (User sees admin messages; Admin sees user tickets with reply) */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}>
        {user?.role === 'admin' ? (
          adminTickets.length === 0 ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#666',
              fontSize: '16px'
            }}>
              {t('messenger.noUserQuestions')}
            </div>
          ) : (
            adminTickets.map((ticket) => (
              <div
                key={ticket.id}
                style={{ padding: '8px' }}
              >
                <div style={{
                  padding: '16px',
                  borderRadius: '12px',
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  transition: 'all 0.3s ease',
                  position: 'relative'
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                  <div>
                    <h4 style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: '600', color: '#fff' }}>
                      {ticket.user_name || t('user.role.user')}
                    </h4>
                    <p style={{ margin: 0, fontSize: '12px', color: '#999' }}>
                      {formatDateTimeJP(ticket.created_at || ticket.createdAt || ticket.timestamp)}
                    </p>
                  </div>
                </div>

                {ticket.subject && (
                  <h5 style={{ margin: '8px 0', fontSize: '14px', fontWeight: '600', color: '#3b82f6' }}>
                    {ticket.subject}
                  </h5>
                )}

                <p style={{ margin: '8px 0 12px 0', fontSize: '14px', color: '#e2e8f0', lineHeight: '1.5', wordBreak: 'break-word' }}>
                  {ticket.message}
                </p>

                {/* Admin reply box */}
                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                  <input
                    value={replyForTicket[ticket.id] || ''}
                    onChange={(e) => setReplyForTicket(prev => ({ ...prev, [ticket.id]: e.target.value }))}
                    placeholder={t('messenger.replyPlaceholder')}
                    style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.2)', color: '#fff' }}
                  />
                  <button
                    onClick={async () => {
                      const reply = (replyForTicket[ticket.id] || '').trim();
                      if (!reply) { alert(t('messenger.enterReply')); return; }
                      try {
                        await replyToTicket(ticket.id, { reply, status: 'resolved' });
                        setSuccessMessage(t('messenger.replySent'));
                        setShowSuccessPopup(true);
                        setTimeout(() => setShowSuccessPopup(false), 2500);

                        // Optionally append to local messages so user-side list updates
                        const now = new Date();
                        const adminMsg = {
                          id: `${ticket.id}-${now.getTime()}`,
                          sender: t('activity.admin'),
                          senderId: 'admin',
                          senderRole: 'admin',
                          role: 'admin',
                          subject: `Re: ${ticket.subject || t('messenger.userQuery')}`,
                          text: reply,
                          message: reply,
                          time: formatTimeJP(now),
                          date: formatDateJP(now),
                          timestamp: now.getTime(),
                          read: true,
                        };
                        const stored = localStorage.getItem('notifications_messages');
                        const all = stored ? JSON.parse(stored) : [];
                        all.push(adminMsg);
                        localStorage.setItem('notifications_messages', JSON.stringify(all));
                        // Clear the input and refresh tickets list
                        setReplyForTicket(prev => ({ ...prev, [ticket.id]: '' }));
                        await loadAllTicketsForAdmin();
                      } catch (e) {
                        console.error('Failed to send reply:', e);
                        alert(t('messenger.replyFailed'));
                      }
                    }}
                    style={{ padding: '8px 14px', backgroundColor: '#10b981', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}
                  >
                    {t('chat.send')}
                  </button>
                </div>
                </div>
                </div>
            ))
          )
        ) : notifications.length === 0 ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#666',
            fontSize: '16px'
          }}>
            {t('messageList.noMessages')}
          </div>
        ) : (
          notifications.map((msg, idx) => (
            <div key={msg.id || idx} style={{ padding: '8px' }}>
              <div
                style={{
                  padding: '16px',
                  borderRadius: '12px',
                  backgroundColor: !msg.read ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                  border: !msg.read ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid rgba(255, 255, 255, 0.1)',
                  transition: 'all 0.3s ease',
                  position: 'relative'
                }}
              >
              {/* Message Header */}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '10px'
              }}>
                <div>
                  <h4 style={{
                    margin: '0 0 4px 0',
                    fontSize: '15px',
                    fontWeight: '600',
                    color: '#fff'
                  }}>
                    {msg.sender || t('messenger.unknownSender')}
                  </h4>
                  <p style={{ margin: 0, fontSize: '12px', color: '#999' }}>
                    {prettyTime(msg)}
                  </p>
                </div>
                {!msg.read && (
                  <span style={{
                    width: '10px',
                    height: '10px',
                    backgroundColor: '#ef4444',
                    borderRadius: '50%',
                    flexShrink: 0,
                    marginTop: '4px'
                  }} />
                )}
              </div>
 
              {/* Subject */}
              {msg.subject && (
                <h5 style={{
                  margin: '8px 0',
                  fontSize: '14px',
                  fontWeight: '600',
                  color: '#3b82f6'
                }}>
                  {msg.subject}
                </h5>
              )}
 
              {/* Message Content */}
              <p style={{
                margin: '8px 0 12px 0',
                fontSize: '14px',
                color: '#e2e8f0',
                lineHeight: '1.5',
                wordBreak: 'break-word'
              }}>
                {msg.text || msg.message}
              </p>
 
              {/* Mark as Read Button */}
              {!msg.read && (
                <button
                  onClick={() => markAsRead(msg)}
                  style={{
                    padding: '8px 14px',
                    backgroundColor: '#3b82f6',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: '500',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.target.style.backgroundColor = '#2563eb';
                    e.target.style.transform = 'translateY(-1px)';
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.backgroundColor = '#3b82f6';
                    e.target.style.transform = 'translateY(0)';
                  }}
                >
                  {t('messageList.markAsRead')}
                </button>
              )}
            </div>
            </div>
          ))
        )}
      </div>
 
      {/* Message Input (for admin removed; replies are per-ticket above) */}
 
      {/* Success Popup */}
      {showSuccessPopup && (
        <div style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none'
        }}>
          <div style={{
            backgroundColor: '#10b981',
            color: 'white',
            padding: '20px 28px',
            borderRadius: '10px',
            boxShadow: '0 20px 45px rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            fontSize: '16px',
            fontWeight: '500',
            animation: 'popupSlideIn 0.3s ease-out, popupSlideOut 0.3s ease-out 2.7s forwards',
            pointerEvents: 'auto'
          }}>
            <CheckCircle size={20} />
            <span>{successMessage}</span>
          </div>
        </div>
      )}
 
      <style>{`
        @keyframes popupSlideIn {
          from {
            opacity: 0;
            transform: translateY(-20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes popupSlideOut {
          from {
            opacity: 1;
            transform: translateY(0);
          }
          to {
            opacity: 0;
            transform: translateY(-20px);
          }
        }
      `}</style>
    </div>
  );
}
 
 
 
