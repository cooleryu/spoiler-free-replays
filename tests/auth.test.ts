import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialManager } from '@xzxzzx/bilibili-mcp/dist/utils/credentials.js';
import { ReplayAuth, type AuthDependencies } from '../server/auth';
import { ReplayError, type ErrorCode } from '../server/domain';

const START = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=synthetic-key';
const SCAN = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=synthetic-key';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const BASE_TIME = 1_799_000_000_000;
const COOKIE_HEADERS = ['SESSDATA=synthetic-session; Max-Age=3600', 'bili_jct=synthetic-csrf; Max-Age=3600', 'DedeUserID=123456; Max-Age=3600'];
const signal = () => new AbortController().signal;
const errorCode = (code: ErrorCode) => (error: unknown) => {
  assert.ok(error instanceof ReplayError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(JSON.stringify(error), /synthetic|passport|SESSDATA|bili_jct|qrcode_key/);
  return true;
};
function response(data: unknown, cookies: string[] = [], status = 200): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify({ code: 0, data }), { headers, status });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(options: AuthDependencies = {}) {
  let time = BASE_TIME;
  const queue: (() => Response | Promise<Response>)[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const verified: unknown[] = [];
  const auth = new ReplayAuth({
    now: () => time,
    qr: url => { assert.equal(url, SCAN); return GIF; },
    fetch: (async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      if (!queue.length) assert.fail('Unexpected external request');
      return queue.shift()!();
    }) as typeof fetch,
    verify: async (candidate, taskSignal) => {
      assert.equal(taskSignal.aborted, false);
      verified.push(candidate);
      return { isLogin: true };
    },
    ...options,
  });
  return {
    auth, requests, verified,
    advance: (milliseconds = 3000) => { time += milliseconds; },
    enqueue: (data: unknown, cookies: string[] = []) => queue.push(() => response(data, cookies)),
    enqueueResponse: (value: Response | Promise<Response>) => queue.push(() => value),
    start: async () => {
      queue.push(() => response({ qrcode_key: 'synthetic-key', url: SCAN }));
      return auth.start(signal());
    },
  };
}

test('authentication stays anonymous and never loads or writes the upstream global credential store', async () => {
  const originals = {
    getCredentials: credentialManager.getCredentials,
    loadFromFile: credentialManager.loadFromFile,
    saveToFile: credentialManager.saveToFile,
    setCredentials: credentialManager.setCredentials,
  };
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
    credentialManager[name] = () => { assert.fail(`Must not call global credential method ${name}`); };
  }
  const h = harness();
  try {
    assert.deepEqual(h.auth.status(), { loggedIn: false });
    assert.deepEqual(h.auth.headers(), {});
    const started = await h.start();
    h.advance(); h.enqueue({ code: 0 }, COOKIE_HEADERS);
    assert.deepEqual(await h.auth.poll(started.sessionId, signal()), { status: 'ready' });
    assert.deepEqual(h.auth.status(), { loggedIn: true });
    assert.deepEqual(h.auth.headers(), { Cookie: 'SESSDATA=synthetic-session; bili_jct=synthetic-csrf; DedeUserID=123456' });
    h.auth.logout();
    assert.deepEqual(h.auth.status(), { loggedIn: false });
    assert.deepEqual(h.auth.headers(), {});
  } finally {
    h.auth.close();
    Object.assign(credentialManager, originals);
  }
});

test('start returns only a local image, opaque session id and expiry; passport requests are fixed and anonymous', async t => {
  const h = harness(); t.after(() => h.auth.close());
  const started = await h.start();
  assert.deepEqual(Object.keys(started).sort(), ['expiresAt', 'qrImage', 'sessionId']);
  assert.equal(started.qrImage, GIF);
  assert.match(started.sessionId, /^[a-f0-9-]{36}$/);
  assert.equal(started.expiresAt, BASE_TIME + 180_000);
  assert.doesNotMatch(JSON.stringify(started), /synthetic-key|passport|SESSDATA|bili_jct/);
  assert.deepEqual(h.auth.status(), { loggedIn: false });
  h.advance(); h.enqueue({ code: 86101 });
  assert.deepEqual(await h.auth.poll(started.sessionId, signal()), { status: 'waiting' });
  assert.deepEqual(h.requests.map(request => request.url), [START, POLL]);
  for (const request of h.requests) {
    assert.equal(request.init.redirect, 'error');
    assert.equal(request.init.credentials, 'omit');
    assert.equal(request.init.cache, 'no-store');
    assert.deepEqual(request.init.headers, { Accept: 'application/json' });
    assert.ok(request.init.signal instanceof AbortSignal);
  }
});

