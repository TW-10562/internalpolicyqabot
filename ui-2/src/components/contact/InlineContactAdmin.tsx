import { useState } from 'react';
import { Send } from 'lucide-react';
import { getToken } from '../../api/auth';
import { useLang } from '../../context/LanguageContext';
import { formatDateTimeJP } from '../../lib/dateTime';

interface InlineContactAdminProps {
  userId?: string;
}

export default function InlineContactAdmin({ userId }: InlineContactAdminProps) {
  const { t } = useLang(); // <-- Use translations
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [justSent, setJustSent] = useState<{
    subject: string;
    content: string;
    timestamp: number;
  } | null>(null);

  const handleSend = async () => {
    if (!content.trim()) return;
    setSending(true);
    try {
      const token = getToken();
      const finalSubject = subject.trim() || t('inlineContactAdmin.defaultSubject');
      const response = await fetch('/dev-api/api/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ subject: finalSubject, content: content.trim() }),
      });
      const data = await response.json();
      if (data.code === 200) {
        setJustSent({ subject: finalSubject, content: content.trim(), timestamp: Date.now() });
        // Store in localStorage to mirror previous popup behavior
        try {
          const stored = localStorage.getItem('notifications_messages');
          const all = stored ? JSON.parse(stored) : [];
          all.unshift({
            id: `local-${Date.now()}`,
            sender: t('inlineContactAdmin.you'),
            senderId: userId || 'user',
            senderRole: 'user',
            role: 'user',
            subject: finalSubject,
            text: content.trim(),
            message: content.trim(),
            timestamp: Date.now(),
            read: true,
          });
          localStorage.setItem('notifications_messages', JSON.stringify(all));
        } catch {}
        setTimeout(() => {
          setSubject('');
          setContent('');
        }, 1600);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-3 py-2 border-b border-[#E8E8E8] dark:border-dark-border bg-[#F6F6F6] dark:bg-dark-bg-primary transition-colors">
        <h2 className="text-lg font-semibold text-[#232333] dark:text-white transition-colors">{t('inlineContactAdmin.title')}</h2>
       
      </div>

      <div className="p-3 space-y-4">     
        {justSent && (
          <div className="p-4 bg-[#F6F6F6] dark:bg-dark-border border border-[#E8E8E8] dark:border-dark-border rounded-xl text-[#232333] dark:text-dark-text text-sm transition-colors">
            <div className="flex items-center justify-between">
              <span className="text-[#232333] font-semibold">{t('inlineContactAdmin.yourMessage')}</span>
              <span className="text-xs text-[#9CA3AF]">{formatDateTimeJP(justSent.timestamp)}</span>
            </div>
            {justSent.subject && (
              <div className="mt-1 text-xs text-[#6E7680]">
                {t('inlineContactAdmin.subject')}: {justSent.subject}
              </div>
            )}
            <p className="mt-2 text-sm whitespace-pre-wrap">{justSent.content}</p>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-[#232333] dark:text-dark-text mb-2 transition-colors">{t('inlineContactAdmin.subjectLabel')}</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={t('inlineContactAdmin.subjectPlaceholder')}
            className="w-full bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-xl px-4 py-3 text-[#232333] dark:text-dark-text placeholder-[#9CA3AF] dark:placeholder-dark-text-muted focus:outline-none focus:ring-2 focus:ring-[#1d2089] dark:focus:ring-[#60a5fa] focus:border-transparent transition-all"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[#232333] dark:text-dark-text mb-2 transition-colors">{t('inlineContactAdmin.contentLabel')}</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('inlineContactAdmin.contentPlaceholder')}
            rows={8}
            className="w-full bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-xl px-4 py-3 text-[#232333] dark:text-dark-text placeholder-[#9CA3AF] dark:placeholder-dark-text-muted focus:outline-none focus:ring-2 focus:ring-[#1d2089] dark:focus:ring-[#60a5fa] focus:border-transparent transition-all resize-vertical"
          />
          <p className="mt-2 text-xs text-[#9CA3AF] dark:text-dark-text-muted transition-colors">
            {content.length > 0
              ? t('inlineContactAdmin.charactersCount', { count: content.length })
              : t('inlineContactAdmin.minCharacters')}
          </p>
        </div>

        <div className="pt-2 flex justify-end">
          <button
            onClick={handleSend}
            disabled={sending || !content.trim()}
            className="px-5 py-2.5 bg-[#1d2089] hover:bg-[#161870] disabled:bg-[#E8E8E8] disabled:text-[#9CA3AF] rounded-xl text-white text-sm font-medium inline-flex items-center gap-2 transition-colors"
          >
            <Send className="w-4 h-4" />
            {sending ? t('inlineContactAdmin.sending') : t('inlineContactAdmin.sendButton')}
          </button>
        </div>
      </div>
    </div>
  );
}
