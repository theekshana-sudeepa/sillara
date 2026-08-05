import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { money, dateOf, timeOf, receiptNo } from '@/lib/format';

interface PublicReceipt {
  number: number;
  soldAt: string;
  currency: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  tender: string;
  tendered: number;
  change: number;
  items: Array<{ name: string; qty: number; unitPrice: number; lineTotal: number }>;
  shop: { name: string; address: string | null; phone: string | null; taxId: string | null; footer: string | null };
}

type State = { phase: 'loading' } | { phase: 'ready'; receipt: PublicReceipt } | { phase: 'missing' };

/**
 * The customer-facing receipt — opened from a WhatsApp link, on a phone that
 * has never heard of Sillara. Three jobs, in order:
 *   1. Show the receipt instantly (no auth, no app, no signup).
 *   2. Look better than the paper slip it replaces.
 *   3. Convert: every view ends with "run your shop on Sillara".
 *
 * Deliberately fetches raw rather than using the authed api client — this
 * route must work with no token, no cached org, no service worker.
 */
export default function PublicReceiptPage() {
  const { publicId = '' } = useParams();
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    const base = import.meta.env.VITE_API_URL ?? '';
    fetch(`${base}/api/v1/public/receipt/${publicId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then((j: { data: PublicReceipt }) => setState({ phase: 'ready', receipt: j.data }))
      .catch(() => setState({ phase: 'missing' }));
  }, [publicId]);

  if (state.phase === 'loading') {
    return (
      <div className="grid min-h-full place-items-center bg-background">
        <div className="size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    );
  }

  if (state.phase === 'missing') {
    return (
      <div className="grid min-h-full place-items-center bg-background p-6 text-center">
        <div>
          <p className="text-4xl" aria-hidden>🧾</p>
          <h1 className="mt-3 text-lg font-bold">Receipt not found</h1>
          <p className="mt-1 text-sm text-muted-foreground">This link may be mistyped or the sale was cancelled.</p>
          <a href="https://sillara.com" className="mt-6 inline-block rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-foreground">
            What is Sillara?
          </a>
        </div>
      </div>
    );
  }

  const r = state.receipt;

  return (
    <div className="min-h-full bg-secondary/40 px-4 py-8">
      <div className="mx-auto max-w-sm">
        <div className="overflow-hidden rounded-2xl bg-card shadow-lg">
          {/* torn-paper top edge */}
          <div
            className="h-3 bg-primary"
            style={{ maskImage: 'radial-gradient(circle at 6px 12px, transparent 5px, black 5px)', maskSize: '12px 12px' }}
            aria-hidden
          />

          <div className="p-6 font-mono text-[13px] leading-relaxed">
            <div className="text-center">
              <p className="text-base font-bold">{r.shop.name}</p>
              {r.shop.address ? <p className="text-muted-foreground">{r.shop.address}</p> : null}
              {r.shop.phone ? <p className="text-muted-foreground">{r.shop.phone}</p> : null}
              {r.shop.taxId ? <p className="text-muted-foreground">TAX: {r.shop.taxId}</p> : null}
            </div>

            <div className="my-4 border-t border-dashed border-border" />
            <div className="flex justify-between text-muted-foreground">
              <span>{receiptNo(r.number)}</span>
              <span>{dateOf(r.soldAt)} {timeOf(r.soldAt)}</span>
            </div>
            <div className="my-4 border-t border-dashed border-border" />

            {r.items.map((l, i) => (
              <div key={i} className="mb-1.5">
                <p>{l.name}</p>
                <p className="flex justify-between">
                  <span className="tabular text-muted-foreground">  {l.qty} × {money(l.unitPrice, r.currency)}</span>
                  <span className="tabular">{money(l.lineTotal, r.currency)}</span>
                </p>
              </div>
            ))}

            <div className="my-4 border-t border-dashed border-border" />
            <p className="flex justify-between"><span>Subtotal</span><span className="tabular">{money(r.subtotal, r.currency)}</span></p>
            {r.discount > 0 ? (
              <p className="flex justify-between"><span>Discount</span><span className="tabular">−{money(r.discount, r.currency)}</span></p>
            ) : null}
            {r.tax > 0 ? <p className="flex justify-between"><span>Tax</span><span className="tabular">{money(r.tax, r.currency)}</span></p> : null}
            <p className="mt-1 flex justify-between text-base font-bold"><span>TOTAL</span><span className="tabular">{money(r.total, r.currency)}</span></p>
            <p className="flex justify-between text-muted-foreground"><span>{r.tender}</span><span className="tabular">{money(r.tendered, r.currency)}</span></p>
            {r.change > 0 ? (
              <p className="flex justify-between text-muted-foreground"><span>Change</span><span className="tabular">{money(r.change, r.currency)}</span></p>
            ) : null}

            <div className="my-4 border-t border-dashed border-border" />
            <p className="text-center">{r.shop.footer ?? 'Thank you!'}</p>
          </div>
        </div>

        {/* the conversion half — this is why receipts are the growth loop */}
        <div className="mt-5 rounded-2xl border border-border bg-card p-5 text-center">
          <p className="text-sm font-semibold">Run a shop?</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {r.shop.name} sends receipts with <strong className="text-foreground">Sillara</strong> — a point of sale that
            works offline and sets itself up in minutes.
          </p>
          <a
            href="https://sillara.com"
            className="mt-4 inline-block w-full rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-foreground"
          >
            Start free →
          </a>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">Powered by Sillara · sillara.com</p>
      </div>
    </div>
  );
}
