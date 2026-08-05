import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCart, useSession } from '@/state/store';
import { findByBarcode, getCachedCategories, getCachedProducts, onCatalogChange, mintPublicId, nextLocalNumber, queueSale, type CachedCategory, type CachedProduct } from '@/lib/db';
import { flushOutbox } from '@/lib/sync';
import { money } from '@/lib/format';
import { t } from '@/lib/i18n';
import { Receipt, type ReceiptData } from '@/components/Receipt';
import { CustomerPicker, type PickedCustomer } from '@/components/CustomerPicker';
import { ShiftPanel, type Shift } from '@/components/ShiftPanel';
import { api } from '@/lib/api';
import { Icon } from '@/components/Icon';

type Tender = 'CASH' | 'CARD' | 'QR';

export default function SellPage() {
  const { session, online } = useSession();
  const { cart, dispatch, total, subtotal } = useCart();

  const [products, setProducts] = useState<CachedProduct[]>([]);
  const [categories, setCategories] = useState<CachedCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [tender, setTender] = useState<Tender>('CASH');
  const [tendered, setTendered] = useState('');
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shift, setShift] = useState<Shift | null>(null);
  const [shiftOpen, setShiftOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const currency = session?.org.currency ?? 'USD';

  /**
   * A paused shop must not be able to queue sales. The outbox would accept
   * them happily and retry into a 402 forever — the cashier would serve a
   * whole day before anyone noticed the sales were going nowhere.
   */
  const paused = session?.org.status === 'SUSPENDED' || session?.org.status === 'CANCELLED';

  const loadCatalog = useCallback(async () => {
    setProducts(await getCachedProducts());
    setCategories(await getCachedCategories());
  }, []);

  // Read the cache now, and again whenever the background refresh lands —
  // on a fresh signup the till mounts before the first bootstrap returns.
  useEffect(() => {
    void loadCatalog();
    return onCatalogChange(() => void loadCatalog());
  }, [loadCatalog]);

  // Shift state is advisory — the till sells with or without one. We fetch it
  // so the header can show "no shift open" rather than blocking a sale.
  useEffect(() => {
    if (!online) return;
    void api.get<Shift | null>('/shifts/current').then(setShift).catch(() => {});
  }, [online]);

  /**
   * Barcode scanners are keyboards that type fast and press Enter. Any
   * digit-burst ending in Enter while the search box holds a known barcode
   * adds the item and clears the box — no dedicated "scan mode" needed.
   */
  const onSearchKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || !search.trim()) return;
    const hit = await findByBarcode(search.trim());
    if (hit) {
      dispatch({ type: 'add', product: hit });
      setSearch('');
    }
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products
      .filter((p) => p.isActive)
      .filter((p) => (activeCategory ? p.categoryId === activeCategory : true))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q) || p.barcode?.includes(q) : true))
      .slice(0, 120);
  }, [products, activeCategory, search]);

  // Loyalty discount is INDICATIVE here — the server recomputes it on sync
  // from the real balance. Never let a device decide what points are worth.
  const loyaltyDiscount = customer && redeemPoints > 0
    ? Math.min(Math.round(redeemPoints * customer.redeemValue * 100) / 100, total)
    : 0;
  const payable = Math.max(0, Math.round((total - loyaltyDiscount) * 100) / 100);
  const tenderedNum = Number(tendered) || 0;
  const change = tender === 'CASH' ? Math.max(0, tenderedNum - payable) : 0;
  const canComplete = !paused && cart.lines.length > 0 && (tender !== 'CASH' || tenderedNum >= payable);

  /**
   * Completing a sale NEVER touches the network. Queue to IndexedDB, show the
   * receipt, kick a background flush. Latency from tap to receipt is the
   * whole UX — and it is identical online and offline.
   */
  const completeSale = async () => {
    if (!canComplete || !session) return;

    const localNumber = await nextLocalNumber();
    const clientUuid = crypto.randomUUID();
    const publicId = mintPublicId();
    const soldAt = new Date().toISOString();

    await queueSale({
      clientUuid,
      publicId,
      registerId: null,
      branchId: null,
      shiftId: shift?.id ?? null,
      redeemPoints: customer ? redeemPoints : 0,
      customerId: customer?.id ?? null,
      items: cart.lines.map((l) => ({
        productId: l.productId,
        name: l.name,
        unitPrice: l.unitPrice,
        qty: l.qty,
        // Null, not 0. The server resolves the rate from the product, then the
        // shop's default — sending 0 here would zero-rate the whole basket.
        taxRate: null,
        lineDiscount: l.lineDiscount,
      })),
      discount: cart.discount,
      tender,
      tendered: tender === 'CASH' ? tenderedNum : payable,
      soldAt,
      localNumber,
      total: payable,
      attempts: 0,
    });

    setReceipt({
      number: localNumber,
      publicId,
      offline: true,
      soldAt,
      lines: cart.lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.unitPrice * l.qty - l.lineDiscount })),
      subtotal,
      discount: cart.discount + loyaltyDiscount,
      total: payable,
      tender,
      tendered: tender === 'CASH' ? tenderedNum : payable,
      change,
      org: session.org,
    });

    dispatch({ type: 'clear' });
    setPayOpen(false);
    setTendered('');
    setCustomer(null);
    setRedeemPoints(0);
    void flushOutbox();
  };

  // Fast-cash denominations adapt to the currency's magnitude.
  const quickCash = useMemo(() => {
    const bills = currency === 'LKR' ? [100, 500, 1000, 5000] : [1, 5, 10, 20, 50, 100];
    const exact = Math.ceil(payable);
    const ups = bills.filter((b) => b >= payable).slice(0, 3);
    return [...new Set([exact, ...ups])].slice(0, 4);
  }, [currency, payable]);

  const cartCount = cart.lines.reduce((s, l) => s + l.qty, 0);

  return (
    <div className="flex h-full bg-background">
      {/* ------------------------------------------------ product grid --- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {paused ? (
          <div
            role="alert"
            className="flex items-center justify-center gap-2 bg-destructive/12 px-4 py-2.5 text-[13px] font-semibold text-destructive"
          >
            <Icon name="alert" size={16} strokeWidth={2} />
            Selling is paused — a sale rung up now could never be synced. Settings → billing.
          </div>
        ) : !online ? (
          <div
            role="status"
            className="flex items-center justify-center gap-2 bg-warning/12 px-4 py-2 text-[13px] font-semibold text-warning"
          >
            <Icon name="cloudOff" size={15} strokeWidth={2} />
            {t('offline_banner')}
          </div>
        ) : null}

        {/* ---- search + shift ------------------------------------------ */}
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2.5">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle-foreground">
              <Icon name="search" size={18} />
            </span>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => void onSearchKey(e)}
              placeholder={t('search_products')}
              aria-label={t('search_products')}
              className="h-12 w-full rounded-xl border border-input bg-background pl-11 pr-4 text-[15px] font-medium outline-none transition-colors placeholder:font-normal placeholder:text-subtle-foreground focus:border-ring"
              autoFocus
            />
          </div>
          <button
            onClick={() => setShiftOpen(true)}
            className={`pressable flex h-12 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold ${
              shift
                ? 'bg-success/12 text-success'
                : 'bg-secondary text-muted-foreground hover:bg-secondary-hover'
            }`}
            title={shift ? 'Shift open — tap to close' : 'No shift open — tap to start'}
          >
            <Icon name="clock" size={17} strokeWidth={2} />
            <span className="max-sm:hidden">{shift ? 'Shift open' : 'Start shift'}</span>
          </button>
        </div>

        {/* ---- customer: attaching one is what turns on loyalty --------- */}
        <button
          onClick={() => setPickerOpen(true)}
          className={`pressable flex items-center gap-2.5 border-b border-border px-4 py-2.5 text-left text-[13px] ${
            customer ? 'bg-primary/8' : 'bg-surface hover:bg-secondary'
          }`}
        >
          <span className={customer ? 'text-primary' : 'text-subtle-foreground'}>
            <Icon name="user" size={17} strokeWidth={2} />
          </span>
          {customer ? (
            <>
              <span className="flex-1 truncate font-semibold text-primary">{customer.name}</span>
              <span className="tabular rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-bold text-primary">
                {customer.points} pts
              </span>
            </>
          ) : (
            <span className="flex-1 font-medium text-muted-foreground">Add customer for loyalty points</span>
          )}
          <span className="text-subtle-foreground">
            <Icon name="chevronRight" size={15} />
          </span>
        </button>

        {/* ---- categories ---------------------------------------------- */}
        <div className="flex gap-2 overflow-x-auto border-b border-border bg-surface px-3 py-2.5">
          <button
            onClick={() => setActiveCategory(null)}
            aria-pressed={activeCategory === null}
            className={`pressable h-9 shrink-0 rounded-lg px-4 text-[13px] font-semibold ${
              activeCategory === null
                ? 'bg-foreground text-background'
                : 'bg-secondary text-muted-foreground hover:bg-secondary-hover hover:text-foreground'
            }`}
          >
            All
          </button>
          {categories.map((c) => {
            const active = activeCategory === c.id;
            return (
              <button
                key={c.id}
                onClick={() => setActiveCategory(active ? null : c.id)}
                aria-pressed={active}
                className={`pressable flex h-9 shrink-0 items-center gap-2 rounded-lg px-3.5 text-[13px] font-semibold ${
                  active ? 'text-foreground' : 'bg-secondary text-muted-foreground hover:bg-secondary-hover'
                }`}
                style={active ? { background: `${c.color}26`, boxShadow: `inset 0 0 0 1.5px ${c.color}` } : undefined}
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden />
                {c.name}
              </button>
            );
          })}
        </div>

        {/* ---- the grid ------------------------------------------------- */}
        <div className="grid flex-1 auto-rows-min grid-cols-2 content-start gap-2.5 overflow-y-auto p-3 pb-28 sm:grid-cols-3 lg:grid-cols-4 lg:pb-3 2xl:grid-cols-5">
          {visible.length === 0 ? (
            <div className="col-span-full flex flex-col items-center gap-3 py-20 text-center">
              <span className="text-subtle-foreground">
                <Icon name="box" size={38} strokeWidth={1.4} />
              </span>
              <p className="text-sm font-medium text-muted-foreground">
                {search ? `Nothing matches “${search}”` : 'No products yet'}
              </p>
            </div>
          ) : (
            visible.map((p) => {
              const cat = categories.find((c) => c.id === p.categoryId);
              const out = p.trackStock && p.stockQty <= 0;
              return (
                <button
                  key={p.id}
                  onClick={() => dispatch({ type: 'add', product: p })}
                  className="pressable group relative flex min-h-[104px] flex-col justify-between overflow-hidden rounded-2xl border border-border bg-card p-3.5 text-left shadow-e1 hover:border-border-strong hover:shadow-e2"
                >
                  {/* Category reads as a colour edge, not a coloured price. */}
                  {cat ? (
                    <span
                      className="absolute inset-x-0 top-0 h-[3px]"
                      style={{ background: cat.color }}
                      aria-hidden
                    />
                  ) : null}

                  <span className="line-clamp-2 pt-0.5 text-[14.5px] font-semibold leading-snug tracking-[-0.01em]">
                    {p.name}
                  </span>

                  <span className="mt-2 flex items-end justify-between gap-2">
                    <span className="money text-[17px] font-bold">{money(p.price, currency)}</span>
                    {p.trackStock ? (
                      <span
                        className={`tabular rounded-md px-1.5 py-0.5 text-[10.5px] font-bold ${
                          out ? 'bg-destructive/12 text-destructive' : 'bg-secondary text-subtle-foreground'
                        }`}
                      >
                        {out ? 'Out' : p.stockQty}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ------------------------------------------------------- cart --- */}
      <aside className="flex w-[368px] shrink-0 flex-col border-l border-border bg-surface max-lg:hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-[13px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Current sale
          </h2>
          {cartCount > 0 ? (
            <button
              onClick={() => dispatch({ type: 'clear' })}
              className="pressable rounded-lg px-2 py-1 text-[12px] font-semibold text-muted-foreground hover:bg-secondary hover:text-destructive"
            >
              Clear
            </button>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {cart.lines.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <span className="text-subtle-foreground">
                <Icon name="receipt" size={36} strokeWidth={1.4} />
              </span>
              <p className="text-sm font-medium text-muted-foreground">Tap a product to start</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {cart.lines.map((l) => (
                <li key={l.key} className="rise-in rounded-xl border border-border bg-card p-3 shadow-e1">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-[14px] font-semibold leading-snug tracking-[-0.01em]">{l.name}</span>
                    <span className="money shrink-0 text-[15px] font-bold">
                      {money(l.unitPrice * l.qty, currency)}
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-center gap-1">
                    <button
                      onClick={() => dispatch({ type: 'qty', key: l.key, qty: l.qty - 1 })}
                      aria-label="Decrease quantity"
                      className="pressable grid size-9 place-items-center rounded-lg bg-secondary text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
                    >
                      <Icon name="minus" size={16} strokeWidth={2.5} />
                    </button>
                    <span className="tabular w-10 text-center text-[15px] font-bold">{l.qty}</span>
                    <button
                      onClick={() => dispatch({ type: 'qty', key: l.key, qty: l.qty + 1 })}
                      aria-label="Increase quantity"
                      className="pressable grid size-9 place-items-center rounded-lg bg-secondary text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
                    >
                      <Icon name="plus" size={16} strokeWidth={2.5} />
                    </button>
                    <span className="ml-2 text-[12px] text-subtle-foreground">
                      {money(l.unitPrice, currency)} each
                    </span>
                    <button
                      onClick={() => dispatch({ type: 'remove', key: l.key })}
                      aria-label={`Remove ${l.name}`}
                      className="pressable ml-auto grid size-9 place-items-center rounded-lg text-subtle-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Icon name="close" size={15} strokeWidth={2.2} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ---- the total: the largest thing on the screen --------------- */}
        <div className="border-t border-border bg-card px-4 pb-4 pt-3.5 shadow-[0_-1px_0_0_hsl(var(--border))]">
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[13px] text-muted-foreground">
              <span>{t('subtotal')}</span>
              <span className="tabular font-medium">{money(subtotal, currency)}</span>
            </div>
            {cart.discount > 0 ? (
              <div className="flex justify-between text-[13px] text-muted-foreground">
                <span>{t('discount')}</span>
                <span className="tabular font-medium">−{money(cart.discount, currency)}</span>
              </div>
            ) : null}
            {loyaltyDiscount > 0 ? (
              <div className="flex justify-between text-[13px] font-semibold text-primary">
                <span>Points</span>
                <span className="tabular">−{money(loyaltyDiscount, currency)}</span>
              </div>
            ) : null}
          </div>

          <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
            <span className="text-[12px] font-bold uppercase tracking-[0.09em] text-muted-foreground">
              {t('total')}
            </span>
            <span className="money text-[30px] font-extrabold leading-none">{money(payable, currency)}</span>
          </div>

          <button
            onClick={() => setPayOpen(true)}
            disabled={paused || cart.lines.length === 0}
            className="pressable mt-3.5 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary text-[16px] font-bold text-primary-foreground shadow-e2 hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-35 disabled:shadow-none"
          >
            {t('charge')}
            {cartCount > 0 ? (
              <span className="tabular rounded-md bg-black/15 px-1.5 py-0.5 text-[12px]">{cartCount}</span>
            ) : null}
          </button>
        </div>
      </aside>

      {/* ---- phone charge bar: sits ABOVE the tab bar, never over it ---- */}
      {cart.lines.length > 0 ? (
        <div className="sheet-in fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+58px)] z-20 border-t border-border bg-surface px-3 py-2.5 shadow-[0_-6px_20px_-8px_hsl(240_40%_5%/0.25)] lg:hidden">
          <button
            onClick={() => setPayOpen(true)}
            disabled={paused}
            className="pressable flex h-14 w-full items-center justify-between rounded-xl bg-primary px-4 text-primary-foreground shadow-e2 disabled:pointer-events-none disabled:opacity-35"
          >
            <span className="flex items-center gap-2 text-[15px] font-bold">
              <span className="tabular grid size-6 place-items-center rounded-md bg-black/15 text-[12px]">
                {cartCount}
              </span>
              {t('charge')}
            </span>
            <span className="money text-[19px] font-extrabold">{money(payable, currency)}</span>
          </button>
        </div>
      ) : null}

      {/* ---------------------------------------------------- pay sheet --- */}
      {payOpen ? (
        <div
          className="scrim-in fixed inset-0 z-50 flex items-end justify-center bg-black/55 backdrop-blur-[3px] sm:items-center"
          onClick={() => setPayOpen(false)}
        >
          <div
            role="dialog"
            aria-label="Take payment"
            className="sheet-in w-full max-w-[440px] rounded-t-3xl border border-border bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-e3 sm:rounded-3xl sm:pb-5"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Grab handle: says "this sheet dismisses" without a label. */}
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-border-strong sm:hidden" aria-hidden />

            <div className="text-center">
              <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                {t('total')}
              </p>
              <p className="money mt-1 text-[44px] font-extrabold leading-none">{money(payable, currency)}</p>
              {loyaltyDiscount > 0 ? (
                <p className="money mt-1.5 text-[13px] text-subtle-foreground line-through">
                  {money(total, currency)}
                </p>
              ) : null}
            </div>

            {customer && customer.canRedeem ? (
              <div className="mt-4 rounded-2xl border border-primary/25 bg-primary/8 p-3">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[13px] font-bold text-primary">
                    <Icon name="user" size={14} strokeWidth={2.2} />
                    {customer.name}
                  </span>
                  <span className="tabular text-[12px] font-semibold text-muted-foreground">
                    {customer.points} points
                  </span>
                </div>
                <div className="mt-2.5 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setRedeemPoints(0)}
                    aria-pressed={redeemPoints === 0}
                    className={`pressable h-10 rounded-xl text-[13px] font-bold ${
                      redeemPoints === 0 ? 'bg-primary text-primary-foreground shadow-e1' : 'bg-secondary text-muted-foreground'
                    }`}
                  >
                    Don&rsquo;t use
                  </button>
                  <button
                    onClick={() => setRedeemPoints(customer.points)}
                    aria-pressed={redeemPoints > 0}
                    className={`pressable h-10 rounded-xl text-[13px] font-bold ${
                      redeemPoints > 0 ? 'bg-primary text-primary-foreground shadow-e1' : 'bg-secondary text-muted-foreground'
                    }`}
                  >
                    Use −{money(Math.min(customer.points * customer.redeemValue, total), currency)}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="mt-4 grid grid-cols-3 gap-2" role="group" aria-label="Payment method">
              {(['CASH', 'CARD', 'QR'] as const).map((m) => {
                const active = tender === m;
                return (
                  <button
                    key={m}
                    onClick={() => setTender(m)}
                    aria-pressed={active}
                    className={`pressable flex h-[54px] flex-col items-center justify-center gap-1 rounded-xl text-[12.5px] font-bold ${
                      active
                        ? 'bg-primary text-primary-foreground shadow-e2'
                        : 'bg-secondary text-muted-foreground hover:bg-secondary-hover hover:text-foreground'
                    }`}
                  >
                    <Icon name={m === 'CASH' ? 'cash' : m === 'CARD' ? 'card' : 'qr'} size={19} strokeWidth={active ? 2 : 1.75} />
                    {t(m.toLowerCase() as 'cash' | 'card' | 'qr')}
                  </button>
                );
              })}
            </div>

            {tender === 'CASH' ? (
              <>
                <input
                  inputMode="decimal"
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ''))}
                  placeholder={t('tendered')}
                  aria-label={t('tendered')}
                  className="money mt-3 h-16 w-full rounded-xl border-2 border-input bg-background px-4 text-center text-[26px] font-bold outline-none transition-colors placeholder:text-[15px] placeholder:font-medium placeholder:text-subtle-foreground focus:border-ring"
                />
                <div className="mt-2 grid grid-cols-4 gap-2">
                  {quickCash.map((amount) => (
                    <button
                      key={amount}
                      onClick={() => setTendered(String(amount))}
                      className="pressable money h-11 rounded-xl bg-secondary text-[13px] font-bold text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
                    >
                      {money(amount, currency)}
                    </button>
                  ))}
                </div>
                {tenderedNum >= payable && payable > 0 ? (
                  <div className="rise-in mt-3 flex items-center justify-between rounded-xl bg-success/12 px-4 py-3">
                    <span className="text-[13px] font-bold uppercase tracking-[0.06em] text-success">
                      {t('change_due')}
                    </span>
                    <span className="money text-[24px] font-extrabold text-success">{money(change, currency)}</span>
                  </div>
                ) : null}
              </>
            ) : null}

            <button
              onClick={() => void completeSale()}
              disabled={!canComplete}
              className="pressable mt-4 flex h-16 w-full items-center justify-center gap-2 rounded-xl bg-success text-[17px] font-bold text-success-foreground shadow-e2 disabled:pointer-events-none disabled:opacity-35 disabled:shadow-none"
            >
              <Icon name="check" size={20} strokeWidth={2.6} />
              {t('complete_sale')}
            </button>
          </div>
        </div>
      ) : null}

      {pickerOpen ? (
        <CustomerPicker
          onClose={() => setPickerOpen(false)}
          onPick={(picked) => {
            setCustomer(picked);
            setRedeemPoints(0);
            setPickerOpen(false);
          }}
        />
      ) : null}

      {shiftOpen ? (
        <ShiftPanel onClose={() => setShiftOpen(false)} onChanged={(next) => setShift(next)} />
      ) : null}

      {receipt ? <Receipt data={receipt} onClose={() => { setReceipt(null); searchRef.current?.focus(); }} /> : null}
    </div>
  );
}
