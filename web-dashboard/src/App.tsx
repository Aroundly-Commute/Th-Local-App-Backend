import { useMemo, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import DriverDashboard from './pages/DriverDashboard';
import RiderDashboard from './pages/RiderDashboard';
import Login from './pages/Login';
import { AppLayout } from './components/layout/AppLayout';
import { useAuth } from './contexts/AuthContext';

type Mode = 'driver' | 'rider';

function Dashboard() {
  const [mode, setMode] = useState<Mode>('driver');
  const { user, logout } = useAuth();

  const content = useMemo(() => {
    if (mode === 'driver') return <DriverDashboard />;
    return <RiderDashboard />;
  }, [mode]);

  return (
    <AppLayout
      mode={mode}
      onModeChange={setMode}
      content={content}
      // Assuming AppLayout might have a logout button somewhere, or you can add one there.
    />
  );
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="min-h-screen bg-slate-950 flex items-center justify-center text-white">Loading...</div>;
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
      <Route path="/" element={user ? <Dashboard /> : <Navigate to="/login" />} />
    </Routes>
  );
}

