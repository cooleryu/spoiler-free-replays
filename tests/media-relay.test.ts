import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import test from 'node:test';
import { createMediaRelay } from '../server/media-relay.js';

class Reply extends Writable {
  statusCode = 200;
  headersSent = false;
  headers = new Map<string, string>();
  chunks: Buffer[] = [];
  setHeader(name: string, value: string | number) { this.headers.set(name.toLowerCase(), String(value)); return this; }
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status; this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { this.chunks.push(chunk); callback(); }
  get body() { return Buffer.concat(this.chunks).toString(); }
}
const source = 'https://example.bilivideo.com/video.m4s?token=fixture';
function request(range?: string, method = 'GET') {
  return Object.assign(new EventEmitter(), { method, headers: range === undefined ? {} : { range }, aborted: false }) as IncomingMessage;
}
async function serve(relay: ReturnType<typeof createMediaRelay>, id: string, range?: string, method = 'GET') {
  const res = new Reply();
  await relay.serve(id, request(range, method), res as unknown as ServerResponse);
  return res;
}
function response(body = 'abcd', range = 'bytes 2-5/10', headers: Record<string, string> = {}, status = 206) {
  return new Response(body, { status, headers: { 'Content-Range': range, 'Content-Length': String(body.length), 'Content-Type': 'video/mp4', ...headers } });
}

test('relays an exact range with fixed public headers and no credentials', async () => {
  let options: RequestInit | undefined;
  const relay = createMediaRelay({ fetch: (async (url, init) => { assert.equal(url, source); options = init; return response(); }) as typeof fetch });
  const id = relay.register(source);
  assert.match(id, /^[\w-]{32}$/);
  const res = await serve(relay, id, 'bytes=2-5');
  assert.equal(res.statusCode, 206); assert.equal(res.body, 'abcd');
  assert.equal(res.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const headers = new Headers(options?.headers);
  assert.equal(headers.get('referer'), 'https://www.bilibili.com/');
  assert.equal(headers.get('user-agent'), 'Mozilla/5.0');
  assert.equal(headers.get('accept-encoding'), 'identity');
  assert.equal(headers.get('cookie'), null); assert.equal(headers.get('range'), 'bytes=2-5');
  assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'omit');
  relay.close();
});

test('rejects invalid targets and ranges without fetching; caps and expires tokens', async () => {
  let calls = 0; let time = 100;
  const relay = createMediaRelay({ now: () => time, fetch: (async () => { calls++; return response(); }) as typeof fetch });
  for (const url of ['http://a.bilivideo.com/a', 'https://evil.test/a', 'https://a.bilivideo.com.evil.test/a', 'https://@a.bilivideo.com/a', 'https://u:p@a.bilivideo.com/a', 'https://a.bilivideo.com:443/a', 'https://a.bilivideo.com/a#x', 'https://a.bilivideo.com\\@evil.test/a']) assert.throws(() => relay.register(url));
  const id = relay.register(source); assert.equal(relay.register(source), id);
  for (const range of [undefined, 'bytes=-1', 'bytes=0-1,2-3', 'bytes=2-1', 'bytes=0-16777216', 'bytes=9007199254740992-']) assert.equal((await serve(relay, id, range)).statusCode, 416);
  assert.equal((await serve(relay, 'unknown', 'bytes=0-1')).statusCode, 404);
  assert.equal((await serve(relay, id, 'bytes=0-1', 'POST')).statusCode, 405);
  for (let n = 0; n < 64; n++) relay.register(`https://example.bilivideo.cn/${n}.m4s`);
  assert.equal((await serve(relay, id, 'bytes=0-1')).statusCode, 404);
  const fresh = relay.register(source); time += 600_000;
  assert.equal((await serve(relay, fresh, 'bytes=0-1')).statusCode, 404); assert.equal(calls, 0);
  relay.close(); assert.throws(() => relay.register(source));
});

test('bounds open ranges, permits EOF clamp and serves HEAD without a body', async () => {
  const ranges: Array<string | null> = [];
  const relay = createMediaRelay({ fetch: (async (_url, init) => {
    const range = new Headers(init?.headers).get('range'); ranges.push(range);
    return range === 'bytes=0-0' ? response('a', 'bytes 0-0/4') : response('abcd', 'bytes 0-3/4');
  }) as typeof fetch });
  const id = relay.register(source);
  const res = await serve(relay, id, 'bytes=0-');
  assert.equal(res.statusCode, 206); assert.equal(res.body, 'abcd'); assert.equal(ranges[0], 'bytes=0-8388607');
  const head = await serve(relay, id, undefined, 'HEAD');
  assert.equal(head.statusCode, 200); assert.equal(head.body, ''); assert.equal(head.headers.get('content-length'), '4');
  assert.equal(ranges[1], 'bytes=0-0'); relay.close();
});

test('valid playback requests renew the ten-minute idle expiry', async () => {
  let time = 0;
  const relay = createMediaRelay({ now: () => time, fetch: (async () => response()) as typeof fetch });
  const id = relay.register(source);
  time = 9 * 60_000;
  assert.equal((await serve(relay, id, 'bytes=2-5')).statusCode, 206);
  time = 18 * 60_000;
  assert.equal((await serve(relay, id, 'bytes=2-5')).statusCode, 206);
  time = 28 * 60_000;
  assert.equal((await serve(relay, id, 'bytes=2-5')).statusCode, 404);
  relay.close();
});

test('rejects nonpartial, inconsistent, compressed and wrong-length upstream responses', async () => {
  const invalid = [() => response('abcd', 'bytes 2-5/10', {}, 200), () => response('abcd', 'bytes 0-3/10'), () => response('abcd', 'bytes 2-5/*'), () => response('abcd', 'bytes 2-5/10', { 'Content-Encoding': 'gzip' }), () => response('abcd', 'bytes 2-5/10', { 'Content-Length': '5' })];
  for (const next of invalid) {
    const relay = createMediaRelay({ fetch: (async () => next()) as typeof fetch });
    const res = await serve(relay, relay.register(source), 'bytes=2-5');
    assert.equal(res.statusCode, 502); assert.equal(res.body, ''); relay.close();
  }
});

test('clear cancels in-flight fetches and removes all registered tokens', async () => {
  let signal: AbortSignal | undefined;
  const relay = createMediaRelay({ fetch: (async (_url, init) => {
    signal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  }) as typeof fetch });
  const id = relay.register(source);
  const pending = serve(relay, id, 'bytes=2-5');
  relay.clear(); await pending;
  assert.equal(signal?.aborted, true);
  assert.equal((await serve(relay, id, 'bytes=2-5')).statusCode, 404);
  relay.close();
});
