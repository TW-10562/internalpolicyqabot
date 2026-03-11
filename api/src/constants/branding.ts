const normalizeValue = (value: string | undefined, fallback: string): string => {
  const normalized = String(value || '').trim();
  return normalized || fallback;
};

const toEnglishPossessive = (value: string): string => (
  /s$/i.test(value) ? `${value}'` : `${value}'s`
);

export const APP_BRANDING = Object.freeze({
  appName: normalizeValue(process.env.APP_NAME, 'Thirdwave'),
  companyNameEn: normalizeValue(
    process.env.COMPANY_NAME_EN || process.env.APP_NAME,
    'Thirdwave',
  ),
  companyNameJa: normalizeValue(
    process.env.COMPANY_NAME_JA || process.env.COMPANY_NAME_EN || process.env.APP_NAME,
    'サードウェーブグループ',
  ),
});

export const getCompanyDisplayName = (language: 'ja' | 'en'): string => (
  language === 'ja' ? APP_BRANDING.companyNameJa : APP_BRANDING.companyNameEn
);

export const getCompanyPossessiveNameEn = (): string => (
  toEnglishPossessive(APP_BRANDING.companyNameEn)
);
