import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState } from 'react';
import { api, getToken, setToken } from '@/lib/api';
import { cacheBootstrap, getCachedOrg, type CachedOrg, type CachedProduct } from '@/lib/db';
import { setLang, type Lang } from '@/lib/i18n';

// --- session ----------------------------------------------------------------

export interface Session {
  user: { id: string; name: string; email: string; role: 'OWNER' | 'MANAGER' | 'CASHIER' };
  org: CachedOrg;
}

interface SessionContextValue {
  session: Session | null;
  status: 'loading' | 'ready' | 'anonymous';
  online: boolean;
  signIn: (token: string, session: Session) => void;
  signOut: () => void;
  refreshCatalog: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<SessionContextValue['status']>('loading');
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const refreshCatalog = useCallback(async () => {
    const payload = await api.get<Parameters<typeof cacheBootstrap>[0] & { org: CachedOrg }>('/products/bootstrap');
    await cacheBootstrap(payload);
  }, []);

  /**
   * Boot order is offline-first by design:
   *   1. token + cached org present → open the till IMMEDIATELY from cache
   *   2. then try the network in the background to refresh the catalog
   * A POS that shows a spinner because the router is down is a failed POS.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getToken()) {
        setStatus('anonymous');
        return;
      }
      const cachedOrg = await getCachedOrg();
      if (cachedOrg && !cancelled) {
        setSession({ user: { id: '', name: '', email: '', role: 'CASHIER' }, org: cachedOrg });
        setLang((cachedOrg.language as Lang) ?? 'en');
        setStatus('ready');
      }
      try {
        const me = await api.get<{ user: Session['user']; org: CachedOrg & { status: string; plan: string } }>('/auth/me');
        if (cancelled) return;
        setSession({ user: me.user, org: me.org });
        setLang((me.org.language as Lang) ?? 'en');
        setStatus('ready');
        await refreshCatalog();
      } catch {
        // Offline with a cache → keep selling. No cache and no network → login.
        if (!cachedOrg && !cancelled) setStatus('anonymous');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshCatalog]);

  const signIn = useCallback((token: string, s: Session) => {
    setToken(token);
    setSession(s);
    setLang((s.org.language as Lang) ?? 'en');
    setStatus('ready');
    void refreshCatalog();
  }, [refreshCatalog]);

  const signOut = useCallback(() => {
    setToken(null);
    setSession(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo(
    () => ({ session, status, online, signIn, signOut, refreshCatalog }),
    [session, status, online, signIn, signOut, refreshCatalog],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside provider');
  return ctx;
}

// --- cart -------------------------------------------------------------------

export interface CartLine {
  key: string;
  productId: string | null;
  name: string;
  unitPrice: number;
  qty: number;
  lineDiscount: number;
}

type CartAction =
  | { type: 'add'; product: CachedProduct }
  | { type: 'custom'; name: string; unitPrice: number }
  | { type: 'qty'; key: string; qty: number }
  | { type: 'remove'; key: string }
  | { type: 'discount'; amount: number }
  | { type: 'clear' };

interface CartState {
  lines: CartLine[];
  discount: number;
}

function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add': {
      const existing = state.lines.find((l) => l.productId === action.product.id);
      if (existing) {
        return {
          ...state,
          lines: state.lines.map((l) => (l.key === existing.key ? { ...l, qty: l.qty + 1 } : l)),
        };
      }
      return {
        ...state,
        lines: [
          ...state.lines,
          {
            key: crypto.randomUUID(),
            productId: action.product.id,
            name: action.product.name,
            unitPrice: action.product.price,
            qty: 1,
            lineDiscount: 0,
          },
        ],
      };
    }
    case 'custom':
      return {
        ...state,
        lines: [
          ...state.lines,
          { key: crypto.randomUUID(), productId: null, name: action.name, unitPrice: action.unitPrice, qty: 1, lineDiscount: 0 },
        ],
      };
    case 'qty':
      if (action.qty <= 0) return { ...state, lines: state.lines.filter((l) => l.key !== action.key) };
      return { ...state, lines: state.lines.map((l) => (l.key === action.key ? { ...l, qty: action.qty } : l)) };
    case 'remove':
      return { ...state, lines: state.lines.filter((l) => l.key !== action.key) };
    case 'discount':
      return { ...state, discount: Math.max(0, action.amount) };
    case 'clear':
      return { lines: [], discount: 0 };
    default:
      return state;
  }
}

const CartContext = createContext<{
  cart: CartState;
  dispatch: React.Dispatch<CartAction>;
  total: number;
  subtotal: number;
} | null>(null);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, dispatch] = useReducer(cartReducer, { lines: [], discount: 0 });

  const subtotal = useMemo(
    () => cart.lines.reduce((s, l) => s + l.unitPrice * l.qty - l.lineDiscount, 0),
    [cart.lines],
  );
  const total = Math.max(0, subtotal - cart.discount);

  const value = useMemo(() => ({ cart, dispatch, total, subtotal }), [cart, total, subtotal]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart outside provider');
  return ctx;
}
