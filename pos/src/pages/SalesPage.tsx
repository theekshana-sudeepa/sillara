import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/state/store';
import { money, receiptNo, timeOf } from '@/lib/format';
import { t } from '@/lib/i18n';

interface ZReport {
  date: string;
  salesCount: number;
  gross: number;
  discounts: number;
  tax: number;
  byTender: Array<{ tender: string; total: number; count: number }>;
  topItems: Array<{ name: string; qty: number; total: number }>;
}

interface SaleRow {
  id: string;
  number: number;
  total: string;
  tender: string;
  status: string;
  soldAt: string;
  cashier: { name: string } | null;
  items: Array<{ nameSnapshot: string; qty: string }>;
}

export default function SalesPage() {
  const { session, online } = useSession();
  const [report, setReport] = useState<ZReport | null>(null);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const currency = session?.org.currency ?? 'USD';

  useEffect(() => {
    if (!online) return;
    void (async () => {
      try {
        const [z, list] = await Promise.all([
          api.get<ZReport>('/sales/z-report'),
          api.get<SaleRow[]>('/sales', { pageSize: 50 }),
        ]);
        setReport(z);
        setSales(list);
      } catch {
        /* stays empty offline — the sell screen is the offline surface */
      }
    })();
  }, [online]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-border p-4">
        <h1 className="text-lg font-bold">{t('z_report')} · {t('today')}</h1>
        {!online ? <p className="mt-1 text-xs text-warning">{t('offline_banner')}</p> : null}

        {report ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">{t('gross_sales')}</p>
                <p className="tabular mt-0.5 text-2xl font-bold">{money(report.gross, currency)}</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">{t('transactions')}</p>
                <p className="tabular mt-0.5 text-2xl font-bold">{report.salesCount}</p>
              </div>
            </div>

            {report.byTender.length > 0 ? (
              <div className="mt-3 rounded-xl border border-border bg-card p-3">
                <p className="text-xs font-semibold text-muted-foreground">{t('by_tender')}</p>
                {report.byTender.map((row) => (
                  <p key={row.tender} className="mt-1.5 flex justify-between text-sm">
                    <span>{row.tender} ({row.count})</span>
                    <span className="tabular font-semibold">{money(row.total, currency)}</span>
                  </p>
                ))}
              </div>
            ) : null}

            {report.topItems.length > 0 ? (
              <div className="mt-3 rounded-xl border border-border bg-card p-3">
                <p className="text-xs font-semibold text-muted-foreground">{t('top_items')}</p>
                {report.topItems.slice(0, 5).map((item) => (
                  <p key={item.name} className="mt-1.5 flex justify-between text-sm">
                    <span className="truncate">{item.qty} × {item.name}</span>
                    <span className="tabular ml-2 shrink-0 font-semibold">{money(item.total, currency)}</span>
                  </p>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">{online ? '…' : '—'}</p>
        )}
      </div>

      <ul className="divide-y divide-border">
        {sales.map((s) => (
          <li key={s.id} className={`flex items-center gap-3 px-4 py-3 ${s.status === 'VOID' ? 'opacity-50' : ''}`}>
            <span className="min-w-0 flex-1">
              <span className="tabular block text-sm font-semibold">{receiptNo(s.number)} {s.status === 'VOID' ? '· VOID' : ''}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {timeOf(s.soldAt)} · {s.items.length} items · {s.cashier?.name ?? '—'}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">{s.tender}</span>
            <span className="tabular text-sm font-bold">{money(Number(s.total), currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
