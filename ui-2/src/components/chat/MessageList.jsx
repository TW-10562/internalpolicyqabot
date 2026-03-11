import { CheckCircle, Clock } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';

export default function MessageList({ messages = [], onMarkAsRead }) {
  const { t } = useLang();
  
  if (!messages || messages.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 20px',
        color: '#999',
        textAlign: 'center'
      }}>
        <p>{t('messageList.noMessages')}</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {messages.map((m, i) => (
        <div
          key={i}
          style={{
            padding: '12px',
            borderRadius: '8px',
            backgroundColor: !m.read ? 'rgba(239, 68, 68, 0.1)' : 'rgba(255, 255, 255, 0.05)',
            border: !m.read ? '1px solid rgba(239, 68, 68, 0.4)' : '1px solid rgba(255, 255, 255, 0.1)',
            transition: 'all 0.2s',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <strong style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#fff' }}>
              {m.sender || t('messageList.admin')}
              {!m.read && (
                <span style={{
                  width: '8px',
                  height: '8px',
                  backgroundColor: '#ef4444',
                  borderRadius: '50%',
                  display: 'inline-block',
                }} />
              )}
            </strong>
            {!m.read && (
              <span style={{
                fontSize: '10px',
                padding: '2px 6px',
                borderRadius: '4px',
                backgroundColor: '#ef4444',
                color: '#fff',
                fontWeight: '500'
              }}>
                {t('messageList.new')}
              </span>
            )}
          </div>
 
          {m.subject && (
            <h4 style={{ margin: '5px 0 8px 0', color: '#0078ff', fontSize: '14px' }}>
              {m.subject}
            </h4>
          )}
 
          <p style={{ color: '#e2e8f0', fontSize: '13px', marginBottom: '8px' }}>
            {m.text || m.message}
          </p>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#94a3b8' }}>
              <Clock size={12} />
              <span>{m.time || m.date}</span>
            </div>
            {!m.read && (
              <button
                onClick={() => onMarkAsRead && onMarkAsRead(m)}
                style={{
                  fontSize: '11px',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  backgroundColor: '#0078ff',
                  color: '#fff',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: '500',
                  transition: 'background-color 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
                onMouseEnter={(e) => e.target.style.backgroundColor = '#0060cc'}
                onMouseLeave={(e) => e.target.style.backgroundColor = '#0078ff'}
              >
                <CheckCircle size={12} />
                {t('messageList.markAsRead')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
