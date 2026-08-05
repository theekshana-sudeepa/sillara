const SYMBOLS: Record<string, string> = {
  LKR: 'Rs.', USD: '$', EUR: '€', GBP: '£', INR: '₹', AUD: 'A$', SGD: 'S$',
  MYR: 'RM', AED: 'د.إ', BDT: '৳', NPR: 'रू', PKR: '₨', KES: 'KSh', NGN: '₦',
  ZAR: 'R', PHP: '₱', IDR: 'Rp', CAD: 'C$',
};

export function money(value: number | string | null | undefined, currency = 'USD'): string {
  const n = Number(value ?? 0);
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const receiptNo = (n: number, offline = false): string =>
  offline ? `SYNC-${String(n).padStart(4, '0')}` : `#${String(n).padStart(6, '0')}`;

export const timeOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const dateOf = (iso: string): string =>
  new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });

export const percent = (n: number | null | undefined, digits = 1): string =>
  `${Number(n ?? 0).toFixed(digits)}%`;

/** SALE → Sale, VOID_RETURN → Void Return. Enum labels for the UI. */
export const titleCase = (s: string): string =>
  s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