test('the real installed QR renderer creates an image without any network or terminal dependency', async t => {
  const auth = new ReplayAuth({
    now: () => BASE_TIME,
    fetch: (async () => response({ qrcode_key: 'synthetic-key', url: SCAN })) as typeof fetch,
    verify: async () => { assert.fail('Generating a QR must not verify credentials'); },
  });
  t.after(() => auth.close());
  const result = await auth.start(signal());
  assert.match(result.qrImage, /^data:image\/gif;base64,R0lGOD/);
  assert.ok(result.qrImage.length < 200_000);
});

test('waiting and scanned states are monotonic until explicit mobile confirmation and verified credentials', async t => {
  const h = harness(); t.after(() => h.auth.close());
  const started = await h.start();
  for (const [code, status] of [[86101, 'waiting'], [86090, 'scanned'], [86101, 'scanned']] as const) {
    h.advance(); h.enqueue({ code });
    assert.deepEqual(await h.auth.poll(started.sessionId, signal()), { status });
    assert.deepEqual(h.auth.status(), { loggedIn: false });
    assert.equal(h.verified.length, 0);
  }
  h.advance(); h.enqueue({ code: 0 }, COOKIE_HEADERS);
  const done = await h.auth.poll(started.sessionId, signal());
  assert.deepEqual(done, { status: 'ready' });
  assert.deepEqual(Object.keys(done), ['status']);
  assert.deepEqual(h.verified, [{ sessdata: 'synthetic-session', bili_jct: 'synthetic-csrf', dedeuserid: '123456', expiresAt: BASE_TIME + 12_000 + 3_600_000 }]);
  const calls = h.requests.length;
  assert.deepEqual(await h.auth.poll(started.sessionId, signal()), { status: 'ready' });
  assert.equal(h.requests.length, calls);
});

test('rapid and concurrent polls never issue extra passport requests', async t => {
  const h = harness(); t.after(() => h.auth.close());
  const started = await h.start();
  assert.deepEqual(await h.auth.poll(started.sessionId, signal()), { status: 'waiting' });
  assert.equal(h.requests.length, 1);
  h.advance();
  const pending = deferred<Response>(); h.enqueueResponse(pending.promise);
  const first = h.auth.poll(started.sessionId, signal());
  assert.deepEqual(await h.auth.poll(started.sessionId, signal()), { status: 'waiting' });
  assert.equal(h.requests.length, 2);
  pending.resolve(response({ code: 86090 }));
  assert.deepEqual(await first, { status: 'scanned' });
  h.advance(2999);
  assert.deepEqual(await h.auth.poll(started.sessionId, signal()), { status: 'scanned' });
  assert.equal(h.requests.length, 2);
  h.advance(1); h.enqueue({ code: 86101 });
  await h.auth.poll(started.sessionId, signal());
  assert.equal(h.requests.length, 3);
});

test('QR expiry stops requests and does not affect the anonymous viewing path', async t => {
  const h = harness(); t.after(() => h.auth.close());
  const started = await h.start();
  h.advance(180_000);
  assert.deepEqual(await h.auth.poll(started.sessionId, signal()), { status: 'expired' });
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.auth.headers(), {});
  h.advance();
  const next = await h.start();
  h.advance(); h.enqueue({ code: 86038 });
  assert.deepEqual(await h.auth.poll(next.sessionId, signal()), { status: 'expired' });
});

