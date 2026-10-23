import { KeyRound, LogIn } from 'lucide-react';
import { useState } from 'react';
import { Button, Field } from '../components/ui';
import { api, errorText } from '../lib/api';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ needTotp?: boolean }>('/api/auth/login', { username, password, totp: needTotp ? totp : undefined });
      if (r.needTotp) {
        setNeedTotp(true);
        return;
      }
      onLogin();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,92,255,0.14),transparent_60%)]" />
      <form onSubmit={submit} className="card relative w-full max-w-sm space-y-5 p-7 shadow-2xl">
        <div className="flex flex-col items-center gap-3 pb-1 text-center">
          <img src="/favicon.svg" className="h-12 w-12" alt="" />
          <div>
            <h1 className="text-xl font-bold">HROne</h1>
            <p className="mt-0.5 text-sm text-muted">서버 패널에 로그인</p>
          </div>
        </div>
        {!needTotp ? (
          <>
            <Field label="아이디">
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
            </Field>
            <Field label="비밀번호">
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
          </>
        ) : (
          <Field label="OTP 코드" hint="인증 앱(Google Authenticator 등)의 6자리 코드">
            <input
              className="input mono text-center text-lg tracking-[0.4em]"
              inputMode="numeric"
              maxLength={6}
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
              autoFocus
              autoComplete="one-time-code"
            />
          </Field>
        )}
        {error && <div className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={needTotp ? <KeyRound size={17} /> : <LogIn size={17} />}>
          {needTotp ? '확인' : '로그인'}
        </Button>
        <p className="text-center text-xs leading-relaxed text-muted">
          비밀번호를 잊었다면 서버에서 <code className="text-fg-2">sudo hrone reset-password</code>
        </p>
      </form>
    </div>
  );
}
