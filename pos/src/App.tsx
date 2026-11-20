import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { CartProvider, SessionProvider, useSession } from '@/state/store';
import { onPendingChange, startSyncLoop } from '@/lib/sync';
import { t } from '@/lib/i18n';
import { Icon, type IconName } from '@/components/Icon';
import SellPage from '@/pages/SellPage';
import LoginPage from '@/pages/LoginPage';
import SignupPage from '@/pages/SignupPage';
import ActivatePage from '@/pages/ActivatePage';
import SetupWizard from '@/pages/SetupWizard';
import ProductsPage from '@/pages/ProductsPage';
import StockPage from '@/pages/StockPage';
import BusinessPage from '@/pages/BusinessPage';
import NetworkPage from '@/pages/NetworkPage';
import SalesPage from '@/pages/SalesPage';
import SettingsPage from '@/pages/SettingsPage';
import PublicReceiptPage from '@/pages/PublicReceiptPage';
import SupplierPortalPage from '@/pages/SupplierPortalPage';
import { moduleElements } from '@/modules/registry';

function Splash() {
  return (
    <div className="grid h-full place-items-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="grid size-12 place-items-center rounded-2xl bg-primary shadow-e2">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
            <path
              d="M21.5 11c0-2-1.8-3.5-5.5-3.5S10.5 9 10.5 11s2 2.8 5.5 3.5 5.5 1.5 5.5 3.5-1.8 3.5-5.5 3.5-5.5-1.5-5.5-3.5"
              stroke="hsl(var(--primary-foreground))"
              strokeWidth="2.6"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="size-5 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    </div>
  );
}

/**
 * Connection state, stated in one glance.
 *
 * A cashier needs to know one thing: are my sales safe? Three states, each
 * with its own shape as well as its own colour — colour alone fails in bright
 * daylight and fails colour-blind staff entirely.
 */
