// Cookie validation adapted from @xzxzzx/bilibili-mcp 1.14.2, dist/bilibili/qr-login.js (Apache-2.0).
// Modified here for bounded web QR sessions and process-memory credentials; see THIRD_PARTY.md.
import { randomUUID } from 'node:crypto';
import qrcode from 'qrcode-generator';
import { checkLoginStatus } from '@xzxzzx/bilibili-mcp/dist/bilibili/http.js';
import { credentialManager, type BilibiliCredentials } from '@xzxzzx/bilibili-mcp/dist/utils/credentials.js';
import { parseBoundedJsonResponse } from '@xzxzzx/bilibili-mcp/dist/utils/bounded-response.js';
import { ReplayError, type ErrorCode } from './domain';

const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const SESSION_MS = 180_000;
const REQUEST_MS = 15_000;
const POLL_MS = 3_000;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type LoginState = 'waiting' | 'scanned' | 'ready' | 'expired';
export interface LoginStatus { loggedIn: boolean }
export interface LoginStart { sessionId: string; qrImage: string; expiresAt: number }
export interface LoginPoll { status: LoginState }
export interface AuthDependencies {
  fetch?: typeof fetch;
  verify?: (candidate: BilibiliCredentials, signal: AbortSignal) => Promise<{ isLogin: boolean }>;
  now?: () => number;
  qr?: (url: string) => string;
}

interface Session {
  id: string;
  key?: string;
  expiresAt: number;
  state: LoginState;
  lastPollAt: number;
  busy: boolean;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReplayError('SOURCE_UNAVAILABLE');
  return value as Record<string, unknown>;
}

function sanitized(error: unknown): ReplayError {
  const allowed: ErrorCode[] = ['CANCELLED', 'TIMEOUT', 'INVALID_INPUT', 'RATE_LIMITED', 'SOURCE_UNAVAILABLE'];
  return new ReplayError(error instanceof ReplayError && allowed.includes(error.code) ? error.code : 'SOURCE_UNAVAILABLE');
}

function makeQr(url: string): string {
  const image = qrcode(0, 'M');
  image.addData(url, 'Byte');
  image.make();
  return image.createDataURL(5, 20);
}

function scanUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(raw)) {
    throw new ReplayError('SOURCE_UNAVAILABLE');
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new ReplayError('SOURCE_UNAVAILABLE'); }
  const authority = raw.match(/^https:\/\/([^/?#]+)/)?.[1];
  if (authority !== 'account.bilibili.com' || url.protocol !== 'https:' || url.hostname !== 'account.bilibili.com'
    || url.port || url.username || url.password || url.hash || raw.includes('#')
    || url.pathname !== '/h5/account-h5/auth/scan-web') throw new ReplayError('SOURCE_UNAVAILABLE');
  return url.href;
}

// The same three-cookie contract used by the upstream terminal login, kept server-side.
// getSetCookie() is essential: Expires attributes can contain commas.
function candidateFromCookies(headers: Headers, now: number): BilibiliCredentials {
  const cookies = headers.getSetCookie();
  if (cookies.join('').length > 16_384) throw new ReplayError('SOURCE_UNAVAILABLE');
  const values = new Map<string, string>();
  let expiresAt = now + 30 * 86_400_000;
  for (const cookie of cookies) {
    const [pair, ...attributes] = cookie.split(';');
    const split = pair.indexOf('=');
    if (split < 1) continue;
    const name = pair.slice(0, split).trim();
    if (!['SESSDATA', 'bili_jct', 'DedeUserID'].includes(name)) continue;
    const value = pair.slice(split + 1);
    if (values.has(name) || !COOKIE_VALUE.test(value)) throw new ReplayError('SOURCE_UNAVAILABLE');
    values.set(name, value);
    const expiryKeys = new Set<string>();
    for (const attribute of attributes) {
      const separator = attribute.indexOf('=');
      const key = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
      if (key !== 'max-age' && key !== 'expires') continue;
      if (expiryKeys.has(key) || separator < 0) throw new ReplayError('SOURCE_UNAVAILABLE');
      expiryKeys.add(key);
      const text = attribute.slice(separator + 1).trim();
      let expiry: number;
      if (key === 'max-age') {
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new ReplayError('SOURCE_UNAVAILABLE');
        expiry = now + Number(text) * 1000;
      } else expiry = Date.parse(text);
      if (!Number.isFinite(expiry) || expiry <= now) throw new ReplayError('SOURCE_UNAVAILABLE');
      expiresAt = Math.min(expiresAt, expiry);
    }
    if (expiryKeys.size === 0) expiresAt = Math.min(expiresAt, now + 86_400_000);
  }
  const sessdata = values.get('SESSDATA');
  const bili_jct = values.get('bili_jct');
  const dedeuserid = values.get('DedeUserID');
  if (!sessdata || !bili_jct || !dedeuserid || !/^[1-9]\d*$/.test(dedeuserid)) throw new ReplayError('SOURCE_UNAVAILABLE');
  return Object.freeze({ sessdata, bili_jct, dedeuserid, expiresAt });
}

/** Optional authentication owned only by this running replay server. Never reads or saves global credentials. */
export class ReplayAuth {
  private readonly fetcher: typeof fetch;
  private readonly verify: NonNullable<AuthDependencies['verify']>;
  private readonly now: () => number;
  private readonly qr: (url: string) => string;
  private credentials?: BilibiliCredentials;
  private session?: Session;
  private closed = false;
  private lastStartAt = -Infinity;

  constructor(dependencies: AuthDependencies = {}) {
    this.fetcher = dependencies.fetch ?? fetch;
    this.verify = dependencies.verify ?? checkLoginStatus;
    this.now = dependencies.now ?? Date.now;
    this.qr = dependencies.qr ?? makeQr;
  }

  private expire(session: Session) {
    clearTimeout(session.timer);
    session.timer = undefined;
    session.state = 'expired';
    session.key = undefined;
    session.controller.abort();
  }

  private prune() {
    if (this.credentials && this.credentials.expiresAt <= this.now()) this.credentials = undefined;
    const session = this.session;
    if (session && session.state !== 'expired' && (session.state === 'ready' ? !this.credentials : session.expiresAt <= this.now())) {
      this.expire(session);
    }
  }

  status(): LoginStatus {
    this.prune();
    return { loggedIn: Boolean(this.credentials) };
  }

  headers(): Record<string, string> {
    this.prune();
    // Never call without the explicit candidate: that would load unrelated global credentials.
    return this.credentials ? credentialManager.getAuthHeaders(this.credentials) : {};
  }

  private assertActive(session: Session, signal: AbortSignal) {
    this.prune();
    if (this.closed || signal.aborted || this.session !== session || session.controller.signal.aborted) {
      throw new ReplayError('CANCELLED');
    }
  }

  private async bounded<T>(session: Session, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertActive(session, signal);
    const controller = new AbortController();
    const cancel = () => controller.abort(new ReplayError('CANCELLED'));
    signal.addEventListener('abort', cancel, { once: true });
    session.controller.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new ReplayError('TIMEOUT')), Math.min(REQUEST_MS, session.expiresAt - this.now()));
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(sanitized(controller.signal.reason));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      const result = await Promise.race([operation(controller.signal), aborted]);
      if (controller.signal.aborted) throw sanitized(controller.signal.reason);
      this.assertActive(session, signal);
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      session.controller.signal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', rejectAbort);
      controller.abort();
    }
  }

  private async passport(url: string, signal: AbortSignal) {
    const response = await this.fetcher(url, {
      signal, redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReplayError(response.status === 412 || response.status === 429 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE');
    }
    const body = record(await parseBoundedJsonResponse(response, 65_536, 'QR login response'));
    if (body.code !== 0) throw new ReplayError(body.code === -352 || body.code === -412 ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE');
    return { data: record(body.data), headers: response.headers };
  }

  async start(signal: AbortSignal): Promise<LoginStart> {
    if (this.closed || signal.aborted) throw new ReplayError('CANCELLED');
    const now = this.now();
    if (now - this.lastStartAt < POLL_MS) throw new ReplayError('RATE_LIMITED');
    this.lastStartAt = now;
    if (this.session) this.expire(this.session);
    const session: Session = {
      id: randomUUID(), expiresAt: now + SESSION_MS, state: 'waiting', lastPollAt: now,
      busy: false, controller: new AbortController(),
    };
    this.session = session;
    session.timer = setTimeout(() => this.expire(session), SESSION_MS);
    session.timer.unref?.();
    try {
      const { data } = await this.bounded(session, signal, taskSignal => this.passport(GENERATE_URL, taskSignal));
      if (typeof data.qrcode_key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.qrcode_key)) throw new ReplayError('SOURCE_UNAVAILABLE');
      const image = this.qr(scanUrl(data.url));
      if (image.length > 200_000 || !/^data:image\/(?:gif|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new ReplayError('SOURCE_UNAVAILABLE');
      this.assertActive(session, signal);
      session.key = data.qrcode_key;
      session.lastPollAt = this.now();
      return { sessionId: session.id, qrImage: image, expiresAt: session.expiresAt };
    } catch (error) {
      this.expire(session);
      throw sanitized(error);
    }
  }

  async poll(sessionId: string, signal: AbortSignal): Promise<LoginPoll> {
    if (this.closed || signal.aborted) throw new ReplayError('CANCELLED');
    if (!SESSION_ID.test(sessionId) || this.session?.id !== sessionId) throw new ReplayError('INVALID_INPUT');
    this.prune();
    const session = this.session;
    if (session.state === 'ready' || session.state === 'expired') return { status: session.state };
    if (session.busy || this.now() - session.lastPollAt < POLL_MS) return { status: session.state };
    if (!session.key) throw new ReplayError('INVALID_INPUT');
    session.busy = true;
    session.lastPollAt = this.now();
    try {
      const response = await this.bounded(session, signal, taskSignal => this.passport(`${POLL_URL}?qrcode_key=${encodeURIComponent(session.key!)}`, taskSignal));
      switch (response.data.code) {
        case 86101: break; // Keep scanned state if an upstream replica briefly reports waiting again.
        case 86090: session.state = 'scanned'; break;
        case 86038: this.expire(session); break;
        case 0: {
          const candidate = candidateFromCookies(response.headers, this.now());
          const result = await this.bounded(session, signal, taskSignal => this.verify(candidate, taskSignal));
          if (result?.isLogin !== true || candidate.expiresAt <= this.now()) throw new ReplayError('SOURCE_UNAVAILABLE');
          this.assertActive(session, signal);
          this.credentials = candidate;
          session.state = 'ready';
          session.key = undefined;
          clearTimeout(session.timer);
          session.timer = undefined;
          break;
        }
        default: throw new ReplayError('SOURCE_UNAVAILABLE');
      }
      return { status: session.state };
    } catch (error) {
      if (signal.aborted) this.expire(session);
      this.prune();
      if (!signal.aborted && this.session === session && session.expiresAt <= this.now()) return { status: 'expired' };
      throw sanitized(error);
    } finally { session.busy = false; }
  }

  cancel(sessionId: string): void {
    if (!SESSION_ID.test(sessionId)) throw new ReplayError('INVALID_INPUT');
    if (this.session?.id === sessionId) this.expire(this.session);
  }

  logout(): void {
    this.credentials = undefined;
    if (this.session) this.expire(this.session);
  }

  close(): void {
    this.closed = true;
    this.logout();
  }
}
