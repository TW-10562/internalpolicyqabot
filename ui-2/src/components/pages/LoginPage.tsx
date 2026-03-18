import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Globe, Moon, Sun } from 'lucide-react';
import { User as UserType } from '../../types';
import { useLang } from '../../context/LanguageContext';
import { useTheme } from '../../context/ThemeContext';
import { loginWithMicrosoft } from '../../api/auth';
import { getBrandDisplayName } from '../../lib/branding';
import BrandLogo from '../ui/BrandLogo';
import { beginMicrosoftLoginRedirect, completeMicrosoftLoginRedirect, hasMicrosoftSsoConfig, type MicrosoftUserInfo } from '../../auth/microsoftAuth';

interface LoginPageProps {
  onLogin: (user: UserType) => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const { t, toggleLang, lang } = useLang();
  const { theme, toggleTheme } = useTheme();
  const brandName = getBrandDisplayName(lang);

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const finishLogin = useCallback(async (accessToken: string, userInfo: MicrosoftUserInfo) => {
    const response = await loginWithMicrosoft(accessToken);
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
        employeeId: response.result.empId || response.result.email || userInfo.mail || userInfo.userPrincipalName,
        name: response.result.displayName || userInfo.displayName || response.result.email || userInfo.userPrincipalName,
        department: departmentName,
        departmentCode,
        role: isAdmin ? 'admin' : 'user',
        roleCode,
        lastLogin: new Date().toISOString(),
      });
    } else {
      setError(response.message || t('login.invalidCredentials'));
    }
  }, [onLogin, t]);

  // If we were redirected back from Microsoft, complete the flow automatically.
  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const result = await completeMicrosoftLoginRedirect();
        if (!result || !alive) return;

        setError('');
        setLoading(true);
        await finishLogin(result.accessToken, result.userInfo);
      } catch (err) {
        if (!alive) return;
        const message = err instanceof Error ? err.message : '';
        if (message.includes('access_denied')) {
          setError(t('login.ssoCancelled', undefined, 'Microsoft sign-in was cancelled.'));
        } else if (message.includes('sso_config_missing')) {
          setError(t('login.ssoConfigMissing', undefined, 'Microsoft SSO is not configured yet. Add the Azure values in ui-2/.env.'));
        } else {
          setError(t('login.connectionError'));
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [finishLogin, t]);

  const handleMicrosoftLogin = async () => {
    setError('');

    setLoading(true);
    console.log("Test")
    try {
      if (!hasMicrosoftSsoConfig()) {
        setError(t('login.ssoConfigMissing', undefined, 'Microsoft SSO is not configured yet. Add the Azure values in ui-2/.env.'));
        return;
      }

      // Redirect (no popup) is the most reliable across browsers and embedded environments.
      await beginMicrosoftLoginRedirect();
    } catch (err) {
      console.log(err)
      const message = err instanceof Error ? err.message : '';
      if (message.includes('popup_blocked')) {
        setError(t('login.popupBlocked', undefined, 'Popup was blocked. Please allow popups and try again.'));
      } else if (message.includes('user_cancelled')) {
        setError(t('login.ssoCancelled', undefined, 'Microsoft sign-in was cancelled.'));
      } else if (message.includes('sso_config_missing')) {
        setError(t('login.ssoConfigMissing', undefined, 'Microsoft SSO is not configured yet. Add the Azure values in ui-2/.env.'));
      } else {
        setError(t('login.connectionError'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mac-glass-page h-[100dvh] min-h-[100dvh] overflow-hidden bg-surface dark:bg-[#0f1724] flex flex-col transition-colors">

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
      <header className="w-full px-3 py-4 sm:px-4 lg:px-6 bg-surface dark:bg-[#0f1724] border-b border-default dark:border-dark-border" style={{ boxShadow: `inset 0 -1px 0 var(--c-section-divider)` }}>
        <div className="flex items-center justify-between gap-3">
          {/* Logo — pinned to left edge */}
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <BrandLogo
              alt={t('brand.logoAlt', { appName: brandName })}
              className="h-8 w-auto sm:h-9"
            />
            <h1 className="min-w-0 truncate text-base font-bold tracking-tight uppercase text-foreground dark:text-dark-text transition-colors sm:text-xl lg:text-2xl">
              {t('brand.name', { appName: brandName })}
            </h1>
          </div>

          {/* Icons — pinned to right edge */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <button
              onClick={toggleTheme}
              className="p-2 rounded-xl transition-colors sm:p-2.5"
            >
              {theme === 'light' ? (
                <Moon className="w-5 h-5 text-icon-muted" />
              ) : (
                <Sun className="w-5 h-5 text-dark-text-muted" />
              )}
            </button>

            <button
              onClick={toggleLang}
              className="p-2 rounded-xl hover:bg-surface-alt dark:hover:bg-dark-surface relative sm:p-2.5"
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
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:py-10">
        <div className="mx-auto flex min-h-full w-full max-w-md items-center">
          <div className="w-full bg-surface dark:bg-[#0f1724] rounded-2xl shadow-lg border border-default dark:border-dark-border p-6 sm:p-8">

            <div className="text-center mb-8">
              <BrandLogo
                alt={t('brand.logoAlt', { appName: brandName })}
                className="mx-auto mb-3 h-14"
              />
              <h2 className="text-2xl font-bold text-foreground dark:text-dark-text">
                {t('login.welcome')}
              </h2>
              <p className="text-muted dark:text-dark-text-muted">
                {t('login.signIn', { appName: brandName })}
              </p>
            </div>

            <div className="space-y-5">
              {error && (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3 flex gap-2">
                  <AlertCircle className="w-5 h-5 text-red-500" />
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}

              <p className="text-sm text-center text-muted dark:text-dark-text-muted">
                {t('login.microsoftSignInHint', undefined, 'Use your Microsoft work account to continue.')}
              </p>

              <button
                type="button"
                onClick={handleMicrosoftLogin}
                disabled={loading}
                className="w-full py-3 btn-primary rounded-xl font-semibold disabled:opacity-50"
              >
                {loading ? t('common.loading') : t('login.microsoftSignInButton')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
