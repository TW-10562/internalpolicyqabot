/**
 * Analytics Dashboard – Professional (Clean KPIs)
 */
import { useEffect, useState } from 'react';
import {
  Clock,
  MessageSquare,
  Users,
  Files,
  RefreshCw,
  PieChart,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { formatDateTimeJP } from '../../lib/dateTime';
import request from '../../api/request';
import { User as UserType } from '../../types';

interface FeedbackItem {
  key: string;
  value: number;
  widthPct: number;
}

interface AnalyticsData {
  totalQueries: number;
  avgResponseTime: number;
  activeUsers: number;
  successfulResponses: number;
  responseRate: number;
  failedRequests: number;
  errorRate: number;
  feedbackChart: FeedbackItem[];
  uploadedDocuments: {
    total: number;
    byDepartment: {
      HR: number;
      GA: number;
      ACC: number;
      OTHER: number;
    };
  };
  contentSafety: {
    totalFlagged: number;
    categoryCounts: Record<string, number>;
    incidents: Array<{
      id: number;
      createdAt: string;
      userName: string;
      departmentCode: string;
      userProfile: {
        userId: number;
        employeeId: string;
        firstName: string;
        lastName: string;
        userJobRole: string;
        areaOfWork: string;
      } | null;
      taskOutputId: number | null;
      queryText: string;
      answerText: string;
      score: number;
      reasons: Array<{
        category: string;
        reason: string;
        matchedText: string;
        severity: number;
        source: string;
        detector?: string;
        confidence?: number;
      }>;
    }>;
  };
}

interface AnalyticsApiResponse {
  code?: number | string;
  message?: string;
  result?: {
    totalQueries?: number;
    avgResponseTimeMs?: number;
    activeUsers?: number;
    successfulResponses?: number;
    responseRate?: number;
    failedRequests?: number;
    errorRate?: number;
    feedback?: {
      positive?: number;
      negative?: number;
      positivePct?: number;
      negativePct?: number;
    };
    uploadedDocuments?: {
      total?: number;
      byDepartment?: {
        HR?: number;
        GA?: number;
        ACC?: number;
        OTHER?: number;
      };
    };
    contentSafety?: AnalyticsData['contentSafety'];
  };
}

type FAQItem = {
  question: string;
  answer: string;
  count: number;
  departmentCode?: string;
  qualityLabel?: 'VERIFIED' | 'RELAXED';
};

interface AnalyticsDashboardProps {
  user?: UserType;
  showHeader?: boolean;
}

type TimeRange = '7d' | '30d' | '90d';

const EMPTY_ANALYTICS_DATA: AnalyticsData = {
  totalQueries: 0,
  activeUsers: 0,
  avgResponseTime: 0,
  successfulResponses: 0,
  responseRate: 0,
  failedRequests: 0,
  errorRate: 0,
  feedbackChart: [
    { key: 'analytics.feedback.positive', value: 0, widthPct: 0 },
    { key: 'analytics.feedback.negative', value: 0, widthPct: 0 },
  ],
  uploadedDocuments: {
    total: 0,
    byDepartment: { HR: 0, GA: 0, ACC: 0, OTHER: 0 },
  },
  contentSafety: {
    totalFlagged: 0,
    categoryCounts: {},
    incidents: [],
  },
};

const formatCategoryLabel = (value: string) =>
  String(value || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const formatReasonSource = (value: string, t: (key: string) => string) =>
  String(value || '').toLowerCase() === 'answer'
    ? t('analytics.answerSource')
    : t('analytics.querySource');

const formatDetectorLabel = (value: string, t: (key: string) => string) =>
  String(value || '').toLowerCase() === 'vllm'
    ? t('analytics.vllmDetector')
    : t('analytics.rulesDetector');

const getScopeTagKey = (user?: UserType) => {
  if (user?.roleCode === 'SUPER_ADMIN') return 'adminScope.badge.superAdmin';
  if (user?.roleCode === 'HR_ADMIN') return 'adminScope.badge.hrAdmin';
  if (user?.roleCode === 'GA_ADMIN') return 'adminScope.badge.gaAdmin';
  if (user?.roleCode === 'ACC_ADMIN') return 'adminScope.badge.accAdmin';
  // Fallback for sessions where roleCode is missing but admin department is known.
  if (user?.role === 'admin' && user?.departmentCode === 'HR') return 'adminScope.badge.hrAdmin';
  if (user?.role === 'admin' && user?.departmentCode === 'GA') return 'adminScope.badge.gaAdmin';
  if (user?.role === 'admin' && user?.departmentCode === 'ACC') return 'adminScope.badge.accAdmin';
  return '';
};

export default function AnalyticsDashboard({ user, showHeader = true }: AnalyticsDashboardProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [faqItems, setFaqItems] = useState<FAQItem[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [loadError, setLoadError] = useState('');
  const { t, lang } = useLang();

  useEffect(() => {
    void loadAnalytics();
  }, [timeRange]);

  const loadAnalytics = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [analyticsResponse, faqResponse] = await Promise.all([
        request<AnalyticsApiResponse>('/api/admin/analytics', {
          method: 'GET',
          params: { range: timeRange },
        }),
        request('/api/faq', {
          method: 'GET',
          params: { limit: 8, minCount: 1 },
        }),
      ]);
      if (Number(analyticsResponse.code) !== 200) {
        throw new Error(String(analyticsResponse.message || t('analytics.loadFailed')));
      }

      const result = analyticsResponse.result || {};
      const avgResponseTimeMs = Number(result.avgResponseTimeMs || 0);

      setData({
        totalQueries: Number(result.totalQueries || 0),
        activeUsers: Number(result.activeUsers || 0),
        avgResponseTime: Number((avgResponseTimeMs / 1000).toFixed(1)),
        successfulResponses: Number(result.successfulResponses || 0),
        responseRate: Number(result.responseRate || 0),
        failedRequests: Number(result.failedRequests || 0),
        errorRate: Number(result.errorRate || 0),
        feedbackChart: [
          {
            key: 'analytics.feedback.positive',
            value: Number(result.feedback?.positive || 0),
            widthPct: Number(result.feedback?.positivePct || 0),
          },
          {
            key: 'analytics.feedback.negative',
            value: Number(result.feedback?.negative || 0),
            widthPct: Number(result.feedback?.negativePct || 0),
          },
        ],
        uploadedDocuments: {
          total: Number(result.uploadedDocuments?.total || 0),
          byDepartment: {
            HR: Number(result.uploadedDocuments?.byDepartment?.HR || 0),
            GA: Number(result.uploadedDocuments?.byDepartment?.GA || 0),
            ACC: Number(result.uploadedDocuments?.byDepartment?.ACC || 0),
            OTHER: Number(result.uploadedDocuments?.byDepartment?.OTHER || 0),
          },
        },
        contentSafety: {
          totalFlagged: Number(result.contentSafety?.totalFlagged || 0),
          categoryCounts: result.contentSafety?.categoryCounts || {},
          incidents: Array.isArray(result.contentSafety?.incidents) ? result.contentSafety.incidents : [],
        },
      });
      setLastUpdated(new Date().toISOString());

      const faqRes: any = faqResponse;
      if (faqRes?.ok === true && Array.isArray(faqRes?.data?.items)) {
        setFaqItems(faqRes.data.items);
      } else {
        setFaqItems([]);
      }
    } catch (error) {
      console.error('[AnalyticsDashboard] Failed to load analytics:', error);
      setLoadError(error instanceof Error ? error.message : t('analytics.loadFailed'));
      setData((current) => current ?? EMPTY_ANALYTICS_DATA);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <RefreshCw className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  if (!data) return null;

  const categoryEntries = Object.entries(data.contentSafety.categoryCounts || {}).sort((a, b) => b[1] - a[1]);
  const lastUpdatedLabel = lastUpdated ? formatDateTimeJP(lastUpdated, '') : '';

  return (
    <div className="space-y-4 mac-tab-animate">
      {/* HEADER */}
      {showHeader && (
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="app-page-title transition-colors">{t('analytics.title')}</h2>
              {getScopeTagKey(user) ? (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200 dark:border-blue-800/40">
                  {t('adminScope.currentRole')}: {t(getScopeTagKey(user))}
                </span>
              ) : null}
            </div>
            {lastUpdatedLabel ? (
              <p className="text-xs text-[#6E7680] dark:text-dark-text-muted transition-colors">
                {t('analytics.lastUpdated')}: {lastUpdatedLabel}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(['7d', '30d', '90d'] as TimeRange[]).map((range) => (
              <button
                key={range}
                type="button"
                onClick={() => setTimeRange(range)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  timeRange === range
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-dark-surface text-[#232333] dark:text-dark-text border-[#E8E8E8] dark:border-dark-border'
                }`}
              >
                {range.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void loadAnalytics()}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border border-[#E8E8E8] dark:border-dark-border bg-white dark:bg-dark-surface text-[#232333] dark:text-dark-text transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              {t('analytics.refresh')}
            </button>
          </div>
        </div>
      )}
      {loadError ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          {loadError}
        </div>
      ) : null}

      {/* TOP SUMMARY - Responsive Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <CompactMetric
            title={t('analytics.totalQueries')}
            value={data.totalQueries}
            icon={MessageSquare}
            color="blue"
          />
          <CompactMetric
            title={t('analytics.activeUsers')}
            value={data.activeUsers}
            icon={Users}
            color="green"
          />
          <CompactMetric
            title={t('analytics.avgResponseTime')}
            value={`${data.avgResponseTime}s`}
            icon={Clock}
            color="yellow"
          />
          <DocsSummaryCard
            total={data.uploadedDocuments.total}
            hr={data.uploadedDocuments.byDepartment.HR}
            ga={data.uploadedDocuments.byDepartment.GA}
            acc={data.uploadedDocuments.byDepartment.ACC}
            other={data.uploadedDocuments.byDepartment.OTHER}
          />
      </div>

      {/* GRAPHS / METRICS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* FEEDBACK DISTRIBUTION */}
        <div className="bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-2xl p-5 shadow-sm transition-colors">
          <h3 className="text-[#232333] dark:text-dark-text font-semibold mb-4 flex items-center gap-2 transition-colors">
            <PieChart className="w-5 h-5 text-accent transition-colors icon-current" />{t('analytics.feedbackQuality')}
          </h3>

          <div className="space-y-4">
            {data.feedbackChart.map((f, i) => {
              const label = t(f.key);
              const isPositive = f.key.includes('positive');
              return (
                <div key={i}>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-[#6E7680]">{label}</span>
                    <span className="text-[#232333] font-medium">{f.value}</span>
                  </div>
                  <div className="h-2.5 bg-[#F6F6F6] dark:bg-dark-border rounded-full transition-colors">
                    <div
                      className={`h-2.5 rounded-full ${isPositive ? 'bg-[#059669]' : 'bg-[#DC2626]'}`}
                      style={{ width: `${f.widthPct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ERROR / FAILURE METRIC */}
        <div className="bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-2xl p-5 shadow-sm transition-colors">
          <h3 className="text-[#232333] dark:text-dark-text font-semibold mb-4 flex items-center gap-2 transition-colors">
            <AlertTriangle className="w-5 h-5 text-amber-500" />{t('analytics.errorFailureRate')}
          </h3>

          <div className="space-y-3">
            <div className="flex justify-between items-center px-4 py-5 bg-[#F6F6F6] dark:bg-dark-border rounded-xl transition-colors">
              <span className="text-sm text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('analytics.failedRequests')}</span>
              <span className="text-[#232333] dark:text-dark-text font-semibold text-lg leading-none transition-colors">{data.failedRequests}</span>
            </div>

            <div className="flex justify-between items-center px-4 py-5 bg-[#F6F6F6] dark:bg-dark-border rounded-xl transition-colors">
              <span className="text-sm text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('analytics.errorRate')}</span>
              <span className="text-[#232333] dark:text-dark-text font-semibold text-lg leading-none transition-colors">{data.errorRate}%</span>
            </div>

            <div className="border-t border-[#E8E8E8] dark:border-dark-border pt-3 transition-colors">
              <p className="text-xs text-[#6E7680] dark:text-dark-text-muted transition-colors">
                {t('analytics.errorRateDescription')}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* CONTENT SAFETY + FAQ */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-2xl p-5 shadow-sm transition-colors">
          <h3 className="text-[#232333] dark:text-dark-text font-semibold mb-4 flex items-center gap-2 transition-colors">
            <div className="p-1.5 bg-amber-100 dark:bg-amber-900/30 rounded-lg transition-colors">
              <ShieldAlert className="w-4 h-4 text-amber-600" />
            </div>
            {t('analytics.flaggedContentTitle')}
          </h3>
          <div className="mb-4 flex items-center justify-between text-sm">
            <span className="text-[#6E7680] dark:text-dark-text-muted transition-colors">
              {t('analytics.totalFlaggedIncidents')}
            </span>
            <span className="font-semibold text-[#232333] dark:text-dark-text transition-colors">
              {data.contentSafety.totalFlagged}
            </span>
          </div>
          {categoryEntries.length > 0 ? (
            <div className="mb-4 flex flex-wrap gap-2">
              {categoryEntries.map(([category, count]) => (
                <span
                  key={category}
                  className="inline-flex items-center rounded-full border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-200"
                >
                  {formatCategoryLabel(category)}: {count}
                </span>
              ))}
            </div>
          ) : null}

          {data.contentSafety.incidents.length === 0 ? (
            <p className="text-[#6E7680] dark:text-dark-text-muted text-sm transition-colors">
              {t('analytics.noFlaggedIncidents')}
            </p>
          ) : (
            <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
              {data.contentSafety.incidents.map((incident) => {
                const user = incident.userProfile;
                const sortedReasons = [...incident.reasons].sort((a, b) => b.severity - a.severity);
                return (
                  <div
                    key={incident.id}
                    className="border border-[#E8E8E8] dark:border-dark-border rounded-xl p-3 bg-[#FAFAFA] dark:bg-dark-border/40"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-[#232333] dark:text-dark-text">
                        {incident.userName} · {incident.departmentCode}
                      </span>
                      <span className="text-xs text-[#6E7680] dark:text-dark-text-muted">
                        {formatDateTimeJP(incident.createdAt)}
                      </span>
                    </div>
                    {user ? (
                      <div className="text-xs mb-2 text-[#6E7680] dark:text-dark-text-muted grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
                        <div><span className="font-semibold">{t('analytics.firstName')}:</span> {user.firstName || '-'}</div>
                        <div><span className="font-semibold">{t('analytics.lastName')}:</span> {user.lastName || '-'}</div>
                        <div><span className="font-semibold">{t('analytics.employeeId')}:</span> {user.employeeId || '-'}</div>
                        <div><span className="font-semibold">{t('analytics.userJobRole')}:</span> {user.userJobRole || '-'}</div>
                        <div><span className="font-semibold">{t('analytics.areaOfWork')}:</span> {user.areaOfWork || '-'}</div>
                      </div>
                    ) : null}
                    <div className="text-xs mb-2 text-[#6E7680] dark:text-dark-text-muted">
                      {t('analytics.score')}: {incident.score} {incident.taskOutputId ? `· ${t('analytics.output')} #${incident.taskOutputId}` : ''}
                    </div>
                    {sortedReasons.length > 0 ? (
                      <div className="mb-3">
                        <div className="text-sm font-semibold text-[#232333] dark:text-dark-text mb-2">
                          {t('analytics.flagReason')}
                        </div>
                        <div className="space-y-2">
                          {sortedReasons.map((reason, index) => (
                            <div
                              key={`${incident.id}-${reason.category}-${reason.source}-${index}`}
                              className="rounded-lg border border-[#E8E8E8] dark:border-dark-border bg-white/80 dark:bg-dark-border/60 px-3 py-2"
                            >
                              <div className="flex flex-wrap gap-2 mb-1">
                                <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-200">
                                  {formatCategoryLabel(reason.category)}
                                </span>
                                <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200">
                                  {formatReasonSource(reason.source, t)}
                                </span>
                                <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200">
                                  {formatDetectorLabel(String(reason.detector || 'rules'), t)}
                                </span>
                                <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200">
                                  {t('analytics.severity')}: {reason.severity}
                                </span>
                                {typeof reason.confidence === 'number' && reason.confidence > 0 ? (
                                  <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200">
                                    {t('analytics.confidence')}: {(reason.confidence * 100).toFixed(0)}%
                                  </span>
                                ) : null}
                              </div>
                              <div className="text-sm text-[#232333] dark:text-dark-text">
                                {reason.reason}
                              </div>
                              {reason.matchedText ? (
                                <div className="text-xs mt-1 text-[#6E7680] dark:text-dark-text-muted">
                                  <span className="font-semibold">{t('analytics.matchedText')}:</span> "{reason.matchedText}"
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="text-xs text-[#6E7680] dark:text-dark-text-muted">
                      <div className="mb-1">
                        <span className="font-semibold">{t('analytics.flaggedQuery')}:</span> {incident.queryText || '-'}
                      </div>
                      <div>
                        <span className="font-semibold">{t('analytics.flaggedAnswer')}:</span> {(incident.answerText || '-').slice(0, 220)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-2xl p-5 shadow-sm transition-colors">
          <h3 className="text-[#232333] dark:text-dark-text font-semibold mb-4 flex items-center gap-2 transition-colors">
            <div className="p-1.5 bg-blue-100 dark:bg-blue-900/30 rounded-lg transition-colors">
              <MessageSquare className="w-4 h-4 text-blue-600" />
            </div>
            {t('nav.faq')}
          </h3>
          {faqItems.length === 0 ? (
            <p className="text-[#6E7680] dark:text-dark-text-muted text-sm transition-colors">
              {t('faqPage.noItems')}
            </p>
          ) : (
            <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
              {faqItems.map((item, index) => (
                <div
                  key={`${item.question}-${index}`}
                  className="border border-[#E8E8E8] dark:border-dark-border rounded-xl p-3 bg-[#FAFAFA] dark:bg-dark-border/40"
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-sm font-medium text-[#232333] dark:text-dark-text line-clamp-2">
                      {item.question}
                    </span>
                    <span className="text-xs text-[#6E7680] dark:text-dark-text-muted whitespace-nowrap">
                      {item.count}x
                    </span>
                  </div>
                  <div className="text-xs text-[#6E7680] dark:text-dark-text-muted flex items-center gap-2 mb-2">
                    <span>{String(item.departmentCode || 'N/A').toUpperCase()}</span>
                    <span>•</span>
                    <span>{item.qualityLabel === 'VERIFIED' ? t('faqPage.verified') : t('faqPage.modelOnly')}</span>
                  </div>
                  <p className="text-xs text-[#6E7680] dark:text-dark-text-muted line-clamp-3">
                    {item.answer}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- KPI CARD ---------------- */
function CompactMetric({
  title,
  value,
  icon: Icon,
  color,
}: {
  title: string;
  value: string | number;
  icon?: any;
  color: 'blue' | 'green' | 'yellow';
}) {
  const iconBg: any = {
    blue: 'bg-blue-50 dark:bg-blue-900/25 transition-colors',
    green: 'bg-green-50 dark:bg-green-900/25 transition-colors',
    yellow: 'bg-amber-50 dark:bg-amber-900/25 transition-colors',
  };

  const iconColor: any = {
    blue: 'text-blue-600 dark:text-blue-300 icon-current transition-colors',
    green: 'text-green-600 dark:text-green-300 icon-current transition-colors',
    yellow: 'text-amber-500 dark:text-amber-300 icon-current transition-colors',
  };

  return (
    <div className="bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-xl p-4 shadow-sm hover:shadow-md transition-all w-full min-h-[88px]">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[#6E7680] dark:text-dark-text-muted text-sm mb-1 transition-colors">{title}</p>
          <p className="text-lg md:text-xl font-bold text-[#232333] dark:text-dark-text transition-colors break-words">{value}</p>
        </div>
        {Icon ? (
          <div className={`p-2 rounded-lg ${iconBg[color]}`}>
            <Icon className={`w-5 h-5 ${iconColor[color]}`} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DocsSummaryCard({
  total,
  hr,
  ga,
  acc,
  other,
}: {
  total: number;
  hr: number;
  ga: number;
  acc: number;
  other: number;
}) {
  const { t } = useLang();
  const departmentBreakdown = `${t('common.departments.hr')}: ${hr} | ${t('common.departments.ga')}: ${ga} | ${t('common.departments.acc')}: ${acc} | ${t('common.departments.other')}: ${other}`;
  return (
    <div className="bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-xl p-4 shadow-sm hover:shadow-md transition-all w-full min-h-[88px]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[#6E7680] dark:text-dark-text-muted text-sm mb-1 transition-colors">
            {t('analytics.totalUploadedDocuments')}
          </p>
          <p className="text-lg md:text-xl font-bold text-[#232333] dark:text-dark-text transition-colors">
            {total}
          </p>
          <p className="text-xs text-[#6E7680] dark:text-dark-text-muted mt-1 transition-colors">
            {departmentBreakdown}
          </p>
        </div>
        <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/25 transition-colors">
          <Files className="w-5 h-5 text-blue-600 dark:text-blue-300 icon-current transition-colors" />
        </div>
      </div>
    </div>
  );
}
