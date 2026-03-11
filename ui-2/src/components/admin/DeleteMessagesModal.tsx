import { useState } from 'react';
import {
  Trash2,
  AlertTriangle,
  Clock,
  CheckCircle,
  X,
} from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';
import { getToken } from '../../api/auth';

interface DeleteMessagesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function DeleteMessagesModal({
  isOpen,
  onClose,
  onSuccess,
}: DeleteMessagesModalProps) {
  const { t } = useLang();
  const toast = useToast();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmationText, setConfirmationText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteSuccess, setDeleteSuccess] = useState(false);
  const [deleteUserMessages, setDeleteUserMessages] = useState(false);
  const [deleteAdminMessages, setDeleteAdminMessages] = useState(false);

  const handleOpenDeleteConfirm = () => {
    if (!deleteUserMessages && !deleteAdminMessages) {
      toast.error(t('messages.selectOneError'));
      return;
    }
    setShowDeleteConfirm(true);
    setConfirmationText('');
    setDeleteSuccess(false);
  };

  const handleDeleteMessages = async () => {
    if (confirmationText !== t('messages.confirmText')) {
      toast.error(t('messages.confirmMismatch'));
      return;
    }

    setIsDeleting(true);
    try {
      const token = getToken();
      const res = await fetch('/dev-api/api/messages/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          deleteUserMessages,
          deleteAdminMessages,
        }),
      });

      const data = await res.json();
      if (data.code === 200) {
        setDeleteSuccess(true);
        toast.success(
          t('messages.deleteSuccess', {
            count: data.result?.deletedCount || 0,
          })
        );

        try {
          localStorage.removeItem('notifications_messages');
          localStorage.removeItem('read_message_ids');
          console.log('Cleared all message-related localStorage data');
        } catch (err) {
          console.error('Failed to clear localStorage:', err);
        }

        setTimeout(() => {
          onClose?.();
          setShowDeleteConfirm(false);
          setConfirmationText('');
          setDeleteUserMessages(false);
          setDeleteAdminMessages(false);
          setDeleteSuccess(false);
          setIsDeleting(false);
          onSuccess?.();
        }, 2000);
      } else {
        toast.error(data.message || t('messages.deleteFailed'));
        setIsDeleting(false);
      }
    } catch (err) {
      console.error('Failed to delete messages:', err);
      toast.error(t('messages.deleteFailedRetry'));
      setIsDeleting(false);
    }
  };

  if (!isOpen) return null;

  // Confirmation Modal
  if (showDeleteConfirm) {
    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-[#1a1a2e] border border-[#E8E8E8] dark:border-[#2d2d3d] rounded-2xl max-w-lg w-full shadow-2xl overflow-hidden transition-colors">
          <div className="p-5 border-b border-[#E8E8E8] dark:border-[#2d2d3d] bg-[#F6F6F6] dark:bg-[#252538] flex items-start justify-between gap-4 transition-colors">
            <div className="flex items-start gap-3">
              <div className="p-3 rounded-xl bg-red-50 dark:bg-red-500/15 flex-shrink-0 transition-colors">
                <AlertTriangle className="w-6 h-6 text-red-500 dark:text-red-400" />
              </div>
              <div className="flex-1">
                <h3 className="text-xl font-semibold text-[#232333] dark:text-white transition-colors">
                  {t('messages.deleteTitle')}
                </h3>
                <p className="text-sm text-[#6E7680] dark:text-dark-text-muted mt-1 transition-colors">
                  {t('messages.deleteDescription')}
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                setShowDeleteConfirm(false);
                setConfirmationText('');
                setDeleteSuccess(false);
              }}
              disabled={isDeleting}
              className="p-2 rounded-xl hover:bg-[#E8E8E8] dark:hover:bg-[#3d3d4d] text-[#6E7680] dark:text-[#9ca3af] hover:text-[#232333] dark:hover:text-[#e5e7eb] transition-colors"
              title={t('common.close')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-5 space-y-5">
            <div className="bg-[#F6F6F6] dark:bg-[#252538] border border-[#E8E8E8] dark:border-[#3d3d4d] rounded-xl p-4 transition-colors">
              <p className="text-sm font-medium text-[#232333] dark:text-[#e5e7eb] mb-2 transition-colors">
                {t('messages.aboutToDelete')}
              </p>
              <ul className="text-sm text-[#6E7680] dark:text-[#9ca3af] space-y-1 ml-5 transition-colors">
                {deleteUserMessages && (
                  <li className="list-disc">{t('messages.deleteUsers')}</li>
                )}
                {deleteAdminMessages && (
                  <li className="list-disc">{t('messages.deleteAdmins')}</li>
                )}
              </ul>
            </div>

            <div>
              <p className="text-sm font-medium text-[#232333] dark:text-[#e5e7eb] mb-2 transition-colors">
                {t('messages.confirmLabel').replace(t('messages.confirmText'), '')}
                <span className="ml-2 font-mono bg-[#1d2089] dark:bg-[#2563eb] text-white px-2 py-1 rounded-lg">
                  {t('messages.confirmText')}
                </span>
              </p>
              <input
                type="text"
                value={confirmationText}
                onChange={(e) => setConfirmationText(e.target.value)}
                placeholder={t('messages.confirmPlaceholder')}
                className="w-full bg-white dark:bg-[#1a1a2e] border border-[#E8E8E8] dark:border-[#3d3d4d] rounded-xl px-4 py-3 text-[#232333] dark:text-[#e5e7eb] placeholder-[#9CA3AF] dark:placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#1d2089] dark:focus:ring-[#60a5fa] focus:border-transparent font-mono transition-colors"
                autoFocus
              />
            </div>

            <div className="flex gap-3 pt-4 border-t border-[#E8E8E8] dark:border-[#3d3d4d]">
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setConfirmationText('');
                  setDeleteSuccess(false);
                }}
                disabled={isDeleting}
                className="flex-1 px-4 py-3 rounded-xl bg-[#F6F6F6] dark:bg-[#252538] hover:bg-[#E8E8E8] dark:hover:bg-[#3d3d4d] disabled:opacity-50 disabled:cursor-not-allowed text-[#232333] dark:text-[#e5e7eb] transition-colors font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDeleteMessages}
                disabled={confirmationText !== t('messages.confirmText') || isDeleting || deleteSuccess}
                className="flex-1 px-4 py-3 rounded-xl bg-red-500 hover:bg-red-600 disabled:bg-[#E8E8E8] dark:disabled:bg-[#3d3d4d] disabled:text-[#9CA3AF] dark:disabled:text-[#6b7280] disabled:cursor-not-allowed text-white transition-colors font-semibold flex items-center justify-center gap-2"
              >
                {isDeleting ? (
                  <>
                    <Clock className="w-4 h-4 animate-spin" />
                    {t('messages.deleting')}
                  </>
                ) : deleteSuccess ? (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    {t('messages.deleted')}
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    {t('messages.deletePermanently')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Main Delete Messages Modal
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-[#1a1a2e] border border-[#E8E8E8] dark:border-[#2d2d3d] rounded-2xl max-w-lg w-full shadow-2xl overflow-hidden transition-colors">
        <div className="p-5 border-b border-[#E8E8E8] dark:border-[#2d2d3d] bg-red-50 dark:bg-red-500/10 flex items-start justify-between gap-4 transition-colors">
          <div className="flex items-start gap-3">
            <div className="p-3 rounded-xl bg-red-500/20 dark:bg-red-500/15 flex-shrink-0">
              <AlertTriangle className="w-6 h-6 text-red-500 dark:text-red-400" />
            </div>
            <div className="flex-1">
              <h3 className="text-xl font-semibold text-[#232333] dark:text-[#f1f5f9] transition-colors">
                {t('messages.deleteTitle')}
              </h3>
              <p className="text-sm text-[#6E7680] dark:text-[#cbd5e1] mt-1 transition-colors">
                {t('messages.deleteDescription')}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              onClose?.();
              setDeleteUserMessages(false);
              setDeleteAdminMessages(false);
            }}
            className="p-2 rounded-xl hover:bg-red-100 dark:hover:bg-red-500/20 text-[#6E7680] dark:text-[#9ca3af] hover:text-red-500 dark:hover:text-red-400 transition-colors"
            title={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5">
          <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl p-4 mb-5 transition-colors">
            <p className="text-sm text-amber-700 dark:text-amber-400 transition-colors">
              <span className="font-semibold">{t('common.warning')}</span>{' '}{t('messages.deleteWarning')}
            </p>
          </div>

          <div className="space-y-3 mb-5">
            <label className="flex items-center gap-4 p-4 bg-[#F6F6F6] dark:bg-[#252538] border border-[#E8E8E8] dark:border-[#3d3d4d] rounded-xl cursor-pointer hover:bg-[#E8E8E8] dark:hover:bg-[#3d3d4d] transition-colors">
              <input
                type="checkbox"
                checked={deleteUserMessages}
                onChange={(e) => setDeleteUserMessages(e.target.checked)}
                className="w-5 h-5 accent-[#1d2089] dark:accent-[#60a5fa] rounded"
              />
              <div className="flex-1">
                <span className="text-[#232333] dark:text-[#e5e7eb] font-medium transition-colors">
                  {t('messages.usersLabel')}
                </span>
                <p className="text-xs text-[#6E7680] dark:text-[#9ca3af] mt-1 transition-colors">
                  {t('messages.usersHelp')}
                </p>
              </div>
            </label>

            <label className="flex items-center gap-4 p-4 bg-[#F6F6F6] dark:bg-[#252538] border border-[#E8E8E8] dark:border-[#3d3d4d] rounded-xl cursor-pointer hover:bg-[#E8E8E8] dark:hover:bg-[#3d3d4d] transition-colors">
              <input
                type="checkbox"
                checked={deleteAdminMessages}
                onChange={(e) => setDeleteAdminMessages(e.target.checked)}
                className="w-5 h-5 accent-[#1d2089] dark:accent-[#60a5fa] rounded"
              />
              <div className="flex-1">
                <span className="text-[#232333] dark:text-[#e5e7eb] font-medium transition-colors">
                  {t('messages.adminsLabel')}
                </span>
                <p className="text-xs text-[#6E7680] dark:text-[#9ca3af] mt-1 transition-colors">
                  {t('messages.adminsHelp')}
                </p>
              </div>
            </label>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => {
                onClose?.();
                setDeleteUserMessages(false);
                setDeleteAdminMessages(false);
              }}
              className="flex-1 px-6 py-3 bg-[#F6F6F6] dark:bg-[#252538] hover:bg-[#E8E8E8] dark:hover:bg-[#3d3d4d] text-[#232333] dark:text-[#e5e7eb] font-medium rounded-xl transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleOpenDeleteConfirm}
              disabled={!deleteUserMessages && !deleteAdminMessages}
              className="flex-1 px-6 py-3 bg-red-500 hover:bg-red-600 disabled:bg-[#E8E8E8] dark:disabled:bg-[#3d3d4d] disabled:text-[#9CA3AF] dark:disabled:text-[#6b7280] disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              <Trash2 className="w-5 h-5" />
              {t('messages.deleteButton')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
