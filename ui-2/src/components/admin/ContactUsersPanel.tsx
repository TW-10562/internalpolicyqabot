import { useState } from 'react';
import {
  Trash2,
  Send,
  CheckCircle,
} from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { getToken } from '../../api/auth';

interface ContactUsersPanelProps {
  onOpenDeleteMessages?: () => void;
}

export default function ContactUsersPanel({
  onOpenDeleteMessages,
}: ContactUsersPanelProps) {
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState('');
  const { t } = useLang();

  const safeT = (key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  };

  const messageLabel = safeT('broadcast.messageLabel', 'Message');
  const messageLabelClean = messageLabel.replace(/\*/g, '').trim();

  const sendBroadcast = async () => {
    if (!content.trim()) return;
    setSending(true);
    try {
      const subjectToSend = subject.trim() || t('broadcast.defaultSubject');
      const contentToSend = content.trim();
      const token = getToken();
      const res = await fetch('/dev-api/api/messages/broadcast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ subject: subjectToSend, content: contentToSend }),
      });
      const data = await res.json();
      if (data.code === 200) {
        setSuccess(t('broadcast.success'));

        setSubject('');
        setContent('');
        setTimeout(() => setSuccess(''), 1600);
      }
    } catch (e) {
      // keep silent
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="space-y-4">
        {/* Broadcast composer card */}
        <div className="bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-2xl overflow-hidden shadow-sm transition-colors">
          <div className="p-5 space-y-4">
            {success && (
              <div className="p-3 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900/40 rounded-xl text-green-600 dark:text-green-300 text-sm flex items-center gap-2 transition-colors">
                <CheckCircle className="w-4 h-4" />
                {success}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-[#232333] dark:text-dark-text mb-2 transition-colors">
                {t('broadcast.subjectLabel')}
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-xl px-4 py-3 text-[#232333] dark:text-dark-text placeholder-[#9CA3AF] dark:placeholder-dark-text-muted focus:outline-none focus:ring-2 focus:ring-[#1d2089] dark:focus:ring-[#60a5fa] focus:border-transparent transition-all"
                placeholder={t('broadcast.subjectPlaceholder')}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[#232333] dark:text-dark-text mb-2">
                {messageLabelClean} <span className="text-red-500">*</span>
              </label>
              <textarea
                rows={5}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-xl px-4 py-3 text-[#232333] dark:text-dark-text placeholder-[#9CA3AF] dark:placeholder-dark-text-muted focus:outline-none focus:ring-2 focus:ring-[#1d2089] dark:focus:ring-[#60a5fa] focus:border-transparent transition-all resize-none"
                placeholder={t('broadcast.messagePlaceholder')}
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={onOpenDeleteMessages}
                className="px-4 py-2.5 rounded-xl text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 text-sm inline-flex items-center gap-2 transition-colors"
                title={t('messages.deleteTitle')}
              >
                <Trash2 className="w-4 h-4" />
                {t('messages.deleteTitle') || 'Delete Messages'}
              </button>

              <button
                type="button"
                onClick={sendBroadcast}
                disabled={sending || !content.trim()}
                className="px-6 py-2.5 rounded-xl bg-[#1d2089] hover:bg-[#161870] disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm inline-flex items-center gap-2 transition-colors"
              >
                <Send className="w-4 h-4" />
                {sending ? t('broadcast.sending') : t('broadcast.send')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
