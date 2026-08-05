import { Link } from 'react-router-dom';
import { useSession } from '@/state/store';
import { t } from '@/lib/i18n';

/** The 60-second orientation. Three cards, three actions, then the till. */
export default function WelcomePage() {
  const { session } = useSession();

  const steps = [
    { to: '/products', emoji: '📦', title: t('add_product'), body: 'We added a few samples — replace them with your real items.' },
    { to: '/sell', emoji: '🧾', title: t('new_sale'), body: 'Tap items, take cash or card, print or WhatsApp the receipt.' },
    { to: '/sales', emoji: '📊', title: t('z_report'), body: 'Tonight, check your first daily total here.' },
  ];

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col justify-center p-6">
      <p className="text-4xl">🎉</p>
      <h1 className="mt-3 text-2xl font-bold">{t('welcome_title')}</h1>
      <p className="mt-1 text-muted-foreground">
        {session?.org.name} · {t('welcome_body')}
      </p>

      <div className="mt-8 flex flex-col gap-3">
        {steps.map((s, i) => (
          <Link key={s.to} to={s.to} className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4 transition-transform active:scale-[.98]">
            <span className="text-2xl">{s.emoji}</span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{i + 1}. {s.title}</span>
              <span className="block text-sm text-muted-foreground">{s.body}</span>
            </span>
            <span className="text-muted-foreground">→</span>
          </Link>
        ))}
      </div>

      <Link to="/sell" className="mt-8 grid h-14 place-items-center rounded-xl bg-primary text-lg font-bold text-primary-foreground">
        {t('sell')} →
      </Link>
    </div>
  );
}
