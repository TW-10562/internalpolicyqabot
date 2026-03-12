import { useState } from 'react';
import { X, Send, CheckCircle, Users } from 'lucide-react';
import { getToken } from '../../api/auth';
import { useLang } from '../../context/LanguageContext';
import { formatDateJP, formatTimeJP } from '../../lib/dateTime';

interface BroadcastModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function BroadcastModal({ isOpen, onClose }: BroadcastModalProps) {
  const { t } = useLang();
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSend = async () => {
    if (!subject.trim() || !content.trim()) return;

    setSending(true);
    try {
      // Save to database API
      const token = getToken();
      const response = await fetch('/dev-api/api/messages/broadcast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ subject, content }),
      });

      const data = await response.json();
      if (data.code === 200) {
        // Also save to localStorage for the old notification system
        const now = new Date();
        const broadcastMessage = {
          id: Date.now().toString(),
          sender: t('activity.admin'),
          senderId: 'admin',
          senderRole: 'admin',
          role: 'admin',
          subject: subject,
          text: content,
          message: content,
          time: formatTimeJP(now),
          date: formatDateJP(now),
          timestamp: now.getTime(),
          read: true,
        };
        const storedMessages = localStorage.getItem('notifications_messages');
        const allMessages = storedMessages ? JSON.parse(storedMessages) : [];
        allMessages.unshift(broadcastMessage); // Add at beginning for newest first
        localStorage.setItem('notifications_messages', JSON.stringify(allMessages));

        setSuccess(true);
        setTimeout(() => {
          setSuccess(false);
          setSubject('');
          setContent('');
          onClose();
        }, 2000);
      }
    } catch (err) {
      console.error('Failed to broadcast:', err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-dark-surface rounded-2xl w-full max-w-md shadow-2xl border border-[#E8E8E8] dark:border-dark-border overflow-hidden transition-colors">
        {success ? (
          <div className="text-center py-12 px-6">
            <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="w-10 h-10 text-green-500" />
            </div>
            <h3 className="text-xl font-semibold text-[#232333] dark:text-dark-text">{t('broadcast.sentTitle')}</h3>
            <p className="text-[#6E7680] dark:text-dark-text-muted mt-2">{t('broadcast.sentMessage')}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between p-5 border-b border-[#E8E8E8] dark:border-dark-border bg-[#F6F6F6] dark:bg-dark-bg-primary transition-colors">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-[#1d2089] dark:bg-[#2563eb] rounded-xl transition-colors">
                  <Users className="w-5 h-5 text-white" />
                </div>
                <h2 className="text-lg font-semibold text-[#232333] dark:text-dark-text transition-colors">{t('broadcast.title')}</h2>
              </div>
              <button onClick={onClose} className="p-2 rounded-xl hover:bg-[#E8E8E8] dark:hover:bg-dark-surface text-[#6E7680] dark:text-dark-text-muted hover:text-[#232333] dark:hover:text-dark-text transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#232333] dark:text-dark-text mb-2 transition-colors">{t('broadcast.subjectLabel')}</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={t('broadcast.subjectPlaceholder')}
                  className="w-full bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border text-[#232333] dark:text-dark-text rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#1d2089] dark:focus:ring-[#60a5fa] placeholder-[#9CA3AF] dark:placeholder-dark-text-muted transition-colors"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[#232333] dark:text-dark-text mb-2 transition-colors">{t('broadcast.messageLabel')}</label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={t('broadcast.messagePlaceholder')}
                  rows={4}
                  className="w-full bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border text-[#232333] dark:text-dark-text rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#1d2089] dark:focus:ring-[#60a5fa] placeholder-[#9CA3AF] dark:placeholder-dark-text-muted resize-none transition-colors"
                />
              </div>

              <button
                onClick={handleSend}
                disabled={sending || !subject.trim() || !content.trim()}
                className="w-full bg-[#1d2089] hover:bg-[#161870] disabled:bg-[#E8E8E8] disabled:text-[#9CA3AF] dark:bg-[#2563eb] dark:hover:bg-[#1d4ed8] dark:disabled:bg-[#2563eb]/50 text-white font-medium py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all"
              >
                <Send className="w-4 h-4" />
                {sending ? t('broadcast.sending') : t('broadcast.send')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
