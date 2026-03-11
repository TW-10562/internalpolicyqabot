import { useState } from 'react';
import { X, Send, AlertCircle } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
 
export default function ContactAdminPopup({ isOpen, onClose, onSend, isSubmitting = false }) {
  const { t } = useLang();
  const [subject, setSubject] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
 
  const handleSend = () => {
    setError('');
   
    if (!query.trim()) {
      setError(t('contactAdmin.queryRequired'));
      return;
    }
   
    if (window.confirm(t('contactAdmin.confirmSend'))) {
      onSend({ subject: subject.trim(), message: query.trim() });
      setSubject('');
      setQuery('');
    }
  };
 
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSend();
    }
  };
 
  if (!isOpen) return null;
 
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 50,
      backdropFilter: 'blur(4px)'
    }}>
      <div style={{
        backgroundColor: '#1a1a2e',
        borderRadius: '16px',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)',
        width: '90%',
        maxWidth: '600px',
        maxHeight: '85vh',
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        color: '#fff'
      }}>
        {/* Header */}
        <div style={{
          padding: '24px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: 'rgba(0, 0, 0, 0.3)'
        }}>
          <div>
            <h2 style={{ margin: '0 0 4px 0', fontSize: '24px', fontWeight: '700' }}>
              {t('contactAdmin.title')}
            </h2>
            <p style={{ margin: 0, fontSize: '13px', color: '#999' }}>
              {t('contactAdmin.description')}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            style={{
              background: 'none',
              border: 'none',
              color: '#999',
              cursor: 'pointer',
              padding: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
              e.target.style.color = '#fff';
            }}
            onMouseLeave={(e) => {
              e.target.style.backgroundColor = 'transparent';
              e.target.style.color = '#999';
            }}
          >
            <X size={24} />
          </button>
        </div>
 
        {/* Body */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px'
        }}>
          {/* Error Message */}
          {error && (
            <div style={{
              padding: '12px 16px',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              color: '#fca5a5',
              fontSize: '14px'
            }}>
              <AlertCircle size={18} style={{ flexShrink: 0 }} />
              <span>{error}</span>
            </div>
          )}
 
          {/* Subject Field */}
          <div>
            <label style={{
              display: 'block',
              fontSize: '14px',
              fontWeight: '500',
              marginBottom: '8px',
              color: '#e2e8f0'
            }}>
              {t('contactAdmin.subjectLabel')}
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onKeyPress={handleKeyPress}
              disabled={isSubmitting}
              placeholder={t('contactAdmin.subjectPlaceholder')}
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: '8px',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                color: '#fff',
                fontSize: '14px',
                outline: 'none',
                transition: 'all 0.2s',
                boxSizing: 'border-box',
                cursor: isSubmitting ? 'not-allowed' : 'text',
                opacity: isSubmitting ? 0.6 : 1,
              }}
              onFocus={(e) => {
                e.target.style.borderColor = 'rgba(59, 130, 246, 0.5)';
                e.target.style.backgroundColor = 'rgba(59, 130, 246, 0.05)';
              }}
              onBlur={(e) => {
                e.target.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
              }}
            />
          </div>
 
          {/* Query Field */}
          <div>
            <label style={{
              display: 'block',
              fontSize: '14px',
              fontWeight: '500',
              marginBottom: '8px',
              color: '#e2e8f0'
            }}>
              {t('contactAdmin.queryLabel')}
            </label>
            <textarea
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setError('');
              }}
              onKeyPress={handleKeyPress}
              disabled={isSubmitting}
              placeholder={t('contactAdmin.queryPlaceholder')}
              rows="8"
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: '8px',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                color: '#fff',
                fontSize: '14px',
                fontFamily: 'inherit',
                outline: 'none',
                resize: 'vertical',
                transition: 'all 0.2s',
                boxSizing: 'border-box',
                cursor: isSubmitting ? 'not-allowed' : 'text',
                opacity: isSubmitting ? 0.6 : 1,
              }}
              onFocus={(e) => {
                e.target.style.borderColor = 'rgba(59, 130, 246, 0.5)';
                e.target.style.backgroundColor = 'rgba(59, 130, 246, 0.05)';
              }}
              onBlur={(e) => {
                e.target.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
              }}
            />
            <p style={{
              margin: '6px 0 0 0',
              fontSize: '12px',
              color: '#666'
            }}>
              {query.length > 0 ? t('inlineContactAdmin.charactersCount', { count: query.length }) : t('inlineContactAdmin.minCharacters')}
            </p>
          </div>
        </div>
 
        {/* Footer */}
        <div style={{
          padding: '20px 24px',
          borderTop: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'flex',
          gap: '12px',
          justifyContent: 'flex-end',
          backgroundColor: 'rgba(0, 0, 0, 0.2)'
        }}>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            style={{
              padding: '12px 24px',
              fontSize: '14px',
              fontWeight: '500',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              backgroundColor: 'transparent',
              color: '#e2e8f0',
              borderRadius: '8px',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
              opacity: isSubmitting ? 0.6 : 1,
            }}
            onMouseEnter={(e) => {
              if (!isSubmitting) {
                e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                e.target.style.borderColor = 'rgba(255, 255, 255, 0.3)';
              }
            }}
            onMouseLeave={(e) => {
              e.target.style.backgroundColor = 'transparent';
              e.target.style.borderColor = 'rgba(255, 255, 255, 0.2)';
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSend}
            disabled={isSubmitting || !query.trim()}
            style={{
              padding: '12px 28px',
              fontSize: '14px',
              fontWeight: '600',
              border: 'none',
              backgroundColor: '#3b82f6',
              color: '#fff',
              borderRadius: '8px',
              cursor: isSubmitting || !query.trim() ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              opacity: (isSubmitting || !query.trim()) ? 0.6 : 1,
            }}
            onMouseEnter={(e) => {
              if (!isSubmitting && query.trim()) {
                e.target.style.backgroundColor = '#2563eb';
                e.target.style.transform = 'translateY(-2px)';
                e.target.style.boxShadow = '0 4px 12px rgba(59, 130, 246, 0.4)';
              }
            }}
            onMouseLeave={(e) => {
              e.target.style.backgroundColor = '#3b82f6';
              e.target.style.transform = 'translateY(0)';
              e.target.style.boxShadow = 'none';
            }}
          >
            <Send size={16} />
            {isSubmitting ? t('common.submitting') : t('inlineContactAdmin.sendButton')}
          </button>
        </div>
      </div>
    </div>
  );
}
 