test('new QR attempts are rate limited and replace old sessions after the short interval', async t => {
  const h = harness(); t.after(() => h.auth.close());
  const first = await h.start();
  await assert.rejects(h.auth.start(signal()), errorCode('RATE_LIMITED'));
  assert.equal(h.requests.length, 1);
  h.advance();
  const second = await h.start();
  assert.notEqual(first.sessionId, second.sessionId);
  await assert.rejects(h.auth.poll(first.sessionId, signal()), errorCode('INVALID_INPUT'));
  h.auth.cancel(first.sessionId); // A late cancellation must not cancel the replacement.
  assert.deepEqual(await h.auth.poll(second.sessionId, signal()), { status: 'waiting' });
});

test('invalid session ids are rejected before any upstream operation', async t => {
  const h = harness(); t.after(() => h.auth.close());
  for (const id of ['', 'synthetic-key', '../arbitrary', '00000000-0000-4000-8000-000000000000']) {
    await assert.rejects(h.auth.poll(id, signal()), errorCode('INVALID_INPUT'));
  }
  assert.throws(() => h.auth.cancel('not-a-session'), errorCode('INVALID_INPUT'));
  assert.equal(h.requests.length, 0);
});

test('pre-aborted starts do not generate QR codes', async t => {
  const h = harness(); t.after(() => h.auth.close());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.auth.start(controller.signal), errorCode('CANCELLED'));
  assert.equal(h.requests.length, 0);
});

test('aborting a start invalidates an upstream result that ignores cancellation', async t => {
  const h = harness(); t.after(() => h.auth.close());
  const pending = deferred<Response>(); h.enqueueResponse(pending.promise);
  const controller = new AbortController();
  const work = h.auth.start(controller.signal);
  const rejected = assert.rejects(work, errorCode('CANCELLED'));
  controller.abort();
  await rejected;
  assert.equal(h.requests[0].init.signal?.aborted, true);
  pending.resolve(response({ qrcode_key: 'synthetic-key', url: SCAN }));
  await Promise.resolve();
  assert.deepEqual(h.auth.status(), { loggedIn: false });
});

for (const action of ['cancel', 'logout', 'close', 'abort'] as const) {
  test(`${action} during candidate verification cannot install late credentials`, async () => {
    const entered = deferred<void>();
    const verification = deferred<{ isLogin: boolean }>();
    let verifySignal: AbortSignal | undefined;
    const h = harness({ verify: async (_candidate, taskSignal) => {
      verifySignal = taskSignal; entered.resolve();
      return verification.promise;
    } });
    try {
      const started = await h.start();
      h.advance(); h.enqueue({ code: 0 }, COOKIE_HEADERS);
      const controller = new AbortController();
      const work = h.auth.poll(started.sessionId, controller.signal);
      const rejected = assert.rejects(work, errorCode('CANCELLED'));
      await entered.promise;
      if (action === 'cancel') h.auth.cancel(started.sessionId);
      else if (action === 'abort') controller.abort();
      else h.auth[action]();
      await rejected;
      assert.equal(verifySignal?.aborted, true);
      verification.resolve({ isLogin: true });
      await Promise.resolve();
      assert.deepEqual(h.auth.status(), { loggedIn: false });
      assert.deepEqual(h.auth.headers(), {});
      if (action === 'close') await assert.rejects(h.auth.start(signal()), errorCode('CANCELLED'));
      else assert.deepEqual(await h.auth.poll(started.sessionId, signal()), { status: 'expired' });
    } finally { h.auth.close(); }
  });
}

test('a candidate completing after QR expiry is not installed', async t => {
  const entered = deferred<void>();
  const verification = deferred<{ isLogin: boolean }>();
  const h = harness({ verify: async () => { entered.resolve(); return verification.promise; } });
  t.after(() => h.auth.close());
  const started = await h.start();
  h.advance(); h.enqueue({ code: 0 }, COOKIE_HEADERS);
  const work = h.auth.poll(started.sessionId, signal());
  await entered.promise;
  h.advance(180_000);
  verification.resolve({ isLogin: true });
  assert.deepEqual(await work, { status: 'expired' });
  assert.deepEqual(h.auth.status(), { loggedIn: false });
});

