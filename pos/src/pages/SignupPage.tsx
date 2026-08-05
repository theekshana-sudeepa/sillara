import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { useSession, type Session } from '@/state/store';

const COUNTRIES: Array<[string, string]> = [
  ['LK', '🇱🇰 Sri Lanka'], ['IN', '🇮🇳 India'], ['BD', '🇧🇩 Bangladesh'], ['NP', '🇳🇵 Nepal'],
  ['PK', '🇵🇰 Pakistan'], ['AE', '🇦🇪 UAE'], ['SG', '🇸🇬 Singapore'], ['MY', '🇲🇾 Malaysia'],
  ['PH', '🇵🇭 Philippines'], ['ID', '🇮🇩 Indonesia'], ['KE', '🇰🇪 Kenya'], ['NG', '🇳🇬 Nigeria'],
  ['ZA', '🇿🇦 South Africa'], ['AU', '🇦🇺 Australia'], ['GB', '🇬🇧 United Kingdom'],
  ['US', '🇺🇸 United States'], ['CA', '🇨🇦 Canada'],
];

/**
 * Free-tier signup that IS the activation: shop name + country, then
 * email + password — the server provisions and returns a live session in one
 * round-trip. No verification codes, no email wait. Abuse is contained by
 * rate limiting, bcrypt hashing and the free plan's hard caps, not by
 * friction at the front door.
 */
export default function SignupPage() {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const referralCode = params.get('ref');

  const [step, setStep] = useState<1 | 2>(1);
  const [shopName, setShopName] = useState('');
  const [country, setCountry] = useState('LK');
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = (e: React.FormEvent) => {
    e.preventDefault();
    if (shopName.trim().length < 2) return setError('Give your shop a name');
    setError(null);
    setStep(2);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError('Password must be at least 8 characters');
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<
        { mode: 'ready'; token: string } & Session
      >('/public/signup', {
        shopName: shopName.trim(),
        ownerName: ownerName.trim(),
        email: email.trim(),
        country,
        planCode: 'FREE',
        password,
        ...(referralCode ? { referralCode } : {}),
      });
      signIn(result.token, { user: result.user, org: result.org as Session['org'] });
      navigate('/setup', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed — try again');
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center bg-background p-5"
         style={{ backgroundImage: 'radial-gradient(600px 300px at 50% -60px, hsl(var(--primary) / .12), transparent)' }}>
      <div className="w-full max-w-sm">
        {/* brand + progress */}
        <div className="flex flex-col items-center">
          <div className="grid size-14 place-items-center rounded-2xl bg-primary text-2xl font-bold text-primary-foreground shadow-lg shadow-primary/25">S</div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">Open your shop</h1>
          <p className="mt-1 text-sm text-muted-foreground">Free forever · upgrade anytime · no card needed</p>
          {referralCode ? (
            <p className="mt-2 rounded-full bg-success/15 px-3 py-1 text-xs font-bold text-success">
              🎁 Invited with code {referralCode} — you get a free month
            </p>
          ) : null}

          <div className="mt-5 flex items-center gap-2" aria-hidden>
            {[1, 2].map((s) => (
              <span key={s} className={`h-1.5 rounded-full transition-all ${step >= s ? 'w-8 bg-primary' : 'w-4 bg-secondary'}`} />
            ))}
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-5 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {step === 1 ? (
          <form onSubmit={next} className="mt-6 flex flex-col gap-4">
            <div>
              <label htmlFor="shopName" className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Shop name</label>
              <input
                id="shopName"
                value={shopName}
                onChange={(e) => setShopName(e.target.value)}
                placeholder="Silverline Mart"
                autoFocus
                required
                className="mt-1.5 h-13 w-full rounded-xl border border-input bg-card px-4 text-base outline-none transition-colors focus:border-ring"
                style={{ height: 52 }}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">This appears on every receipt — you can change it later.</p>
            </div>

            <div>
              <label htmlFor="country" className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Country</label>
              <select
                id="country"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-input bg-card px-4 text-base outline-none focus:border-ring"
                style={{ height: 52 }}
              >
                {COUNTRIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
              <p className="mt-1.5 text-xs text-muted-foreground">Sets your currency and timezone automatically.</p>
            </div>

            <button type="submit" className="mt-2 h-13 rounded-xl bg-primary text-base font-bold text-primary-foreground transition-transform active:scale-[.98]" style={{ height: 52 }}>
              Continue →
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="mt-6 flex flex-col gap-4">
            <div>
              <label htmlFor="ownerName" className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Your name</label>
              <input
                id="ownerName" value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
                placeholder="Nuwan Perera" autoFocus required minLength={2}
                autoComplete="name"
                className="mt-1.5 w-full rounded-xl border border-input bg-card px-4 text-base outline-none focus:border-ring" style={{ height: 52 }}
              />
            </div>

            <div>
              <label htmlFor="email" className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Email — this is your sign-in</label>
              <input
                id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@shop.com" required autoComplete="username"
                className="mt-1.5 w-full rounded-xl border border-input bg-card px-4 text-base outline-none focus:border-ring" style={{ height: 52 }}
              />
            </div>

            <div>
              <label htmlFor="password" className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Password</label>
              <div className="relative mt-1.5">
                <input
                  id="password" type={showPw ? 'text' : 'password'} value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters" required minLength={8}
                  autoComplete="new-password"
                  className="w-full rounded-xl border border-input bg-card px-4 pr-16 text-base outline-none focus:border-ring" style={{ height: 52 }}
                />
                <button type="button" onClick={() => setShowPw((s) => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground"
                        aria-label={showPw ? 'Hide password' : 'Show password'}>
                  {showPw ? 'HIDE' : 'SHOW'}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">Stored encrypted — we can never read it. No verification codes needed.</p>
            </div>

            <button type="submit" disabled={busy}
                    className="mt-2 rounded-xl bg-primary text-base font-bold text-primary-foreground transition-transform active:scale-[.98] disabled:opacity-60"
                    style={{ height: 52 }}>
              {busy ? 'Building your shop…' : 'Create my shop 🎉'}
            </button>

            <button type="button" onClick={() => setStep(1)} className="text-sm font-medium text-muted-foreground">
              ← Back
            </button>
          </form>
        )}

        <p className="mt-8 text-center text-sm text-muted-foreground">
          Already have a shop? <Link to="/login" className="font-semibold text-primary">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
