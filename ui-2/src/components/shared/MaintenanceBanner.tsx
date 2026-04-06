import { useState, useEffect, useCallback } from 'react';
import { Wrench, Rocket, AlertTriangle, X, Clock } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';

type NoticeType = 'maintenance' | 'update' | 'incident';

interface MaintenanceConfig {
  active: boolean;
  type?: NoticeType;
  title?: { en?: string; ja?: string };
  message?: { en?: string; ja?: string };
  estimatedTime?: { en?: string; ja?: string };
  allowDismiss?: boolean;
  activatedAt?: string;
}

const POLL_MS = 30_000;

/* ── Per-type theme config ─────────────────────────────────────────── */
const themes: Record<NoticeType, {
  icon: typeof Wrench;
  gradient: string;
  border: string;
  iconBg: string;
  iconColor: string;
  titleColor: string;
  textColor: string;
  subtextColor: string;
  barBg: string;
  barFill: string;
  closeBtnHover: string;
}> = {
  maintenance: {
    icon: Wrench,
    gradient: 'from-amber-50 to-orange-50 dark:from-amber-950/90 dark:to-orange-950/90',
    border: 'border-amber-200 dark:border-amber-700',
    iconBg: 'bg-amber-100 dark:bg-amber-900/60',
    iconColor: 'text-amber-600 dark:text-amber-400',
    titleColor: 'text-amber-800 dark:text-amber-200',
    textColor: 'text-amber-900/90 dark:text-amber-100/90',
    subtextColor: 'text-amber-700/70 dark:text-amber-300/60',
    barBg: 'bg-amber-200/50 dark:bg-amber-800/40',
    barFill: 'bg-amber-400 dark:bg-amber-500',
    closeBtnHover: 'text-amber-600 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/50',
  },
  update: {
    icon: Rocket,
    gradient: 'from-blue-50 to-indigo-50 dark:from-blue-950/90 dark:to-indigo-950/90',
    border: 'border-blue-200 dark:border-blue-700',
    iconBg: 'bg-blue-100 dark:bg-blue-900/60',
    iconColor: 'text-blue-600 dark:text-blue-400',
    titleColor: 'text-blue-800 dark:text-blue-200',
    textColor: 'text-blue-900/90 dark:text-blue-100/90',
    subtextColor: 'text-blue-700/70 dark:text-blue-300/60',
    barBg: 'bg-blue-200/50 dark:bg-blue-800/40',
    barFill: 'bg-blue-400 dark:bg-blue-500',
    closeBtnHover: 'text-blue-600 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-900/50',
  },
  incident: {
    icon: AlertTriangle,
    gradient: 'from-red-50 to-rose-50 dark:from-red-950/90 dark:to-rose-950/90',
    border: 'border-red-200 dark:border-red-700',
    iconBg: 'bg-red-100 dark:bg-red-900/60',
    iconColor: 'text-red-600 dark:text-red-400',
    titleColor: 'text-red-800 dark:text-red-200',
    textColor: 'text-red-900/90 dark:text-red-100/90',
    subtextColor: 'text-red-700/70 dark:text-red-300/60',
    barBg: 'bg-red-200/50 dark:bg-red-800/40',
    barFill: 'bg-red-400 dark:bg-red-500',
    closeBtnHover: 'text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/50',
  },
};

/* ── Default titles per type ───────────────────────────────────────── */
const defaultTitles: Record<NoticeType, { en: string; ja: string }> = {
  maintenance: {
    en: 'Scheduled Maintenance',
    ja: '定期メンテナンス',
  },
  update: {
    en: 'System Update in Progress',
    ja: 'システムアップデート中',
  },
  incident: {
    en: 'Service Disruption',
    ja: 'サービス障害のお知らせ',
  },
};

const defaultMessages: Record<NoticeType, { en: string; ja: string }> = {
  maintenance: {
    en: 'We are currently performing scheduled maintenance to improve your experience. Some features may be temporarily unavailable.',
    ja: '現在、サービス向上のため定期メンテナンスを実施しております。一部の機能が一時的にご利用いただけない場合がございます。',
  },
  update: {
    en: 'We are rolling out exciting new updates! The system will be back to full capacity shortly.',
    ja: '新しいアップデートを展開中です！まもなく通常通りご利用いただけるようになります。',
  },
  incident: {
    en: 'We are aware of an issue affecting the system and our team is working to resolve it as quickly as possible.',
    ja: 'システムに影響を与える問題が発生しております。現在、復旧に向けて対応しております。',
  },
};

