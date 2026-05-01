import type { ReactNode } from 'react';
import { useAuth } from '../../contexts/AuthContext';

export function AppLayout(props: {
  mode: 'driver' | 'rider';
  onModeChange: (m: 'driver' | 'rider') => void;
  content: ReactNode;
}) {
  const { logout } = useAuth();

  return (
    <div style={{ display: 'grid', gridTemplateRows: '56px 1fr', height: '100vh', fontFamily: 'system-ui, Segoe UI, Arial' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          borderBottom: '1px solid #e5e7eb',
          background: '#fff',
        }}
      >
        <div style={{ fontWeight: 700 }}>CarPool</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => props.onModeChange('driver')}
              style={{
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid #e5e7eb',
                background: props.mode === 'driver' ? '#111827' : '#fff',
                color: props.mode === 'driver' ? '#fff' : '#111827',
                cursor: 'pointer',
              }}
            >
              Driver
            </button>
            <button
              onClick={() => props.onModeChange('rider')}
              style={{
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid #e5e7eb',
                background: props.mode === 'rider' ? '#111827' : '#fff',
                color: props.mode === 'rider' ? '#fff' : '#111827',
                cursor: 'pointer',
              }}
            >
              Rider
            </button>
          </div>
          <button
            onClick={logout}
            style={{
              padding: '8px 12px',
              borderRadius: 10,
              border: 'none',
              background: '#ef4444',
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Logout
          </button>
        </div>
      </header>
      <main style={{ minHeight: 0 }}>{props.content}</main>
    </div>
  );
}

