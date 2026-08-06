import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useSession } from '@/state/store';
import { money } from '@/lib/format';
import { setLang, type Lang } from '@/lib/i18n';
import { InstallPrompt } from '@/components/InstallPrompt';
import { ShelfieImport } from '@/components/ShelfieImport';

interface QuickProduct {
  name: string;
  price: string;
}

interface BusinessTypeOption {
  value: string;
  label: string;
}

/** One glyph per trade — faster to scan than a dropdown of thirteen. */
const TYPE_ICON: Record<string, string> = {
  GENERAL_RETAIL: '🏪',
  GROCERY: '🛒',
  PHARMACY: '💊',
  BAKERY: '🥖',
  CLOTHING: '👕',
  ELECTRONICS: '🔌',
  MOBILE: '📱',
  HARDWARE: '🔧',
  BOOKSHOP: '📚',
  SERVICE: '🛠️',
  RESTAURANT: '🍽️',
  SALON: '💇',
  OTHER: '✨',
};

const STEPS = [
  { icon: '🏪', title: 'Your shop' },
  { icon: '📦', title: 'First products' },
  { icon: '🚀', title: 'Ready' },
] as const;

/**
 * The 3-minute setup. Every field is optional-feeling and skippable — the
 * wizard's job is momentum, not completeness. A shop that reaches the sell
 * screen configures the rest later; a shop stuck on a form never comes back.
 */