const closingMessages: Record<NoticeType, { en: string; ja: string }> = {
  maintenance: {
    en: 'Thank you for your patience and understanding.',
    ja: 'ご理解とご協力に感謝いたします。',
  },
  update: {
    en: 'Thank you for your patience — great things are on the way!',
    ja: 'いつもご利用いただきありがとうございます。もうしばらくお待ちくださいませ。',
  },
  incident: {
    en: 'We sincerely apologise for the inconvenience. Our team is on it.',
    ja: 'ご不便をおかけし、大変申し訳ございません。',
  },
};

/* ── Component ─────────────────────────────────────────────────────── */
export default function MaintenanceBanner() {
  const { lang } = useLang();
  const [config, setConfig] = useState<MaintenanceConfig | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/dev-api/api/maintenance');
      if (!res.ok) return;
      const data: MaintenanceConfig = await res.json();

      // If a new activation happened after user dismissed, show again
      if (data.active && data.activatedAt) {
        const prev = sessionStorage.getItem('maintenance_dismissed_at');
        if (prev && data.activatedAt > prev) {
          setDismissed(false);
        }
      }
      // If banner was turned off, reset dismissed state
      if (!data.active) {
        setDismissed(false);
        sessionStorage.removeItem('maintenance_dismissed_at');
      }

      setConfig(data);
    } catch {
      // Silently ignore
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  if (!config?.active || dismissed) return null;

  const type: NoticeType = config.type && themes[config.type] ? config.type : 'maintenance';
  const theme = themes[type];
  const Icon = theme.icon;
  const canDismiss = config.allowDismiss !== false;

  // Resolve text: config values → defaults for the type
  const title = (lang === 'ja' ? config.title?.ja : config.title?.en)
    || defaultTitles[type][lang];
  const message = (lang === 'ja' ? config.message?.ja : config.message?.en)
    || defaultMessages[type][lang];
  const closing = closingMessages[type][lang];
  const eta = lang === 'ja' ? config.estimatedTime?.ja : config.estimatedTime?.en;

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem('maintenance_dismissed_at', new Date().toISOString());
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        className={`relative mx-4 w-full max-w-lg rounded-2xl border bg-gradient-to-br p-8 shadow-2xl
          ${theme.gradient} ${theme.border}`}
        style={{ animation: 'maintenance-fade-in 0.4s ease-out' }}
      >
        {/* Dismiss button */}
        {canDismiss && (
          <button
            onClick={handleDismiss}
            className={`absolute right-4 top-4 rounded-full p-1.5 transition-colors ${theme.closeBtnHover}`}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        )}

        {/* Icon */}
        <div className={`mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full ${theme.iconBg}`}>
          <Icon className={`h-8 w-8 ${theme.iconColor}`} />
        </div>

        {/* Title */}
        <h2 className={`mb-3 text-center text-xl font-bold ${theme.titleColor}`}>
          {title}
        </h2>

        {/* Message */}
        <p className={`mb-4 text-center text-base leading-relaxed ${theme.textColor}`}>
          {message}
        </p>

        {/* Estimated time */}
        {eta && (
          <div className={`mb-4 flex items-center justify-center gap-2 ${theme.subtextColor}`}>
            <Clock size={15} />
            <span className="text-sm font-medium">
              {lang === 'ja' ? `推定時間: ${eta}` : `Estimated time: ${eta}`}
            </span>
          </div>
        )}

        {/* Polite closing */}
        <p className={`text-center text-sm italic ${theme.subtextColor}`}>
          {closing}
        </p>

        {/* Animated progress bar */}
        <div className={`mt-6 h-1.5 w-full overflow-hidden rounded-full ${theme.barBg}`}>
          <div
            className={`h-full w-1/3 rounded-full ${theme.barFill}`}
            style={{ animation: 'maintenance-slide 2s ease-in-out infinite' }}
          />
        </div>

        <style>{`
          @keyframes maintenance-slide {
            0%   { transform: translateX(-100%); }
            50%  { transform: translateX(300%); }
            100% { transform: translateX(-100%); }
          }
          @keyframes maintenance-fade-in {
            from { opacity: 0; transform: scale(0.95) translateY(10px); }
            to   { opacity: 1; transform: scale(1) translateY(0); }
          }
        `}</style>
      </div>
    </div>
  );
}