test('a replacement login invalidates a previous in-flight candidate without losing existing login', async t => {
  const entered = deferred<void>();
  const verification = deferred<{ isLogin: boolean }>();
  const h = harness({ verify: async () => { entered.resolve(); return verification.promise; } });
  t.after(() => h.auth.close());
  const first = await h.start();
  h.advance(); h.enqueue({ code: 0 }, COOKIE_HEADERS);
  const work = h.auth.poll(first.sessionId, signal());
  const rejected = assert.rejects(work, errorCode('CANCELLED'));
  await entered.promise;
  const replacement = await h.start();
  await rejected;
  verification.resolve({ isLogin: true });
  await Promise.resolve();
  assert.deepEqual(h.auth.status(), { loggedIn: false });
  assert.deepEqual(await h.auth.poll(replacement.sessionId, signal()), { status: 'waiting' });
});

test('a cancelled replacement QR preserves an already verified login; logout explicitly removes it', async t => {
  const h = harness(); t.after(() => h.auth.close());
  const first = await h.start();
  h.advance(); h.enqueue({ code: 0 }, COOKIE_HEADERS);
  await h.auth.poll(first.sessionId, signal());
  const second = await h.start();
  h.auth.cancel(second.sessionId);
  assert.deepEqual(h.auth.status(), { loggedIn: true });
  h.auth.logout();
  assert.deepEqual(h.auth.status(), { loggedIn: false });
  assert.deepEqual(h.auth.headers(), {});
});

test('candidate cookies keep their bounded expiry and are removed when that expiry arrives', async t => {
  const h = harness(); t.after(() => h.auth.close());
  const started = await h.start();
  h.advance();
  h.enqueue({ code: 0 }, COOKIE_HEADERS.map(cookie => cookie.replace('3600', '2')));
  await h.auth.poll(started.sessionId, signal());
  assert.deepEqual(h.auth.status(), { loggedIn: true });
  h.advance(2000);
  assert.deepEqual(h.auth.status(), { loggedIn: false });
  assert.deepEqual(h.auth.headers(), {});
  assert.deepEqual(await h.auth.poll(started.sessionId, signal()), { status: 'expired' });
});

test('Expires commas and session cookies are parsed without splitting cookie values', async t => {
  const h = harness(); t.after(() => h.auth.close());
  const started = await h.start();
  h.advance();
  h.enqueue({ code: 0 }, [
    `SESSDATA=synthetic-session; Expires=${new Date(BASE_TIME + 3000 + 7 * 86_400_000).toUTCString()}`,
    'bili_jct=synthetic-csrf', 'DedeUserID=123456',
  ]);
  await h.auth.poll(started.sessionId, signal());
  assert.equal((h.verified[0] as { expiresAt: number }).expiresAt, BASE_TIME + 3000 + 86_400_000);
});

test('invalid candidate cookies never reach verification or install a login', async t => {
  const invalidSets = [
    [], COOKIE_HEADERS.slice(0, 2), [...COOKIE_HEADERS, COOKIE_HEADERS[0]],
    COOKIE_HEADERS.map(cookie => cookie.replace('synthetic-session', 'bad value')),
    COOKIE_HEADERS.map(cookie => cookie.replace('synthetic-csrf', '')),
    COOKIE_HEADERS.map(cookie => cookie.replace('123456', 'not-a-number')),
    COOKIE_HEADERS.map(cookie => cookie.replace('Max-Age=3600', 'Max-Age=-1')),
    COOKIE_HEADERS.map(cookie => cookie.replace('Max-Age=3600', 'Max-Age=0')),
    COOKIE_HEADERS.map(cookie => cookie.replace('Max-Age=3600', 'Expires=invalid')),
    COOKIE_HEADERS.map(cookie => cookie.replace('Max-Age=3600', 'Max-Age=1; Max-Age=2')),
    COOKIE_HEADERS.map(cookie => cookie.replace('synthetic-session', 's'.repeat(17_000))),
  ];
  for (const cookies of invalidSets) {
    const h = harness(); t.after(() => h.auth.close());
    const started = await h.start();
    h.advance(); h.enqueue({ code: 0 }, cookies);
    await assert.rejects(h.auth.poll(started.sessionId, signal()), errorCode('SOURCE_UNAVAILABLE'));
    assert.equal(h.verified.length, 0);
    assert.deepEqual(h.auth.status(), { loggedIn: false });
  }
});