export default function SetupWizard() {
  const { session, refreshCatalog } = useSession();
  const navigate = useNavigate();
  const currency = session?.org.currency ?? 'USD';

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);

  // step 1 — identity
  const [receiptHeader, setReceiptHeader] = useState(session?.org.name ?? '');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [language, setLanguage] = useState<Lang>((session?.org.language as Lang) ?? 'en');

  // step 2 — quick products
  const [rows, setRows] = useState<QuickProduct[]>([
    { name: '', price: '' },
    { name: '', price: '' },
    { name: '', price: '' },
  ]);
  const [added, setAdded] = useState(0);
  const [shelfieOpen, setShelfieOpen] = useState(false);

  // step 1 — what kind of shop. Optional: skipping leaves the general retail
  // preset the shop already provisioned with, which sells perfectly well.
  const [types, setTypes] = useState<BusinessTypeOption[]>([]);
  const [businessType, setBusinessType] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ businessTypes: BusinessTypeOption[]; businessType: string }>('/org/capabilities');
        setTypes(res.businessTypes);
        // Only pre-select if the shop was provisioned with a real choice —
        // the default must not look like an answer they already gave.
        if (res.businessType && res.businessType !== 'GENERAL_RETAIL') setBusinessType(res.businessType);
      } catch { /* offline — the picker is a nicety, not a gate */ }
    })();
  }, []);

  const saveIdentity = async () => {
    setBusy(true);
    try {
      await api.patch('/org', {
        receiptHeader: receiptHeader || null,
        phone: phone || null,
        address: address || null,
        language,
      });
      setLang(language);

      // Applying the preset swaps the starter catalogue and switches on the
      // capabilities this trade actually uses. Untouched samples from the
      // previous preset are cleared server-side.
      if (businessType) {
        await api.patch('/org/business-type', { businessType, seedCatalog: true });
        await refreshCatalog();
      }
    } catch { /* offline or transient — never block the wizard */ }
    setBusy(false);
    setStep(1);
  };

  const saveProducts = async () => {
    const valid = rows.filter((r) => r.name.trim() && Number(r.price) > 0);
    setBusy(true);
    let count = 0;
    for (const row of valid) {
      try {
        await api.post('/products', { name: row.name.trim(), price: Number(row.price) });
        count += 1;
      } catch { /* plan cap or offline — carry on, they can add later */ }
    }
    if (count > 0) await refreshCatalog().catch(() => {});
    setAdded(count);
    setBusy(false);
    setStep(2);
  };

  const inputCls =
    'w-full rounded-xl border border-input bg-card px-4 text-base outline-none transition-colors focus:border-ring';

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col p-5"
         style={{ backgroundImage: 'radial-gradient(600px 300px at 50% -60px, hsl(var(--primary) / .10), transparent)' }}>

      {/* progress rail */}
      <div className="mt-2 flex items-center justify-center gap-0" aria-label={`Step ${step + 1} of 3`}>
        {STEPS.map((s, i) => (
          <div key={s.title} className="flex items-center">
            <div className="flex flex-col items-center">
              <div className={`grid size-11 place-items-center rounded-full border-2 text-lg transition-colors ${
                i < step ? 'border-success bg-success/15' : i === step ? 'border-primary bg-primary/10' : 'border-border bg-card'
              }`}>
                {i < step ? '✓' : s.icon}
              </div>
              <span className={`mt-1.5 text-[11px] font-semibold ${i === step ? 'text-primary' : 'text-muted-foreground'}`}>
                {s.title}
              </span>
            </div>
            {i < STEPS.length - 1 ? (
              <div className={`mx-2 mb-5 h-0.5 w-10 rounded ${i < step ? 'bg-success' : 'bg-border'}`} aria-hidden />
            ) : null}
          </div>
        ))}
      </div>

      {/* ------------------------------------------------ step 1: identity */}
      {step === 0 ? (
        <div className="mt-8 flex flex-1 flex-col">
          <h1 className="text-xl font-bold">Make it yours</h1>
          <p className="mt-1 text-sm text-muted-foreground">This prints on every receipt your customers take home.</p>

          <div className="mt-6 flex flex-col gap-4">
            {types.length > 0 ? (
              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                  What do you sell? <span className="font-normal normal-case">(optional)</span>
                </label>
                <p className="mt-1 text-[12.5px] text-muted-foreground">
                  Sets up your categories and switches on the tools your trade uses. Change it any time.
                </p>
                <div className="mt-2.5 grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {types.map((type) => {
                    const selected = businessType === type.value;
                    return (
                      <button
                        key={type.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setBusinessType(selected ? null : type.value)}
                        className={`pressable flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-center transition-colors ${
                          selected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-ring'
                        }`}
                      >
                        <span className="text-[20px]" aria-hidden>{TYPE_ICON[type.value] ?? '🏪'}</span>
                        <span className="text-[11px] font-semibold leading-tight">{type.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div>
              <label htmlFor="rh" className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Receipt name</label>
              <input id="rh" value={receiptHeader} onChange={(e) => setReceiptHeader(e.target.value)}
                     className={inputCls} style={{ height: 52 }} autoFocus />
            </div>
            <div>
              <label htmlFor="ph" className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Phone <span className="font-normal normal-case">(optional)</span></label>
              <input id="ph" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                     placeholder="011 234 5678" className={inputCls} style={{ height: 52 }} />
            </div>
            <div>
              <label htmlFor="ad" className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Address <span className="font-normal normal-case">(optional)</span></label>
              <input id="ad" value={address} onChange={(e) => setAddress(e.target.value)}
                     placeholder="No. 12, Galle Road, Colombo" className={inputCls} style={{ height: 52 }} />
            </div>
            <div>
              <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Language</span>
              <div className="mt-1.5 grid grid-cols-3 gap-2" role="group" aria-label="Language">
                {([['en', 'English'], ['si', 'සිංහල'], ['ta', 'தமிழ்']] as const).map(([code, label]) => (
                  <button key={code} type="button" onClick={() => setLanguage(code)} aria-pressed={language === code}
                          className={`rounded-xl text-sm font-semibold transition-colors ${language === code ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}
                          style={{ height: 48 }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-auto pt-8">
            <button onClick={() => void saveIdentity()} disabled={busy}
                    className="w-full rounded-xl bg-primary text-base font-bold text-primary-foreground disabled:opacity-60" style={{ height: 52 }}>
              {busy ? 'Saving…' : 'Continue →'}
            </button>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------ step 2: products */}
      {step === 1 ? (
        <div className="mt-8 flex flex-1 flex-col">
          <h1 className="text-xl font-bold">Add your first products</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Just a few to get started — prices in <strong>{currency}</strong>. We already added some samples you can edit or delete.
          </p>

          {/* THE magic path: skip the typing entirely. */}
          <button
            type="button"
            onClick={() => setShelfieOpen(true)}
            className="mt-5 flex items-center gap-3 rounded-2xl border-2 border-primary/40 bg-primary/10 p-4 text-left transition-transform active:scale-[.98]"
          >
            <span className="text-3xl" aria-hidden>📸</span>
            <span className="min-w-0 flex-1">
              <span className="block font-bold text-primary">Photograph your shelf or price list</span>
              <span className="block text-xs text-muted-foreground">We read the names and prices for you — any language, even handwritten.</span>
            </span>
            <span className="text-primary" aria-hidden>→</span>
          </button>

          <p className="mt-4 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">or type a few</p>

          <div className="mt-3 flex flex-col gap-2.5">
            {rows.map((row, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={row.name}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                  placeholder={['Rice 5kg', 'Milk packet', 'Soap'][i] ?? 'Product name'}
                  aria-label={`Product ${i + 1} name`}
                  className={`${inputCls} flex-1`} style={{ height: 50 }}
                  autoFocus={i === 0}
                />
                <input
                  inputMode="decimal"
                  value={row.price}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, price: e.target.value.replace(/[^\d.]/g, '') } : r)))}
                  placeholder={money(0, currency).replace(/[\d.,]+/, '0')}
                  aria-label={`Product ${i + 1} price`}
                  className={`${inputCls} tabular w-28 text-right`} style={{ height: 50 }}
                />
              </div>
            ))}
            <button type="button" onClick={() => setRows([...rows, { name: '', price: '' }])}
                    className="self-start text-sm font-semibold text-primary">
              + Add another
            </button>
          </div>

          <div className="mt-auto flex flex-col gap-2 pt-8">
            <button onClick={() => void saveProducts()} disabled={busy}
                    className="w-full rounded-xl bg-primary text-base font-bold text-primary-foreground disabled:opacity-60" style={{ height: 52 }}>
              {busy ? 'Adding…' : 'Save & continue →'}
            </button>
            <button onClick={() => setStep(2)} className="text-sm font-medium text-muted-foreground" style={{ height: 40 }}>
              Skip for now
            </button>
          </div>
        </div>
      ) : null}

      {/* --------------------------------------------------- step 3: done */}
      {step === 2 ? (
        <div className="mt-8 flex flex-1 flex-col">
          <div className="text-center">
            <p className="text-5xl" aria-hidden>🎉</p>
            <h1 className="mt-3 text-2xl font-bold">{session?.org.name} is open!</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {added > 0 ? `${added} product${added === 1 ? '' : 's'} added. ` : ''}
              Your till works right now — even offline.
            </p>
          </div>

          <div className="mt-8 flex flex-col gap-3">
            <InstallPrompt />
            <div className="rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground">
              🖨️ <strong className="text-foreground">Printing:</strong> any 80mm thermal printer works — tap Print on a receipt and pick it.
              📱 <strong className="text-foreground">Phones & tablets:</strong> open this same address, sign in, and it's a second till.
            </div>
          </div>

          <div className="mt-auto pt-8">
            <button onClick={() => navigate('/sell', { replace: true })}
                    className="w-full rounded-xl bg-success text-lg font-bold text-success-foreground transition-transform active:scale-[.98]"
                    style={{ height: 56 }}>
              Ring up your first sale →
            </button>
          </div>
        </div>
      ) : null}

      {shelfieOpen ? (
        <ShelfieImport
          onClose={() => setShelfieOpen(false)}
          onDone={(created) => {
            setShelfieOpen(false);
            setAdded((n) => n + created);
            void refreshCatalog().catch(() => {});
            setStep(2);
          }}
        />
      ) : null}
    </div>
  );
}
