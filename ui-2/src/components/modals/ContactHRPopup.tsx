import { X, AlertCircle } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
interface ContactHRPopupProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  message?: string;
}
 
export default function ContactHRPopup({
  isOpen,
  onClose,
  title,
  message
}: ContactHRPopupProps) {
  const { t } = useLang();
  if (!isOpen) return null;

  const resolvedTitle = title || t('contactHR.defaultTitle');
  const resolvedMessage = message || t('contactHR.defaultMessage');
 
  return (
      <div className="bg-surface dark:bg-dark-surface rounded-2xl w-full max-w-md border border-default shadow-2xl transition-colors">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-default bg-surface-alt dark:bg-dark-bg-primary transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-surface dark:bg-dark-surface rounded-xl flex items-center justify-center border border-default">
              <AlertCircle className="w-5 h-5 text-accent" />
            </div>
            <h3 className="font-semibold text-foreground dark:text-white text-lg transition-colors">{resolvedTitle}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-surface dark:hover:bg-dark-border text-muted hover:text-foreground dark:text-white/70 dark:hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
 
        {/* Content */}
        <div className="p-6 space-y-4">
          <div className="bg-surface-alt dark:bg-dark-surface border border-default rounded-xl p-4 transition-colors">
            <p className="text-foreground dark:text-white text-center transition-colors">
              {resolvedMessage}
            </p>
          </div>
 
          <div className="space-y-3 text-sm text-muted dark:text-white/80 transition-colors">
            <p className="font-medium text-foreground dark:text-white transition-colors">{t('hrContact.title')}</p>

      <p>
        📧 {t('hrContact.email')}:{" "}
        <span className="text-accent dark:text-white">hr@twave.co.jp</span>
      </p>

      <p>
        📞 {t('hrContact.phone')}:{" "}
        <span className="text-accent dark:text-white">+81 (XXX) XXX-XXXX</span>
      </p>

      <p>
        🏢 {t('hrContact.office')}:{" "}
        <span className="text-accent dark:text-white">
          {t('hrContact.officeLocation')}
        </span>
      </p>
          </div>
        </div>
      </div>
  );
}
 
 
