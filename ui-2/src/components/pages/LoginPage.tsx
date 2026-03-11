import { useState } from 'react';
import { Lock, User, AlertCircle, Globe, Eye, EyeOff, Moon, Sun } from 'lucide-react';
import { User as UserType } from '../../types';
import { useLang } from '../../context/LanguageContext';
import { useTheme } from '../../context/ThemeContext';
import { login } from '../../api/auth';
import ContactHRPopup from '../modals/ContactHRPopup';
import BrandLogo from '../ui/BrandLogo';

interface LoginPageProps {
  onLogin: (user: UserType) => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const { t, toggleLang, lang } = useLang();
  const { theme, toggleTheme } = useTheme();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!username || !password) {
      setError(t('login.pleaseLogin'));
      return;
    }

    setLoading(true);

    try {
      const response = await login({ userName: username, password });
      if (response.code === 200 && response.result?.token) {
        const roleCode = response.result.roleCode || 'USER';
        const departmentCode = response.result.departmentCode || 'HR';
        const isAdmin =
          roleCode === 'SUPER_ADMIN' ||
          roleCode === 'HR_ADMIN' ||
          roleCode === 'GA_ADMIN' ||
          roleCode === 'ACC_ADMIN';
        const departmentName =
          departmentCode === 'HR'
            ? 'Human Resources'
            : departmentCode === 'GA'
              ? 'General Affairs'
              : departmentCode === 'ACC'
                ? 'Accounts'
                : 'General';

        onLogin({
          employeeId: response.result.empId || username,
          name: response.result.empId || username,
          department: departmentName,
          departmentCode,
          role: isAdmin ? 'admin' : 'user',
          roleCode,
          lastLogin: new Date().toISOString(),
        });
      } else {
        setError(response.message || t('login.invalidCredentials'));
      }
    } catch {
      setError(t('login.connectionError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mac-glass-page h-screen overflow-hidden bg-surface dark:bg-[#0f1724] flex flex-col transition-colors">

      {/* ================= AUTOFILL FIXES ================= */}
      <style>{`
        /* ---------- DARK THEME ONLY ---------- */
        html.dark input:-webkit-autofill,
        html.dark input:-webkit-autofill:hover,
        html.dark input:-webkit-autofill:focus,
        html.dark input:-webkit-autofill:active {
          -webkit-box-shadow: 0 0 0 1000px #54575a inset !important;
          -webkit-text-fill-color: #e5e7eb !important;
          caret-color: #e5e7eb;
          transition: background-color 9999s ease-in-out 0s;
        }

        html.dark .input-icon-absolute {
          z-index: 10;
        }

        html.dark .input-icon-absolute svg {
          color: #9ca3af;
        }

        /* ---------- LIGHT THEME (NO COLOR CHANGE) ---------- */
        html:not(.dark) input:-webkit-autofill,
        html:not(.dark) input:-webkit-autofill:hover,
        html:not(.dark) input:-webkit-autofill:focus,
        html:not(.dark) input:-webkit-autofill:active {
          -webkit-box-shadow: 0 0 0 1000px #ffffff inset;
          -webkit-text-fill-color: inherit;
          caret-color: inherit;
          transition: background-color 9999s ease-in-out 0s;
        }
      `}</style>

      {/* ================= HEADER ================= */}
      <header className="w-full py-4 px-6 bg-surface dark:bg-[#0f1724] border-b border-default dark:border-dark-border" style={{ boxShadow: `inset 0 -1px 0 var(--c-section-divider)` }}>
        <div className="flex items-center justify-between">
          {/* Logo — pinned to left edge */}
          <div className="flex items-center gap-3">
            <BrandLogo alt="Thirdwave Logo" className="h-9 w-auto" />
            <h1 className="text-2xl font-bold tracking-tight uppercase text-foreground dark:text-dark-text transition-colors">
              {t('brand.name')}
            </h1>
          </div>

          {/* Icons — pinned to right edge */}
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="p-2.5 rounded-xl transition-colors"
            >
              {theme === 'light' ? (
                <Moon className="w-5 h-5 text-icon-muted" />
              ) : (
                <Sun className="w-5 h-5 text-dark-text-muted" />
              )}
            </button>

            <button
              onClick={toggleLang}
              className="p-2.5 rounded-xl hover:bg-surface-alt dark:hover:bg-dark-surface relative"
            >
              <Globe className="w-5 h-5 text-icon-muted dark:text-dark-text-muted" />
              <span
                className="absolute -bottom-1 -right-1 w-5 h-5 text-white text-[10px] font-bold rounded-full flex items-center justify-center"
                style={{ backgroundColor: theme === 'light' ? '#1e228a' : '#00ccff4d' }}
              >
                {lang === 'ja' ? 'JP' : 'EN'}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* ================= LOGIN CARD ================= */}
      <div className="flex-1 flex items-center justify-center px-4 overflow-hidden">
        <div className="w-full max-w-md">
          <div className="bg-surface dark:bg-[#0f1724] rounded-2xl shadow-lg border border-default dark:border-dark-border p-8">

            <div className={`text-center ${showForgotPassword ? 'mb-3' : 'mb-8'}`}>
              <BrandLogo
                alt="Thirdwave Logo"
                className={`mx-auto mb-3 ${showForgotPassword ? 'h-10' : 'h-14'}`}
              />
              <h2 className="text-2xl font-bold text-foreground dark:text-dark-text">
                {t('login.welcome')}
              </h2>
              <p className="text-muted dark:text-dark-text-muted">
                {t('login.signIn')}
              </p>
            </div>

            {showForgotPassword ? (
              <>
                <ContactHRPopup
                  isOpen
                  onClose={() => setShowForgotPassword(false)}
                  title={t('login.forgotPasswordTitle')}
                  message={t('login.forgotPasswordMessage')}
                />

                <button
  onClick={() => setShowForgotPassword(false)}
  className="w-full mt-2 mb-1 py-3 bg-[#f0f4ff] dark:bg-[#0f1724] hover:bg-[#e4eaff] dark:hover:bg-[#1a1a2e] text-foreground dark:text-white transition-colors font-medium border border-[#d0d5e8] dark:border-gray-600 rounded-xl"
>
                  {t('login.backToLogin')}
                </button>
              </>
            ) : (
              <form onSubmit={handleLogin} className="space-y-5">
                {error && (
                  <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3 flex gap-2">
                    <AlertCircle className="w-5 h-5 text-red-500" />
                    <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                  </div>
                )}

                {/* Username */}
                <div>
                  <label className="block mb-2 text-foreground dark:text-dark-text">
                    {t('login.username')}
                  </label>
                  <div className="relative">
                    <div className="input-icon-absolute pointer-events-none">
                      <User className="w-5 h-5" />
                    </div>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="w-full input-with-icon py-3 bg-surface dark:bg-[#0f1724] border rounded-xl text-foreground dark:text-dark-text"
                    />
                  </div>
                </div>

                {/* Password */}
                <div>
                  <label className="block mb-2 text-foreground dark:text-dark-text">
                    {t('login.password')}
                  </label>
                  <div className="relative">
                    <div className="input-icon-absolute pointer-events-none">
                      <Lock className="w-5 h-5" />
                    </div>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full input-with-icon py-3 pr-12 bg-surface dark:bg-[#0f1724] border rounded-xl text-foreground dark:text-dark-text"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((p) => !p)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-icon-muted dark:text-dark-text-muted"
                    >
                      {showPassword ? <EyeOff /> : <Eye />}
                    </button>
                  </div>
                </div>

                {/* Forgot password */}
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setShowForgotPassword(true)}
                    className="text-sm text-muted dark:text-dark-text-muted hover:text-accent dark:hover:text-dark-accent-blue font-medium transition-colors"
                  >
                    {t('login.forgotPassword')}
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 btn-primary rounded-xl font-semibold disabled:opacity-50"
                >
                  {loading ? t('common.loading') : t('login.signInButton')}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
