const normalizeValue = (value: string | undefined, fallback: string): string => {
  const normalized = String(value || '').trim();
  return normalized || fallback;
};

export const APP_BRANDING = Object.freeze({
  appName: normalizeValue(import.meta.env.VITE_APP_NAME, 'Thirdwave'),
  companyNameEn: normalizeValue(
    import.meta.env.VITE_COMPANY_NAME_EN || import.meta.env.VITE_APP_NAME,
    'Thirdwave',
  ),
  companyNameJa: normalizeValue(
    import.meta.env.VITE_COMPANY_NAME_JA || import.meta.env.VITE_COMPANY_NAME_EN || import.meta.env.VITE_APP_NAME,
    'サードウェーブグループ',
  ),
});

export const getBrandDisplayName = (language: 'ja' | 'en'): string => (
  language === 'ja' ? APP_BRANDING.companyNameJa : APP_BRANDING.companyNameEn
);
