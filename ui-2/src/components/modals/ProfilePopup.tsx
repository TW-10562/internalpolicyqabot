import { useState } from 'react';
import { User, Building, Calendar, Key, LogOut, Shield } from 'lucide-react';
import { User as UserType } from '../../types';
import { useLang } from '../../context/LanguageContext';
import ContactHRPopup from './ContactHRPopup';

interface ProfilePopupProps {
  user: UserType;
  onLogout: () => void;
}

export default function ProfilePopup({ user, onLogout }: ProfilePopupProps) {
  const { t } = useLang();
  const [showContactHR, setShowContactHR] = useState(false);

  return (
    <div className="p-6 h-full overflow-y-auto bg-[#F6F6F6] dark:bg-dark-surface transition-colors">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-24 h-24 bg-[#1d2089] dark:bg-[#2563eb] rounded-full flex items-center justify-center mb-4 shadow-lg transition-colors">
            <User className="w-12 h-12 text-white" />
          </div>
          <h2 className="text-2xl font-bold text-[#232333] dark:text-dark-text mb-1 transition-colors">{user.name}</h2>
          <p className="text-[#6E7680] dark:text-dark-text-muted transition-colors">{user.department}</p>
          {(user.role === 'admin' || (user.roleCode && user.roleCode !== 'USER')) && (
            <div className="mt-2 px-3 py-1 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-full flex items-center gap-2 transition-colors">
              <Shield className="w-4 h-4 text-amber-500" />
              <span className="text-sm text-amber-600 dark:text-amber-400 font-medium transition-colors">{t('profile.administrator') || 'Administrator'}</span>
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-dark-bg-primary border border-[#E8E8E8] dark:border-dark-border rounded-2xl p-6 space-y-4 shadow-sm transition-colors">
          <h3 className="text-lg font-semibold text-[#232333] dark:text-dark-text mb-4 transition-colors">{t('profile.info') || 'Profile Information'}</h3>

          <div className="space-y-3">
            <div className="flex items-center gap-3 p-3 bg-[#F6F6F6] dark:bg-dark-surface rounded-xl transition-colors">
              <div className="w-10 h-10 bg-[#F0F4FF] dark:bg-blue-900/30 rounded-xl flex items-center justify-center transition-colors">
                <User className="w-5 h-5 text-[#1d2089] dark:text-[#60a5fa] transition-colors" />
              </div>
              <div className="flex-1">
                <p className="text-xs text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('profile.employeeId') || 'Employee ID'}</p>
                <p className="text-[#232333] dark:text-dark-text font-medium transition-colors">{user.employeeId}</p>
              </div>
            </div>

            <div className="flex items-center gap-3 p-3 bg-[#F6F6F6] dark:bg-dark-surface rounded-xl transition-colors">
              <div className="w-10 h-10 bg-purple-50 dark:bg-purple-900/30 rounded-xl flex items-center justify-center transition-colors">
                <Building className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              </div>
              <div className="flex-1">
                <p className="text-xs text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('profile.department') || 'Department'}</p>
                <p className="text-[#232333] dark:text-dark-text font-medium transition-colors">{user.department}</p>
              </div>
            </div>

            <div className="flex items-center gap-3 p-3 bg-[#F6F6F6] dark:bg-dark-surface rounded-xl transition-colors">
              <div className="w-10 h-10 bg-green-50 dark:bg-green-900/30 rounded-xl flex items-center justify-center transition-colors">
                <Calendar className="w-5 h-5 text-green-600 dark:text-green-400" />
              </div>
              <div className="flex-1">
                <p className="text-xs text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('profile.lastLogin') || 'Last Login'}</p>
                <p className="text-[#232333] dark:text-dark-text font-medium transition-colors">
                  {new Date(user.lastLogin).toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-dark-bg-primary border border-[#E8E8E8] dark:border-dark-border rounded-2xl p-6 space-y-3 shadow-sm transition-colors">
          <h3 className="text-lg font-semibold text-[#232333] dark:text-dark-text mb-4 transition-colors">{t('profile.actions') || 'Account Actions'}</h3>

          <button
            onClick={() => setShowContactHR(true)}
            className="w-full flex items-center gap-3 px-4 py-3
                       bg-amber-50 dark:bg-amber-900/30
                       hover:bg-amber-100 dark:hover:bg-amber-800/40
                       border border-amber-200 dark:border-amber-500/40
                       rounded-xl transition-colors group"
          >
            <div className="w-10 h-10
                            bg-amber-100 dark:bg-amber-500/40
                            rounded-xl flex items-center justify-center
                            transition-colors">
              <Key className="w-5 h-5 text-amber-500 dark:text-amber-400" />
            </div>
            <div className="flex-1 text-left">
              <p className="text-[#232333] dark:text-dark-text font-medium transition-colors">
                {t('profile.changePassword') || 'Change Password'}
              </p>
              <p className="text-xs text-[#6E7680] dark:text-dark-text-muted transition-colors">
                {t('profile.updatePassword') || 'Update your account password'}
              </p>
            </div>
          </button>

          <button
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-4 py-3 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 border border-red-200 dark:border-red-800/50 rounded-xl transition-colors group"
          >
            <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-xl flex items-center justify-center transition-colors">
              <LogOut className="w-5 h-5 text-red-500" />
            </div>
            <div className="flex-1 text-left">
              <p className="text-red-600 dark:text-red-400 font-medium transition-colors">{t('common.logout')}</p>
              <p className="text-xs text-red-400 dark:text-red-500 transition-colors">{t('profile.signOut') || 'Sign out of your account'}</p>
            </div>
          </button>
        </div>

        <div className="text-center pt-4">
          <p className="text-xs text-[#9CA3AF] dark:text-dark-text-muted transition-colors">
            {t('app.version')}
          </p>
        </div>
      </div>

      {/* Centered popup with blurred background */}
      {showContactHR && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Background overlay */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setShowContactHR(false)}
          ></div>

          {/* Popup box */}
          <div className="relative z-10">
            <ContactHRPopup
              isOpen={showContactHR}
              onClose={() => setShowContactHR(false)}
              title={t('contactHR.changePasswordTitle')}
              message={t('contactHR.changePasswordMessage')}
            />
          </div>
        </div>
      )}
    </div>
  );
}