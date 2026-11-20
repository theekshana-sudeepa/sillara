const BASE = import.meta.env.VITE_API_URL ?? '';
const API = `${BASE}/api/v1`;

export interface ApiErrorDetail {
  field: string;
  message: string;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'sillara.token';

// Pragmatic trade-off, documented: the POS token lives in localStorage so a
// terminal survives a reboot without re-login (a till that logs itself out
// mid-shift is a broken till). Tokens are org+role scoped and expire in 12h.
export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null): void => {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
};

async function request<T>(path: string, options: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
  const url = new URL(`${API}${path}`, window.location.origin);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const token = getToken();
  const res = await fetch(url.toString(), {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const json = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!res.ok || !json?.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, json?.error?.code ?? 'REQUEST_FAILED', json?.error?.message ?? res.statusText, json?.error?.details);
  }
  return json.data;
}

export const api = {
  get: <T>(path: string, query?: Record<string, string | number | undefined>) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
