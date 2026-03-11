/**
 * Chat Export - Export conversation as TXT / MD / JSON
 */
import { useState } from 'react';
import { Download, FileText, File, X, Loader2, Copy, Check } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

interface ChatExportProps {
  messages: Message[];
  chatTitle?: string;
  onClose: () => void;
}

export default function ChatExport({
  messages,
  chatTitle = 'Chat Export',
  onClose,
}: ChatExportProps) {
  const { t } = useLang();
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);

  const formatMessages = () => {
    const header = `# ${chatTitle}\n${t('chatExport.exportedOn')}: ${new Date().toLocaleString()}\n${'='.repeat(50)}\n\n`;

    const content = messages
      .map((msg) => {
        const role =
          msg.role === 'user'
            ? `👤 ${t('chatExport.you')}`
            : `🤖 ${t('chatExport.assistant')}`;
        const time = msg.timestamp || '';
        return `${role}${time ? ` (${time})` : ''}:\n${msg.content}\n`;
      })
      .join('\n' + '-'.repeat(40) + '\n\n');

    return header + content;
  };

  const exportFile = (content: string, type: string, ext: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${chatTitle.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportAsTxt = () => {
    setExporting(true);
    try {
      exportFile(formatMessages(), 'text/plain', 'txt');
    } finally {
      setExporting(false);
    }
  };

  const exportAsMarkdown = () => {
    setExporting(true);
    try {
      const header = `# ${chatTitle}\n\n*${t(
        'chatExport.exportedOn'
      )}: ${new Date().toLocaleString()}*\n\n---\n\n`;

      const content = messages
        .map((msg) => {
          const role =
            msg.role === 'user'
              ? `**${t('chatExport.you')}:**`
              : `**${t('chatExport.assistant')}:**`;
          return `${role}\n\n${msg.content}\n`;
        })
        .join('\n---\n\n');

      exportFile(header + content, 'text/markdown', 'md');
    } finally {
      setExporting(false);
    }
  };

  const exportAsJson = () => {
    setExporting(true);
    try {
      exportFile(
        JSON.stringify(
          {
            title: chatTitle,
            exportedAt: new Date().toISOString(),
            messageCount: messages.length,
            messages,
          },
          null,
          2
        ),
        'application/json',
        'json'
      );
    } finally {
      setExporting(false);
    }
  };

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(formatMessages());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-surface dark:bg-dark-surface border border-default rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden transition-colors">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-default bg-surface-alt dark:bg-dark-bg-primary transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center border border-default">
              <Download className="w-5 h-5 text-black dark:text-on-accent icon-current" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground dark:text-white transition-colors">{t('chatExport.title')}</h2>
              <p className="text-xs text-muted dark:text-dark-text-muted transition-colors">
                {t('chatExport.messagesCount', { count: messages.length })}
              </p>
            </div>
          </div>

          <button onClick={onClose} className="p-2 rounded-lg hover:bg-surface dark:hover:bg-dark-border transition-colors">
            <X className="w-5 h-5 text-muted dark:text-dark-text-muted" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-3">
          <p className="text-sm text-muted dark:text-dark-text-muted mb-4 transition-colors">
            {t('chatExport.description')}
          </p>

          <ExportButton type="text" icon={FileText} title={t('chatExport.plainText.title')} desc={t('chatExport.plainText.desc')} onClick={exportAsTxt} />
          <ExportButton type="markdown" icon={File} title={t('chatExport.markdown.title')} desc={t('chatExport.markdown.desc')} onClick={exportAsMarkdown} />
          <ExportButton type="json" icon={File} title={t('chatExport.json.title')} desc={t('chatExport.json.desc')} onClick={exportAsJson} />

          <div className="text-center text-xs text-muted dark:text-dark-text-muted">{t('chatExport.or')}</div>

          <button
            onClick={copyToClipboard}
            className="w-full flex items-center justify-center gap-2 p-3 btn-primary text-on-accent rounded-xl transition-colors"
          >
            {copied ? <Check className="w-4 h-4 text-black dark:text-on-accent" /> : <Copy className="w-4 h-4 text-black dark:text-on-accent" />}
            {copied ? t('chatExport.copied') : t('chatExport.copy')}
          </button>
        </div>

        {exporting && (
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-on-accent animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}

interface ExportButtonProps {
  type: 'text' | 'markdown' | 'json';
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  onClick: () => void;
}

function ExportButton({ type, icon: Icon, title, desc, onClick }: ExportButtonProps) {
  const getColorClasses = () => {
    switch (type) {
      case 'text':
        return {
          bg: 'bg-orange-50 dark:bg-orange-950/20',
          border: 'border-orange-200 dark:border-orange-800/50',
          iconBg: 'bg-orange-100 dark:bg-orange-900/40',
          iconColor: 'text-black dark:text-orange-300', // updated
          hoverBg: 'hover:bg-orange-100 dark:hover:bg-orange-900/30'
        };
      case 'markdown':
        return {
          bg: 'bg-green-50 dark:bg-green-900/20',
          border: 'border-green-200 dark:border-green-800/50',
          iconBg: 'bg-green-100 dark:bg-green-900/40',
          iconColor: 'text-black dark:text-green-400', // updated
          hoverBg: 'hover:bg-green-100 dark:hover:bg-green-900/30'
        };
      case 'json':
        return {
          bg: 'bg-purple-50 dark:bg-purple-900/20',
          border: 'border-purple-200 dark:border-purple-800/50',
          iconBg: 'bg-purple-100 dark:bg-purple-900/40',
          iconColor: 'text-black dark:text-purple-400', // updated
          hoverBg: 'hover:bg-purple-100 dark:hover:bg-purple-900/30'
        };
      default:
        return {
          bg: 'bg-surface dark:bg-dark-surface-alt',
          border: 'border-default',
          iconBg: 'bg-surface-alt dark:bg-dark-surface',
          iconColor: 'text-black dark:text-dark-text-muted', // updated
          hoverBg: 'hover:bg-surface-alt dark:hover:bg-dark-border'
        };
    }
  };

  const colors = getColorClasses();

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-4 p-4 ${colors.bg} border ${colors.border} rounded-xl text-left transition-colors ${colors.hoverBg}`}
    >
      <div className={`w-10 h-10 rounded-xl ${colors.iconBg} border ${colors.border} flex items-center justify-center`}>
        <Icon className={`w-5 h-5 ${colors.iconColor} icon-current`} />
      </div>
      <div>
        <p className="font-medium text-foreground dark:text-dark-text transition-colors">{title}</p>
        <p className="text-xs text-muted dark:text-dark-text-muted transition-colors">{desc}</p>
      </div>
    </button>
  );
}