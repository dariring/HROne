import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Layout, type Me } from './components/Layout';
import { ConfirmHost, Loading, ToastHost } from './components/ui';
import { api } from './lib/api';
import { Redirect, match, useLocation } from './lib/router';
import { AppDetail } from './pages/AppDetail';
import { AppNew } from './pages/AppNew';
import { Apps } from './pages/Apps';
import { Dashboard } from './pages/Dashboard';
import { Databases } from './pages/Databases';
import { DbDetail } from './pages/DbDetail';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { System } from './pages/System';
import './styles.css';

const ROUTES: [string, (p: Record<string, string>, me: Me) => React.ReactNode][] = [
  ['/', (_p, me) => <Dashboard me={me} />],
  ['/apps', () => <Apps />],
  ['/apps/new', () => <AppNew />],
  ['/apps/:slug', (p, me) => <AppDetail slug={p.slug!} me={me} />],
  ['/databases', () => <Databases />],
  ['/databases/:slug', (p, me) => <DbDetail slug={p.slug!} me={me} />],
  ['/system', (_p, me) => <System me={me} />],
  ['/settings', (_p, me) => <Settings me={me} />],
  // 예전 메뉴 주소
  ['/backups', () => <Redirect to="/system?tab=backups" />],
  ['/audit', () => <Redirect to="/settings?tab=audit" />],
];

function Router({ me }: { me: Me }) {
  const { path } = useLocation();
  for (const [pattern, render] of ROUTES) {
    const params = match(pattern, path);
    if (params) return <>{render(params, me)}</>;
  }
  return <div className="py-20 text-center text-muted">페이지를 찾을 수 없습니다</div>;
}

function Root() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refresh = useCallback(() => {
    api
      .get<{ user: Me | null }>('/api/auth/state')
      .then((s) => setMe(s.user))
      .catch(() => setMe(null));
  }, []);
  useEffect(() => {
    refresh();
    const onUnauth = () => setMe(null);
    window.addEventListener('hrone:unauthorized', onUnauth);
    return () => window.removeEventListener('hrone:unauthorized', onUnauth);
  }, [refresh]);
  if (me === undefined) return <Loading text="HROne 연결 중..." />;
  if (me === null) return <Login onLogin={refresh} />;
  return (
    <Layout me={me}>
      <Router me={me} />
    </Layout>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfirmHost>
      <Root />
      <ToastHost />
    </ConfirmHost>
  </StrictMode>,
);
