import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { IDEMPOTENCY_HEADER, type SessionResponse } from '@teamtrack/shared';
import { useAuth } from '../stores/auth';
import { queryClient } from './queryClient';

export const api = axios.create({ baseURL: '/api/v1', withCredentials: true, timeout: 20_000 });

export function readCsrfCookie(): string {
  return document.cookie.split('; ').find((c) => c.startsWith('tt_csrf='))?.slice(8) ?? '';
}

let refreshTimer: number | undefined;
let inflight: Promise<boolean> | null = null;

export function applySession(s: SessionResponse): void {
  useAuth.getState().setSession(s);
  // Refresh a minute before the access token expires so users never see a 401 mid-action.
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refreshSession(), Math.max(10, s.expiresIn - 60) * 1000);
}

export function endSession(): void {
  window.clearTimeout(refreshTimer);
  useAuth.getState().clear();
  queryClient.clear();
}

/** Single-flight refresh: concurrent 401s share one rotation instead of racing (and tripping reuse detection). */
export function refreshSession(): Promise<boolean> {
  // The reset is chained outside the async body: with no cookie the body finishes synchronously, and an inner
  // `finally` would clear `inflight` before `??=` stored the settled promise, caching "false" for good.
  inflight ??= rotate().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function rotate(): Promise<boolean> {
  if (!readCsrfCookie()) {
    endSession();
    return false;
  }
  try {
    const { data } = await axios.post<SessionResponse>('/api/v1/auth/refresh', null, {
      withCredentials: true,
      headers: { 'x-csrf-token': readCsrfCookie() },
    });
    applySession(data);
    return true;
  } catch {
    endSession();
    return false;
  }
}

api.interceptors.request.use((config) => {
  const token = useAuth.getState().accessToken;
  if (token) config.headers.set('Authorization', `Bearer ${token}`);
  if (config.url?.startsWith('/auth/logout')) config.headers.set('x-csrf-token', readCsrfCookie());
  // One key per logical POST: the retry after a token refresh reuses this config, so the server runs it once.
  if (config.method === 'post' && !config.url?.startsWith('/auth/') && !config.headers.has(IDEMPOTENCY_HEADER)) {
    config.headers.set(IDEMPOTENCY_HEADER, newIdempotencyKey());
  }
  return config;
});

function newIdempotencyKey(): string {
  // randomUUID needs a secure context; plain-http LAN deployments fall back to getRandomValues.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

api.interceptors.response.use(undefined, async (error: AxiosError) => {
  const config = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
  const isAuthCall = config?.url?.startsWith('/auth/') && !config.url.startsWith('/auth/me');
  if (error.response?.status === 401 && config && !config._retried && !isAuthCall) {
    config._retried = true;
    if (await refreshSession()) return api.request(config);
  }
  throw error;
});
