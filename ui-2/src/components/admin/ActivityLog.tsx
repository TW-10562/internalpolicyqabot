import {
  Activity,
  Clock,
} from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { formatDateTimeJP } from '../../lib/dateTime';

interface ActivityLog {
  id: string;
  user: string;
  action: string;
  detail: string;
  timestamp: Date;
}

interface ActivityLogProps {
  activities: ActivityLog[];
  showTitle?: boolean;
}

export default function ActivityLogComponent({ activities, showTitle = true }: ActivityLogProps) {
  const { t } = useLang();

  return (
    <div className="space-y-4">
      {showTitle ? <h3 className="app-page-title transition-colors">{t('activity.title')}</h3> : null}

      <div className="space-y-3">
        {activities.map((activity) => (
          <div
            key={activity.id}
            className="bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-2xl p-4 hover:bg-[#F6F6F6] dark:hover:bg-dark-border transition-colors shadow-sm"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-[#F0F4FF] dark:bg-dark-surface-alt rounded-xl flex items-center justify-center flex-shrink-0 transition-colors">
                <Activity className="w-5 h-5 text-[#1d2089] dark:text-dark-accent-blue transition-colors" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[#232333] dark:text-dark-text font-medium transition-colors">{activity.user}</span>
                  <span className="text-[#9CA3AF]">•</span>
                  <span className="text-[#6E7680] dark:text-dark-text-muted transition-colors">{activity.action}</span>
                </div>
                <p className="text-sm text-[#6E7680] dark:text-dark-text-muted mb-2 transition-colors">{activity.detail}</p>
                <div className="flex items-center gap-1 text-xs text-[#9CA3AF] dark:text-dark-text-muted transition-colors">
                  <Clock className="w-3 h-3" />
                  <span>{formatDateTimeJP(activity.timestamp)}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
