import { money, receiptNo, timeOf } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { CachedOrg } from '@/lib/db';
import { Icon } from '@/components/Icon';

export interface ReceiptData {
  number: number;
  /** Public receipt id — becomes sillara.com/r/<id> on the WhatsApp share. */
  publicId: string;
  offline: boolean;
  soldAt: string;
  lines: Array<{ name: string; qty: number; unitPrice: number; lineTotal: number }>;
  subtotal: number;
  discount: number;
  total: number;
  tender: string;
  tendered: number;
  change: number;
  org: CachedOrg;
}

/**
 * The receipt is the growth loop: every printed or WhatsApp'd receipt carries
 * "Powered by Sillara — sillara.com". A busy shop hands out 200 a day.
 *
 * Print styling targets 80mm thermal paper via the @media print block in
 * globals.css (.receipt-paper). Browser print → "POS-80" printer profile.
 */
export function Receipt({ data, onClose }: { data: ReceiptData; onClose: () => void }) {
  const { org } = data;
  const currency = org.currency;

  // The growth loop: every shared receipt carries a public link back to us.
  const publicUrl = `${window.location.origin}/r/${data.publicId}`;

  const whatsappText = encodeURIComponent(
    [
      `🧾 ${org.receiptHeader ?? org.name}`,
      `${t('receipt')} ${receiptNo(data.number, data.offline)} · ${timeOf(data.soldAt)}`,
      '',
      ...data.lines.map((l) => `${l.qty} × ${l.name} — ${money(l.lineTotal, currency)}`),
      '',
      `${t('total')}: ${money(data.total, currency)}`,
      '',
      `View receipt: ${publicUrl}`,
      '',
      org.receiptFooter ?? '',
    ].join('\n'),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[92vh] w-full max-w-sm flex-col rounded-2xl bg-card">
        <div className="receipt-paper flex-1 overflow-y-auto p-6 font-mono text-[13px] leading-relaxed">
          <div className="text-center">
            <p className="text-base font-bold">{org.receiptHeader ?? org.name}</p>
            {org.address ? <p className="text-muted-foreground">{org.address}</p> : null}
            {org.phone ? <p className="text-muted-foreground">{org.phone}</p> : null}
            {org.taxId ? <p className="text-muted-foreground">TAX: {org.taxId}</p> : null}
          </div>

          <div className="my-3 border-t border-dashed border-border" />
          <div className="flex justify-between text-muted-foreground">
            <span>{receiptNo(data.number, data.offline)}</span>
            <span>{timeOf(data.soldAt)}</span>
          </div>
          <div className="my-3 border-t border-dashed border-border" />

          {data.lines.map((l, i) => (
            <div key={i} className="mb-1">
              <p>{l.name}</p>
              <p className="flex justify-between">
                <span className="tabular text-muted-foreground">  {l.qty} × {money(l.unitPrice, currency)}</span>
                <span className="tabular">{money(l.lineTotal, currency)}</span>
              </p>
            </div>
          ))}

          <div className="my-3 border-t border-dashed border-border" />
          <p className="flex justify-between"><span>{t('subtotal')}</span><span className="tabular">{money(data.subtotal, currency)}</span></p>
          {data.discount > 0 ? (
            <p className="flex justify-between"><span>{t('discount')}</span><span className="tabular">−{money(data.discount, currency)}</span></p>
          ) : null}
          <p className="flex justify-between text-base font-bold"><span>{t('total')}</span><span className="tabular">{money(data.total, currency)}</span></p>
          <p className="flex justify-between text-muted-foreground"><span>{data.tender}</span><span className="tabular">{money(data.tendered, currency)}</span></p>
          {data.change > 0 ? (
            <p className="flex justify-between text-muted-foreground"><span>{t('change_due')}</span><span className="tabular">{money(data.change, currency)}</span></p>
          ) : null}

          <div className="my-3 border-t border-dashed border-border" />
          <p className="text-center">{org.receiptFooter ?? t('thank_you')}</p>
          <p className="mt-1 text-center text-[10px] text-muted-foreground">{t('powered_by')}</p>
        </div>

        <div className="no-print grid grid-cols-3 gap-2 border-t border-border p-3">
          <button
            onClick={() => window.print()}
            className="pressable flex h-12 items-center justify-center gap-1.5 rounded-xl bg-secondary text-[13px] font-semibold text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
          >
            <Icon name="printer" size={16} strokeWidth={2} />
            {t('print')}
          </button>
          <a
            href={`https://wa.me/?text=${whatsappText}`}
            target="_blank"
            rel="noreferrer noopener"
            className="pressable flex h-12 items-center justify-center gap-1.5 rounded-xl bg-[#25D366] text-[13px] font-semibold text-white shadow-e1"
          >
            <Icon name="share" size={16} strokeWidth={2} />
            {t('whatsapp')}
          </a>
          <button
            onClick={onClose}
            className="pressable flex h-12 items-center justify-center gap-1.5 rounded-xl bg-primary text-[13px] font-bold text-primary-foreground shadow-e1 hover:bg-primary-hover"
          >
            <Icon name="plus" size={16} strokeWidth={2.4} />
            {t('new_sale')}
          </button>
        </div>
      </div>
    </div>
  );
}