test('rejected verification and exception messages never authenticate or leak secrets', async t => {
  for (const verify of [
    async () => ({ isLogin: false }),
    async () => { throw new Error('SESSDATA=synthetic-session at passport URL'); },
  ]) {
    const h = harness({ verify }); t.after(() => h.auth.close());
    const started = await h.start();
    h.advance(); h.enqueue({ code: 0 }, COOKIE_HEADERS);
    await assert.rejects(h.auth.poll(started.sessionId, signal()), errorCode('SOURCE_UNAVAILABLE'));
    assert.deepEqual(h.auth.headers(), {});
  }
});

test('generated QR URLs reject all redirects, foreign hosts, credentials and nonstandard path forms', async t => {
  for (const url of [
    'http://account.bilibili.com/h5/account-h5/auth/scan-web',
    'https://evil.example/h5/account-h5/auth/scan-web',
    'https://account.bilibili.com.evil.example/h5/account-h5/auth/scan-web',
    'https://account.bilibili.com/other', SCAN + '#fragment', SCAN + '#',
    'https://user@account.bilibili.com/h5/account-h5/auth/scan-web',
    'https://@account.bilibili.com/h5/account-h5/auth/scan-web',
    'https://account.bilibili.com:443/h5/account-h5/auth/scan-web',
    'https://account.bilibili.com\\h5/account-h5/auth/scan-web', ' ' + SCAN,
  ]) {
    let rendered = false;
    const h = harness({ qr: () => { rendered = true; return GIF; } }); t.after(() => h.auth.close());
    h.enqueue({ qrcode_key: 'synthetic-key', url });
    await assert.rejects(h.auth.start(signal()), errorCode('SOURCE_UNAVAILABLE'));
    assert.equal(rendered, false);
  }
});

test('malformed or oversized upstream responses and QR images are rejected without their payloads', async t => {
  const fixtures = [
    response({ qrcode_key: 'bad&key', url: SCAN }),
    response({ qrcode_key: 's'.repeat(257), url: SCAN }),
    response({ qrcode_key: 'synthetic-key', url: null }),
    new Response('invalid JSON with synthetic secret'),
    new Response(JSON.stringify({ code: 0, data: { padding: 's'.repeat(66_000) } })),
    new Response('{}', { headers: { 'Content-Length': '100000' } }),
    response([]), response(null), new Response(JSON.stringify({ code: -1, message: 'synthetic secret' })),
  ];
  for (const fixture of fixtures) {
    const h = harness(); t.after(() => h.auth.close());
    h.enqueueResponse(fixture);
    await assert.rejects(h.auth.start(signal()), errorCode('SOURCE_UNAVAILABLE'));
  }
  for (const qr of ['https://evil.example/tracker.gif', 'data:text/html;base64,AAAA', GIF + 's'.repeat(200_000)]) {
    const h = harness({ qr: () => qr }); t.after(() => h.auth.close());
    await assert.rejects(h.start(), errorCode('SOURCE_UNAVAILABLE'));
  }
});

test('HTTP/API rate limits and unexpected statuses use sanitized stable errors', async t => {
  for (const fixture of [response({}, [], 412), response({}, [], 429), new Response(JSON.stringify({ code: -352 }))]) {
    const h = harness(); t.after(() => h.auth.close());
    h.enqueueResponse(fixture);
    await assert.rejects(h.auth.start(signal()), errorCode('RATE_LIMITED'));
  }
  const h = harness(); t.after(() => h.auth.close());
  const started = await h.start();
  h.advance(); h.enqueue({ code: 1234, message: 'synthetic secret' });
  await assert.rejects(h.auth.poll(started.sessionId, signal()), errorCode('SOURCE_UNAVAILABLE'));
});