function SyncPill({ online, pending }: { online: boolean; pending: number }) {
  const state = !online ? 'offline' : pending > 0 ? 'syncing' : 'synced';

  const style = {
    offline: 'bg-warning/12 text-warning',
    syncing: 'bg-info/12 text-info',
    synced: 'bg-success/12 text-success',
  }[state];

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${style}`}
      aria-live="polite"
      title={
        state === 'offline'
          ? 'No connection — sales are saved on this device and will sync automatically'
          : state === 'syncing'
            ? `${pending} sale${pending === 1 ? '' : 's'} still uploading`
            : 'Everything is saved to the server'
      }
    >
      {state === 'offline' ? (
        <Icon name="cloudOff" size={13} strokeWidth={2} />
      ) : state === 'syncing' ? (
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
      ) : (
        <Icon name="check" size={13} strokeWidth={2.5} />
      )}
      <span className="tabular">
        {state === 'offline' ? 'Offline' : state === 'syncing' ? pending : 'Saved'}
      </span>
    </div>
  );
}

const TABS: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/sell', label: t('sell'), icon: 'receipt' },
  { to: '/products', label: t('products'), icon: 'box' },
  { to: '/stock', label: t('stock'), icon: 'inbox' },
  { to: '/network', label: t('network'), icon: 'globe' },
  { to: '/sales', label: t('sales'), icon: 'chart' },
  { to: '/business', label: t('business'), icon: 'trending' },
  { to: '/settings', label: t('settings'), icon: 'settings' },
];

/**
 * Terminal chrome: a rail on a counter screen, a thumb-reach tab bar on a
 * phone. The same seven destinations in the same order in both, because
 * muscle memory beats adaptive cleverness on a device used 600 times a day.
 */
function Shell() {
  const { online, session } = useSession();
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const stopLoop = startSyncLoop();
    const stopListen = onPendingChange(setPending);
    return () => {
      stopLoop();
      stopListen();
    };
  }, []);

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* ---- mobile / tablet header: tenant context + sync state without overlapping page actions ---- */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2 lg:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary shadow-e1" aria-hidden>
            <svg width="15" height="15" viewBox="0 0 32 32">
              <path
                d="M21.5 11c0-2-1.8-3.5-5.5-3.5S10.5 9 10.5 11s2 2.8 5.5 3.5 5.5 1.5 5.5 3.5-1.8 3.5-5.5 3.5-5.5-1.5-5.5-3.5"
                stroke="hsl(var(--primary-foreground))"
                strokeWidth="2.8"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <span className="truncate text-[13.5px] font-bold tracking-[-0.01em]">
            {session?.org.name ?? 'Sillara POS'}
          </span>
        </div>
        <SyncPill online={online} pending={pending} />
      </header>

      {/* ---- desktop rail: always visible, never in the way ------------- */}
      <nav
        aria-label="Main"
        className="hidden shrink-0 flex-col items-center gap-1 border-r border-border bg-surface px-2 py-3 lg:flex"
      >
        <div className="mb-3 grid size-9 place-items-center rounded-xl bg-primary shadow-e1" title="Sillara">
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden>
            <path
              d="M21.5 11c0-2-1.8-3.5-5.5-3.5S10.5 9 10.5 11s2 2.8 5.5 3.5 5.5 1.5 5.5 3.5-1.8 3.5-5.5 3.5-5.5-1.5-5.5-3.5"
              stroke="hsl(var(--primary-foreground))"
              strokeWidth="2.6"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </div>

        {TABS.map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            title={label}
            className={({ isActive }) =>
              `pressable relative flex w-[72px] flex-col items-center gap-1 rounded-xl py-2.5 text-[10.5px] font-semibold ${
                isActive
                  ? 'bg-primary/12 text-primary'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive ? (
                  <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" aria-hidden />
                ) : null}
                <Icon name={icon} size={21} strokeWidth={isActive ? 2 : 1.75} />
                <span className="leading-none">{label}</span>
              </>
            )}
          </NavLink>
        ))}

        <div className="mt-auto pt-2">
          <SyncPill online={online} pending={pending} />
        </div>
      </nav>

      <main className="min-h-0 min-w-0 flex-1">
        <Outlet />
      </main>

      {/* ---- phone / tablet tab bar ------------------------------------ */}
      <nav
        aria-label="Main"
        className="flex shrink-0 items-stretch border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_0_hsl(var(--border))] lg:hidden"
      >
        {TABS.map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `pressable relative flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-semibold ${
                isActive ? 'text-primary' : 'text-muted-foreground'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive ? (
                  <span className="absolute inset-x-1/2 top-0 h-[2.5px] w-7 -translate-x-1/2 rounded-b-full bg-primary" aria-hidden />
                ) : null}
                <Icon name={icon} size={20} strokeWidth={isActive ? 2 : 1.75} />
                <span className="leading-none">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  if (status === 'loading') return <Splash />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { status } = useSession();
  return (
    <Routes>
      {/* Public — no auth, no shell. This is what a customer's WhatsApp
          link opens on a phone that has never seen Sillara. */}
      <Route path="/r/:publicId" element={<PublicReceiptPage />} />

      {/* Supplier portal — a different audience entirely. Token-authed via
          ?t=, shares no session state with the shop-facing app. */}
      <Route path="/supplier" element={<SupplierPortalPage />} />

      <Route path="/login" element={status === 'ready' ? <Navigate to="/sell" replace /> : <LoginPage />} />
      <Route path="/signup" element={status === 'ready' ? <Navigate to="/sell" replace /> : <SignupPage />} />
      <Route path="/activate" element={<ActivatePage />} />
      <Route path="/setup" element={<Gate><SetupWizard /></Gate>} />
      <Route path="/welcome" element={<Gate><SetupWizard /></Gate>} />
      <Route element={<Gate><Shell /></Gate>}>
        <Route path="/sell" element={<CartProvider><SellPage /></CartProvider>} />
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/stock" element={<StockPage />} />
        <Route path="/network" element={<NetworkPage />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/business" element={<BusinessPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {/* Vertical modules. Declared once in modules/registry.tsx; each is
            code-split and gated on its capability, so a shop only downloads
            what it can actually use. */}
        {moduleElements.map(({ path, Element }) => (
          <Route key={path} path={`/${path}`} element={<Element />} />
        ))}
      </Route>
      <Route path="*" element={<Navigate to="/sell" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  );
}
