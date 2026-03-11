import { useState } from 'react';
import { Send } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';

export default function MessageInput({ send, user, placeholder = "Type your message..." }) {
  const { t } = useLang();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  const handleSend = () => {
    if (!message.trim()) {
      alert(t('messageInput.pleaseEnter'));
      return;
    }
    
    if (send) {
      send({ subject, message });
      setSubject('');
      setMessage('');
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSend();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder={t('messageInput.subjectOptional')}
        style={{
          padding: '8px 12px',
          borderRadius: '4px',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          backgroundColor: 'rgba(255, 255, 255, 0.05)',
          color: '#fff',
          fontSize: '13px',
          outline: 'none',
          transition: 'border-color 0.2s'
        }}
        onFocus={(e) => e.target.style.borderColor = 'rgba(0, 120, 255, 0.5)'}
        onBlur={(e) => e.target.style.borderColor = 'rgba(255, 255, 255, 0.1)'}
      />
      
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyPress={handleKeyPress}
        placeholder={placeholder}
        rows="3"
        style={{
          padding: '8px 12px',
          borderRadius: '4px',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          backgroundColor: 'rgba(255, 255, 255, 0.05)',
          color: '#fff',
          fontSize: '13px',
          outline: 'none',
          resize: 'none',
          transition: 'border-color 0.2s',
          fontFamily: 'inherit'
        }}
        onFocus={(e) => e.target.style.borderColor = 'rgba(0, 120, 255, 0.5)'}
        onBlur={(e) => e.target.style.borderColor = 'rgba(255, 255, 255, 0.1)'}
      />
      
      <button
        onClick={handleSend}
        style={{
          padding: '8px 16px',
          borderRadius: '4px',
          backgroundColor: '#0078ff',
          color: '#fff',
          border: 'none',
          fontSize: '13px',
          fontWeight: '600',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          transition: 'all 0.2s'
        }}
        onMouseEnter={(e) => {
          e.target.style.backgroundColor = '#0060cc';
          e.target.style.transform = 'translateY(-1px)';
        }}
        onMouseLeave={(e) => {
          e.target.style.backgroundColor = '#0078ff';
          e.target.style.transform = 'translateY(0)';
        }}
      >
        <Send size={16} />
        {t('messageInput.sendMessage')}
      </button>
    </div>
  );
}
