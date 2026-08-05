import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/state/store';
import { setLang, getLang, type Lang } from '@/lib/i18n';
import { t } from '@/lib/i18n';
import { InstallPrompt } from '@/components/InstallPrompt';
import { BillingCard } from '@/components/BillingCard';

export default function SettingsPage() {
  const { session, signOut, refreshCatalog } = useSession();
  const [lang, setLangState] = useState<Lang>(getLang());
  const [saved, setSaved] = useState(false);
  const [digest, setDigest] = useState<boolean | null>(null);

  useEffect(() => {
    void api
      .get<{ dailyDigestEnabled: boolean }>('/org')
      .then((o) => setDigest(o.dailyDigestEnabled))
      .catch(() => setDigest(null));
  }, []);

  const toggleDigest = async () => {
    const next = !digest;
    setDigest(next); // optimistic: a toggle that lags feels broken
    try {
      await api.patch('/org', { dailyDigestEnabled: next });
    } catch {
      setDigest(!next);
    }
  };

  const changeLang = async (next: Lang) => {
    setLang(next);
    setLangState(next);
    try {
      await api.patch('/org', { language: next });
    } catch { /* offline: applied locally, syncs next session */ }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="mx-auto max-w-md p-5">
      <h1 className="text-lg font-bold">{t('settings')}</h1>

      <div className="mt-4 rounded-xl border border-border bg-card p-4">
        <p className="text-sm font-semibold">{session?.org.name}</p>
        <p className="text-xs text-muted-foreground">{session?.user.name} · {session?.user.role}</p>
      </div>

      <p className="mt-5 text-xs font-semibold text-muted-foreground">Language / භාෂාව / மொழி</p>
      <div className="mt-2 grid grid-cols-3 gap-2" role="group" aria-label="Language">
        {([['en', 'English'], ['si', 'සිංහල'], ['ta', 'தமிழ்']] as const).map(([code, label]) => (
          <button
            key={code}
            onClick={() => void changeLang(code)}
            aria-pressed={lang === code}
            className={`h-11 rounded-xl text-sm font-semibold ${lang === code ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {saved ? <p className="mt-2 text-xs text-success">✓</p> : null}

      <BillingCard />

      {digest !== null ? (
        <button
          onClick={() => void toggleDigest()}
          role="switch"
          aria-checked={digest}
          className="mt-4 flex w-full items-center justify-between rounded-xl border border-border bg-card p-4 text-left"
        >
          <span>
            <span className="block text-sm font-semibold">Daily summary email</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Yesterday&rsquo;s takings and what is running low, every morning.
            </span>
          </span>
          <span
            aria-hidden
            className={`ml-3 h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors ${digest ? 'bg-primary' : 'bg-secondary'}`}
          >
            <span className={`block h-5 w-5 rounded-full bg-white transition-transform ${digest ? 'translate-x-5' : ''}`} />
          </span>
        </button>
      ) : null}

      <div className="mt-6">
        <InstallPrompt />
      </div>

      <button onClick={() => void refreshCatalog()} className="mt-3 h-11 w-full rounded-xl bg-secondary text-sm font-semibold">
        ↻ Refresh catalog
      </button>

      <button onClick={signOut} className="mt-3 h-11 w-full rounded-xl border border-destructive/40 text-sm font-semibold text-destructive">
        {t('sign_out')}
      </button>

      <p className="mt-8 text-center text-xs text-muted-foreground">Sillara POS · sillara.com</p>
    </div>
  );
}
