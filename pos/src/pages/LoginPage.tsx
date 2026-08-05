import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useSession, type Session } from '@/state/store';
import { t } from '@/lib/i18n';
import { Icon } from '@/components/Icon';

/**
 * One email can hold accounts at several shops — a two-branch owner trading as
 * separate businesses, a bookkeeper working for four of them. When more than
 * one answers to the same password the server returns a list instead of a
 * token, and we ask which till they meant to open.
 */
interface ShopChoice {
  orgId: string;
  name: string;
  slug: string;
  role: string;
  suspended: boolean;
}

type LoginResponse =
  | ({ mode: 'ready'; token: string } & Session)
  | { mode: 'choose'; shops: ShopChoice[] };

export default function LoginPage() {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shops, setShops] = useState<ShopChoice[] | null>(null);

  const authenticate = async (orgId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<LoginResponse>('/auth/login', { email, password, ...(orgId ? { orgId } : {}) });

      if (result.mode === 'choose') {
        setShops(result.shops);
        return;
      }

      signIn(result.token, { user: result.user, org: result.org as Session['org'] });
      navigate('/sell', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void authenticate();
  };

  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden bg-background p-5">
      {/* A single soft light behind the card — the only decoration on the
          screen, and it lifts the form off a flat background. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[18%] size-[520px] -translate-x-1/2 rounded-full opacity-[0.13] blur-[110px]"
        style={{ background: 'hsl(var(--primary))' }}
      />

      <form
        onSubmit={(e) => void submit(e)}
        className="rise-in relative w-full max-w-[380px] rounded-3xl border border-border bg-card p-7 shadow-e3"
      >
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-primary shadow-e2">
          <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden>
            <path
              d="M21.5 11c0-2-1.8-3.5-5.5-3.5S10.5 9 10.5 11s2 2.8 5.5 3.5 5.5 1.5 5.5 3.5-1.8 3.5-5.5 3.5-5.5-1.5-5.5-3.5"
              stroke="hsl(var(--primary-foreground))"
              strokeWidth="2.6"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <h1 className="mt-5 text-center text-[22px] font-bold tracking-[-0.02em]">Sillara POS</h1>
        <p className="mt-1 text-center text-[13.5px] text-muted-foreground">
          {shops ? 'Which shop are you opening?' : 'Sign in to open the till'}
        </p>

        {error ? (
          <p
            role="alert"
            className="rise-in mt-5 flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-[13px] font-medium text-destructive"
          >
            <span className="mt-px shrink-0">
              <Icon name="alert" size={15} strokeWidth={2.2} />
            </span>
            {error}
          </p>
        ) : null}

        {shops ? (
          <>
            <div className="mt-5 flex flex-col gap-2">
              {shops.map((shop) => (
                <button
                  key={shop.orgId}
                  type="button"
                  disabled={busy || shop.suspended}
                  onClick={() => void authenticate(shop.orgId)}
                  className="pressable flex items-center justify-between gap-3 rounded-xl border border-input bg-background px-4 py-3.5 text-left transition-colors hover:border-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-bold">{shop.name}</span>
                    <span className="block text-[12.5px] font-medium text-muted-foreground">
                      {shop.suspended ? 'Suspended' : shop.role.toLowerCase()}
                    </span>
                  </span>
                  <span className="shrink-0 text-muted-foreground" aria-hidden>
                    <Icon name="chevronRight" size={18} strokeWidth={2.2} />
                  </span>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => {
                setShops(null);
                setError(null);
              }}
              className="mt-4 w-full text-center text-[13px] font-semibold text-muted-foreground hover:underline"
            >
              ← Use a different email
            </button>
          </>
        ) : (
        <div className="mt-5 flex flex-col gap-2.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-bold uppercase tracking-[0.07em] text-muted-foreground">
              {t('email')}
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@shop.com"
              autoComplete="username"
              autoFocus
              className="h-12 w-full rounded-xl border border-input bg-background px-3.5 text-[15px] font-medium outline-none transition-colors placeholder:font-normal placeholder:text-subtle-foreground focus:border-ring"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-bold uppercase tracking-[0.07em] text-muted-foreground">
              {t('password')}
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              className="h-12 w-full rounded-xl border border-input bg-background px-3.5 text-[15px] font-medium outline-none transition-colors placeholder:text-subtle-foreground focus:border-ring"
            />
          </label>
        </div>
        )}

        {shops ? null : (
        <button
          type="submit"
          disabled={busy}
          className="pressable mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-primary py-3.5 text-[15px] font-bold text-primary-foreground shadow-e2 hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? (
            <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
          ) : null}
          {busy ? 'Signing in…' : t('sign_in')}
        </button>
        )}

        <p className="mt-6 border-t border-border pt-5 text-center text-[13.5px] text-muted-foreground">
          No shop yet?{' '}
          <a href="/signup" className="font-semibold text-primary hover:underline">
            Create one free →
          </a>
        </p>
      </form>
    </div>
  );
}
