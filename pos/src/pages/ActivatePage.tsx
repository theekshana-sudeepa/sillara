import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { useSession } from '@/state/store';
import type { Session } from '@/state/store';

type Phase = 'waiting' | 'set-password' | 'working' | 'error';

/**
 * Two entry modes:
 *   /activate?token=…    — clicked the email link → set password → inside.
 *   /activate?pending=…  — returned from Paddle/PayHere checkout → poll
 *                          provision-status until the webhook lands, then
 *                          tell them to open the email. Median wait: seconds.
 */
export default function ActivatePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { signIn } = useSession();

  const token = params.get('token');
  const pending = params.get('pending');

  const [phase, setPhase] = useState<Phase>(token ? 'set-password' : 'waiting');
  const [shopName, setShopName] = useState('');
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Checkout return: poll until the webhook provisions the shop.
  useEffect(() => {
    if (!pending || token) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await api.get<{ ready: boolean; name: string }>(`/public/provision-status/${pending}`);
        if (cancelled) return;
        setShopName(status.name);
        if (status.ready) setReady(true);
        else setTimeout(poll, 2500);
      } catch {
        if (!cancelled) setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [pending, token]);

  const activate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError('Password must be at least 8 characters');
    if (password !== confirm) return setError('Passwords do not match');
    setPhase('working');
    setError(null);
    try {
      const result = await api.post<{ token: string } & Session>('/auth/activate', { token, password });
      signIn(result.token, { user: result.user, org: result.org as Session['org'] });
      navigate('/welcome', { replace: true });
    } catch (err) {
      setPhase('set-password');
      setError(err instanceof Error ? err.message : 'Activation failed');
    }
  };

  return (
    <div className="grid min-h-full place-items-center bg-background p-5">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary text-xl font-bold text-primary-foreground">S</div>

        {phase === 'waiting' && ready ? (
          <>
            <p className="mt-6 text-4xl" aria-hidden>🎉</p>
            <h1 className="mt-3 text-xl font-bold">{shopName || 'Your shop'} is ready!</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Payment confirmed and your shop is built. Sign in with the email and password you chose at signup
              — or use the activation link if we emailed you one.
            </p>
            <button
              onClick={() => navigate('/login', { replace: true })}
              className="mt-6 h-12 w-full rounded-xl bg-primary font-bold text-primary-foreground"
            >
              Sign in to my shop →
            </button>
          </>
        ) : phase === 'waiting' ? (
          <>
            <h1 className="mt-6 text-xl font-bold">Setting up {shopName || 'your shop'}…</h1>
            <div className="mx-auto mt-6 size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
            <p className="mt-6 text-sm text-muted-foreground">
              Confirming your payment and building your shop. This usually takes a few seconds.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-xl font-bold">Set your password</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">One last step and your shop is open.</p>

            <form onSubmit={(e) => void activate(e)} className="mt-6 flex flex-col gap-3 text-left">
              {error ? (
                <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
              ) : null}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password (min 8 characters)"
                autoComplete="new-password"
                autoFocus
                className="h-12 rounded-xl border border-input bg-background px-4 text-sm outline-none focus:border-ring"
              />
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat password"
                autoComplete="new-password"
                className="h-12 rounded-xl border border-input bg-background px-4 text-sm outline-none focus:border-ring"
              />
              <button
                type="submit"
                disabled={phase === 'working'}
                className="h-12 rounded-xl bg-primary font-bold text-primary-foreground disabled:opacity-50"
              >
                {phase === 'working' ? 'Opening your shop…' : 'Open my shop →'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
