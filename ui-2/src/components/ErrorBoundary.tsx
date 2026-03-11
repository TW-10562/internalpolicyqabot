import React from 'react';

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  message: string;
};

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error || 'Unknown error'),
    };
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    console.error('[UI ErrorBoundary] Unhandled render error:', error, errorInfo);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f6f6f6',
          color: '#232333',
          padding: '24px',
        }}
      >
        <div
          style={{
            maxWidth: '820px',
            width: '100%',
            background: '#ffffff',
            border: '1px solid #e8e8e8',
            borderRadius: '12px',
            padding: '20px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
          }}
        >
          <h2 style={{ margin: 0, marginBottom: '10px', fontSize: '20px', fontWeight: 700 }}>
            UI Runtime Error
          </h2>
          <p style={{ margin: 0, marginBottom: '8px', color: '#6e7680' }}>
            The application crashed while rendering. Check browser console logs for details.
          </p>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: '#f8fafc',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              padding: '10px',
              fontSize: '12px',
              lineHeight: 1.45,
              color: '#111827',
            }}
          >
            {this.state.message || 'Unknown render error'}
          </pre>
        </div>
      </div>
    );
  }
}

