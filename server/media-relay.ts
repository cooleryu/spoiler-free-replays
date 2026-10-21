import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_TOKENS = 64;
const TTL = 10 * 60_000;
const MAX_RANGE = 16 * 1024 * 1024;
const OPEN_RANGE = 8 * 1024 * 1024;
interface Entry { url: string; expiresAt: number }
interface ByteRange { start: number; end: number }
interface RelayOptions { fetch?: typeof fetch; now?: () => number }

function trustedUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 8192 || value.trim() !== value || /[\u0000-\u0020\u007f#\\]/.test(value)) throw new Error('Invalid media source');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid media source'); }
  const authority = value.match(/^https:\/\/([^/?#]*)/i)?.[1];
  if (url.protocol !== 'https:' || !authority || /[:@]/.test(authority) || url.username || url.password || url.port || url.hash
    || url.hostname.length > 253 || !url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !['.bilivideo.com', '.bilivideo.cn'].some(suffix => url.hostname.endsWith(suffix))) throw new Error('Invalid media source');
  return url.toString();
}

function requestedRange(value: string | string[] | undefined): ByteRange | undefined {
  if (typeof value !== 'string') return;
  const match = value.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start + OPEN_RANGE - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= MAX_RANGE) return;
  return { start, end };
}

function returnedRange(value: string | null, requested: ByteRange): (ByteRange & { total: number; length: number }) | undefined {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return;
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || total <= 0 || start !== requested.start
    || end < start || end >= total || end !== Math.min(requested.end, total - 1) || end - start >= MAX_RANGE) return;
  return { start, end, total, length: end - start + 1 };
}

/** The caller must enforce its existing loopback Host/Origin policy before serving a token. */
export function createMediaRelay(options: RelayOptions = {}) {
  const entries = new Map<string, Entry>();
  const byUrl = new Map<string, string>();
  const active = new Set<AbortController>();
  const now = options.now ?? Date.now;
  const upstreamFetch = options.fetch ?? fetch;
  let closed = false;

  function remove(id: string) {
    const entry = entries.get(id);
    if (entry) byUrl.delete(entry.url);
    entries.delete(id);
  }
  function prune() {
    for (const [id, entry] of entries) if (entry.expiresAt <= now()) remove(id);
  }
  function register(value: string): string {
    if (closed) throw new Error('Media relay closed');
    const url = trustedUrl(value);
    prune();
    const existing = byUrl.get(url);
    if (existing) {
      entries.delete(existing);
      entries.set(existing, { url, expiresAt: now() + TTL });
      return existing;
    }
    while (entries.size >= MAX_TOKENS) remove(entries.keys().next().value!);
    const id = randomBytes(24).toString('base64url');
    entries.set(id, { url, expiresAt: now() + TTL });
    byUrl.set(url, id);
    return id;
  }
  function clear() {
    entries.clear(); byUrl.clear();
    for (const controller of active) controller.abort('CANCELLED');
  }

  async function serve(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    prune();
    const entry = closed ? undefined : entries.get(id);
    if (!entry) { res.writeHead(404).end(); return; }
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const wholeHead = head && req.headers.range === undefined;
    // A HEAD without Range obtains only the upstream's first byte headers, then cancels its body.
    const range = wholeHead ? { start: 0, end: 0 } : requestedRange(req.headers.range);
    if (!range) { res.writeHead(416).end(); return; }
    entry.expiresAt = now() + TTL;
    const controller = new AbortController();
    active.add(controller);
    const deadline = setTimeout(() => controller.abort('TIMEOUT'), 30_000);
    deadline.unref();
    const cancel = () => { if (!res.writableEnded) controller.abort('CANCELLED'); };
    req.once('aborted', cancel);
    res.once('close', cancel);
    let upstream: Response | undefined;
    try {
      if (req.aborted || res.destroyed) controller.abort('CANCELLED');
      upstream = await upstreamFetch(entry.url, {
        method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0',
          'Accept-Encoding': 'identity', Range: `bytes=${range.start}-${range.end}` },
      });
      if (controller.signal.aborted) throw new Error('Media request cancelled');
      const received = returnedRange(upstream.headers.get('content-range'), range);
      const encoding = upstream.headers.get('content-encoding');
      const length = upstream.headers.get('content-length');
      if (upstream.status !== 206 || !received || (encoding && encoding.trim().toLowerCase() !== 'identity')
        || (length !== null && (!/^\d+$/.test(length) || Number(length) !== received.length)) || (!head && !upstream.body)) {
        throw new Error('Invalid media response');
      }
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', wholeHead ? received.total : received.length);
      if (!wholeHead) res.setHeader('Content-Range', `bytes ${received.start}-${received.end}/${received.total}`);
      res.writeHead(wholeHead ? 200 : 206);
      if (head) { await upstream.body?.cancel(); res.end(); return; }
      let bytes = 0;
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > received.length || bytes > MAX_RANGE ? new Error('Invalid media length') : null,
            bytes <= received.length && bytes <= MAX_RANGE ? chunk : undefined);
        },
        flush(callback) { callback(bytes === received.length ? undefined : new Error('Incomplete media response')); },
      });
      await pipeline(Readable.fromWeb(upstream.body! as Parameters<typeof Readable.fromWeb>[0]), bounded, res, { signal: controller.signal });
    } catch {
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.destroy();
        else res.writeHead(controller.signal.reason === 'TIMEOUT' ? 504 : controller.signal.aborted ? 503 : 502).end();
      }
    } finally {
      controller.abort('CANCELLED');
      if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {});
      clearTimeout(deadline);
      req.removeListener('aborted', cancel); res.removeListener('close', cancel);
      active.delete(controller);
    }
  }
  return { register, serve, clear, close: () => { closed = true; clear(); } };
}
