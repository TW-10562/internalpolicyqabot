import { useEffect, useMemo, useState } from 'react';
import { User as UserType } from '../../types';
import request from '../../api/request';
import { useLang } from '../../context/LanguageContext';

type FAQItem = {
  key: string;
  question: string;
  answer: string;
  count: number;
  lastAsked: number;
  departmentCode?: string;
  sourceCount?: number;
  qualityLabel?: 'VERIFIED' | 'RELAXED';
};

const MAX_FAQ_ITEMS = 10;
const MIN_FREQUENT_COUNT = 3;

const normalizeQuestion = (q: string) =>
  String(q || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export default function FAQPage({ user }: { history: unknown[]; user?: UserType }) {
  const { t } = useLang();
  const [remoteItems, setRemoteItems] = useState<FAQItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [minCountUsed, setMinCountUsed] = useState<number>(MIN_FREQUENT_COUNT);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState<'ALL' | 'HR' | 'GA' | 'ACC'>('ALL');
  const [sortMode, setSortMode] = useState<'freq' | 'recent'>('freq');
  const toDepartmentLabel = (code?: string) => {
    const v = String(code || '').toUpperCase();
    if (v === 'HR') return t('common.departments.hr');
    if (v === 'GA') return t('common.departments.ga');
    if (v === 'ACC') return t('common.departments.acc');
    if (v === 'OTHER') return t('common.departments.other');
    if (!v) return t('common.departments.unknown');
    return v;
  };
  const toDepartmentFilterLabel = (code: 'ALL' | 'HR' | 'GA' | 'ACC') => {
    if (code === 'ALL') return t('faqPage.allDepartments');
    return toDepartmentLabel(code);
  };
  const departmentFilterOptions = useMemo(() => {
    if (user?.roleCode === 'USER') return ['ALL', 'GA', 'ACC'] as const;
    return ['ALL', 'HR', 'GA', 'ACC'] as const;
  }, [user?.roleCode]);

  useEffect(() => {
    if (!departmentFilterOptions.includes(deptFilter as any)) {
      setDeptFilter('ALL');
    }
  }, [departmentFilterOptions, deptFilter]);

  useEffect(() => {
    let mounted = true;
    const fetchFaq = async (minCount: number) => {
      return request('/api/faq', {
        method: 'GET',
        params: { limit: MAX_FAQ_ITEMS, minCount },
      });
    };

    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await fetchFaq(MIN_FREQUENT_COUNT);
        if (!mounted) return;
        if (data?.ok === true && Array.isArray(data.data?.items)) {
          const normalizeItems = (items: any[]) =>
            items.map((it) => ({
              ...it,
              key: normalizeQuestion(it.question || ''),
              qualityLabel: (it.qualityLabel === 'RELAXED' ? 'RELAXED' : 'VERIFIED') as const,
              sourceCount: Number(it.sourceCount || 0),
            }));
          setRemoteItems(normalizeItems(data.data.items));
          setMinCountUsed(MIN_FREQUENT_COUNT);
        } else {
          setRemoteItems(null);
          setLoadError(data?.error?.message || data?.message || t('faqPage.loadFailed'));
        }
      } catch (err: any) {
        if (!mounted) return;
        setRemoteItems(null);
        setLoadError(err?.message || t('faqPage.loadFailed'));
      } finally {
        if (mounted) setLoading(false);
      }
    };
    load();
    return () => {
      mounted = false;
    };
  }, [user?.roleCode, user?.department]);

  const baseItems = useMemo(() => (Array.isArray(remoteItems) ? remoteItems : []), [remoteItems]);
  const frequent = baseItems.filter((i) => i.count >= MIN_FREQUENT_COUNT).slice(0, MAX_FAQ_ITEMS);
  const displayItems = frequent.length ? frequent : baseItems.slice(0, MAX_FAQ_ITEMS);
  const normalizedQuery = normalizeQuestion(query);
  const filtered = displayItems.filter((item) => {
    const dept = String(item.departmentCode || '').toUpperCase();
    if (deptFilter !== 'ALL' && dept !== deptFilter) return false;
    if (!normalizedQuery) return true;
    const hay = `${item.question}\n${item.answer}`.toLowerCase();
    return hay.includes(normalizedQuery);
  });
  const sorted = [...filtered].sort((a, b) => {
    if (sortMode === 'recent') return b.lastAsked - a.lastAsked;
    return b.count - a.count || b.lastAsked - a.lastAsked;
  });
  const verifiedCount = displayItems.filter((i) => i.qualityLabel === 'VERIFIED').length;
  const subtitle = displayItems.length
    ? t('faqPage.subtitleWithStats', { minCount: minCountUsed, verifiedCount, totalCount: displayItems.length })
    : t('faqPage.noItems');

  return (
    <div className="h-full flex flex-col gap-4 p-5 overflow-y-auto faq-shell">
      <div className="faq-hero">
        <div>
          <h2 className="faq-title app-page-title">{t('nav.faq')}</h2>
          <p className="faq-subtitle">{subtitle}</p>
        </div>
        <div className="faq-limit">{t('faqPage.limitTop', { limit: MAX_FAQ_ITEMS })}</div>
      </div>

      <div className="faq-controls">
        <div className="faq-search">
          <label className="faq-label">{t('common.search')}</label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('faqPage.searchPlaceholder')}
            className="faq-input"
          />
        </div>
        <div className="faq-filters">
          <div className="faq-filter-group">
            <span className="faq-label">{t('profile.department')}</span>
            <div className="faq-pill-row">
              {departmentFilterOptions.map((dept) => (
                <button
                  key={dept}
                  type="button"
                  onClick={() => setDeptFilter(dept)}
                  className={`faq-pill ${deptFilter === dept ? 'active' : ''}`}
                >
                  {toDepartmentFilterLabel(dept)}
                </button>
              ))}
            </div>
          </div>
          <div className="faq-filter-group">
            <span className="faq-label">{t('faqPage.sort')}</span>
            <div className="faq-pill-row">
              <button
                type="button"
                onClick={() => setSortMode('freq')}
                className={`faq-pill ${sortMode === 'freq' ? 'active' : ''}`}
              >
                {t('faqPage.mostFrequent')}
              </button>
              <button
                type="button"
                onClick={() => setSortMode('recent')}
                className={`faq-pill ${sortMode === 'recent' ? 'active' : ''}`}
              >
                {t('faqPage.mostRecent')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {loading && (
        <div className="faq-state">
          {t('faqPage.loading')}
        </div>
      )}
      {!loading && loadError && (
        <div className="faq-state">
          {loadError}
        </div>
      )}
      {!loading && !loadError && displayItems.length === 0 ? (
        <div className="faq-state">
          {t('faqPage.emptyHint')}
        </div>
      ) : (
        <div className="grid gap-3">
          {sorted.map((item, idx) => (
            <div
              key={item.key}
              className={`faq-card ${openKey === item.key ? 'open' : ''}`}
            >
              <button
                type="button"
                onClick={() => setOpenKey((prev) => (prev === item.key ? null : item.key))}
                className="faq-question"
              >
                <div className="faq-question-row">
                  <div className="faq-question-text">
                    <span className="faq-rank">{String(idx + 1).padStart(2, '0')}</span>
                    <span>{item.question}</span>
                  </div>
                  <div className="faq-meta">
                    {item.departmentCode && (
                      <span className="faq-dept">
                        {toDepartmentLabel(item.departmentCode)}
                      </span>
                    )}
                    <span className="faq-dept">
                      {item.qualityLabel === 'VERIFIED' ? t('faqPage.verified') : t('faqPage.modelOnly')}
                    </span>
                    <span className="faq-count">{item.count}x</span>
                    <span className="faq-toggle">{openKey === item.key ? t('faqPage.hide') : t('faqPage.show')}</span>
                  </div>
                </div>
              </button>
              {openKey === item.key && (
                <div className="faq-answer">
                  {item.answer}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
