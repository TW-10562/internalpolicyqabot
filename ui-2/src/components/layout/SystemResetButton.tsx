import { useMemo, useState } from 'react';
import { AlertTriangle, RefreshCcw } from 'lucide-react';
import { executeSystemReset } from '../../api/systemReset';
import { removeToken } from '../../api/request';
import { useLang } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';

const RESET_PHRASE = 'CONFIRM AND PROCEED DELETION';

type ResetStep = 'confirm' | 'password';

export default function SystemResetButton() {
  const { t } = useLang();
  const toast = useToast();

  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<ResetStep>('confirm');
  const [password, setPassword] = useState('');
  const [confirmationText, setConfirmationText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorText, setErrorText] = useState('');
  const blockCopyAction = (e: any) => {
    e.preventDefault();
  };

  const isPhraseMatched = useMemo(() => {
    return confirmationText.trim().toUpperCase() === RESET_PHRASE;
  }, [confirmationText]);

  const canSubmitReset = useMemo(() => {
    return password.trim().length > 0 && !isSubmitting;
  }, [password, isSubmitting]);

  const closeModal = (force = false) => {
    if (isSubmitting && !force) return;
    setIsOpen(false);
    setStep('confirm');
    setPassword('');
    setConfirmationText('');
    setErrorText('');
  };

  const handleContinueToPassword = () => {
    if (!confirmationText.trim()) {
      setErrorText(t('systemReset.validation.confirmationRequired'));
      return;
    }
    if (!isPhraseMatched) {
      setErrorText(t('systemReset.validation.confirmationMismatch', { phrase: RESET_PHRASE }));
      return;
    }
    setErrorText('');
    setStep('password');
  };

  const handleReset = async () => {
    const normalizedPassword = password.trim();
    if (!normalizedPassword) {
      setErrorText(t('systemReset.validation.passwordRequired'));
      return;
    }

    setIsSubmitting(true);
    setErrorText('');

    try {
      const res = await executeSystemReset(normalizedPassword, confirmationText.trim());
      if (res.code !== 200) {
        const message = res.message || t('systemReset.errors.failed');
        setErrorText(message);
        toast.error(t('systemReset.toast.errorTitle'), message);
        return;
      }

      toast.success(
        t('systemReset.toast.successTitle'),
        t('systemReset.toast.successBody', {
          user: String(res.result?.adminUserName || 'admin'),
          password: String(res.result?.adminPassword || 'password'),
        }),
      );

      closeModal(true);
      removeToken();
      window.setTimeout(() => {
        window.location.assign('/');
      }, 600);
    } catch (e: any) {
      const message = String(e?.message || t('systemReset.errors.failed'));
      setErrorText(message);
      toast.error(t('systemReset.toast.errorTitle'), message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="p-2.5 rounded-xl transition-colors"
        title={t('systemReset.buttonTitle')}
        aria-label={t('systemReset.buttonTitle')}
      >
        <RefreshCcw className="w-5 h-5 text-red-500 dark:text-red-400 icon-current" />
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 px-4">
          <div className="w-full max-w-lg rounded-2xl border border-default bg-surface dark:bg-[#0f1724] p-5 shadow-xl">
            <div
              className="flex items-start gap-3 select-none"
              onCopy={blockCopyAction}
              onCut={blockCopyAction}
              onContextMenu={blockCopyAction}
              onDragStart={blockCopyAction}
            >
              <div className="mt-0.5 rounded-full bg-red-100 p-2 dark:bg-red-900/40">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground dark:text-dark-text">
                  {t('systemReset.modalTitle')}
                </h3>
                <p className="mt-1 text-sm text-muted dark:text-dark-text-muted">
                  {t('systemReset.warningBody')}
                </p>
              </div>
            </div>

            {step === 'confirm' ? (
              <div className="mt-4 space-y-3">
                <div
                  className="rounded-lg border border-red-300 bg-red-50/80 p-3 dark:border-red-700/50 dark:bg-red-900/20 select-none"
                  onCopy={blockCopyAction}
                  onCut={blockCopyAction}
                  onContextMenu={blockCopyAction}
                  onDragStart={blockCopyAction}
                >
                  <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                    {t('systemReset.warningTitle')}
                  </p>
                  <p className="mt-1 text-xs text-red-700/90 dark:text-red-300/90">
                    {t('systemReset.warningCannotUndo')}
                  </p>
                </div>

                <div
                  className="rounded-lg border border-default bg-surface-alt p-3 select-none"
                  onCopy={blockCopyAction}
                  onCut={blockCopyAction}
                  onContextMenu={blockCopyAction}
                  onDragStart={blockCopyAction}
                >
                  <p className="text-sm font-medium text-foreground dark:text-dark-text">
                    {t('systemReset.afterResetTitle')}
                  </p>
                  <p className="mt-1 text-sm text-muted dark:text-dark-text-muted">
                    {t('systemReset.afterResetUsername')}: <span className="font-semibold text-foreground dark:text-dark-text">admin</span>
                  </p>
                  <p className="text-sm text-muted dark:text-dark-text-muted">
                    {t('systemReset.afterResetPassword')}: <span className="font-semibold text-foreground dark:text-dark-text">password</span>
                  </p>
                </div>

                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-foreground dark:text-dark-text">
                    {t('systemReset.confirmLabel')}
                  </span>
                  <p
                    className="mb-2 text-xs text-muted dark:text-dark-text-muted select-none"
                    onCopy={blockCopyAction}
                    onCut={blockCopyAction}
                    onContextMenu={blockCopyAction}
                    onDragStart={blockCopyAction}
                  >
                    {t('systemReset.confirmHint', { phrase: RESET_PHRASE })}
                  </p>
                  <input
                    type="text"
                    value={confirmationText}
                    onChange={(e) => setConfirmationText(e.target.value)}
                    onPaste={blockCopyAction}
                    onDrop={blockCopyAction}
                    className="w-full rounded-lg border border-default bg-surface-alt px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-red-400"
                    placeholder={t('systemReset.confirmPlaceholder')}
                    autoFocus
                  />
                </label>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <p className="text-sm text-muted dark:text-dark-text-muted">
                  {t('systemReset.passwordStepHint')}
                </p>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-foreground dark:text-dark-text">
                    {t('systemReset.passwordLabel')}
                  </span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-default bg-surface-alt px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-red-400"
                    placeholder={t('systemReset.passwordPlaceholder')}
                    autoFocus
                  />
                </label>
              </div>
            )}

            {errorText ? (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400">{errorText}</p>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => closeModal()}
                className="rounded-lg border border-default px-4 py-2 text-sm text-foreground transition-colors"
                disabled={isSubmitting}
              >
                {t('common.cancel')}
              </button>

              {step === 'confirm' ? (
                <button
                  type="button"
                  onClick={handleContinueToPassword}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors"
                >
                  {t('systemReset.nextButton')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      if (isSubmitting) return;
                      setErrorText('');
                      setStep('confirm');
                    }}
                    className="rounded-lg border border-default px-4 py-2 text-sm text-foreground transition-colors"
                    disabled={isSubmitting}
                  >
                    {t('systemReset.backButton')}
                  </button>
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={!canSubmitReset}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSubmitting ? t('systemReset.confirming') : t('systemReset.confirmButton')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
