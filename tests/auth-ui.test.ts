import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Auth, { AuthDialog } from '../src/Auth';
import { authPost, readQrSession, readQrStatus, sessionDeadline } from '../src/auth-client';
import { decodedQuality } from '../src/Player';

const QR = { sessionId: 'fixture-session_1', qrImage: 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==', expiresAt: 1_792_000_180_000 };
const noop = () => {};

test('optional login starts as a compact action without a QR, modal or embedded external page', () => {
  const html = renderToStaticMarkup(createElement(Auth, { onSessionChange: noop }));
  assert.match(html, /<button[^>]*aria-haspopup="dialog"[^>]*>登录提升画质<\/button>/);
  assert.doesNotMatch(html, /<img\b|<iframe\b|role="dialog"|二维码|1080p/);
});

test('the login modal has a labelled dialog, close action, scan instructions and bounded quality wording', () => {
  const html = renderToStaticMarkup(createElement(AuthDialog, { phase: 'waiting', session: QR, onClose: noop, onRetry: noop }));
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="auth-title" aria-describedby="auth-description auth-privacy"/);
  assert.match(html, /aria-label="关闭登录"/);
  assert.match(html, /手机哔哩哔哩扫码/);
  assert.match(html, /alt="哔哩哔哩登录二维码"/);
  assert.match(html, /登录后优先请求1080p，实际以可用片源为准。/);
  assert.match(html, /登录仅保留在本次服务运行期间/);
  assert.match(html, /role="status">等待扫码/);
  assert.doesNotMatch(html, /fixture-session_1|expiresAt|Cookie|SESSDATA|扫码即可1080/);
});

test('expired and failed dialogs remove the old QR and offer an explicit new attempt', () => {
  for (const phase of ['expired', 'error'] as const) {
    const html = renderToStaticMarkup(createElement(AuthDialog, { phase, session: QR, onClose: noop, onRetry: noop }));
    assert.doesNotMatch(html, /<img\b|data:image/);
    assert.match(html, /重新获取二维码/);
  }
  const html = renderToStaticMarkup(createElement(AuthDialog, { phase: 'scanned', session: QR, onClose: noop, onRetry: noop }));
  assert.match(html, /已扫码，请在手机确认/);
});

test('QR parsing retains only display data and rejects remote or active-content image locations', () => {
  assert.deepEqual(readQrSession({ ...QR, cookie: 'synthetic-private-value' }), QR);
  for (const value of [
    { ...QR, qrImage: 'https://example.test/qr.png' },
    { ...QR, qrImage: 'data:image/svg+xml;base64,AAAA' },
    { ...QR, sessionId: 'invalid\nsession' },
    { ...QR, expiresAt: NaN },
    { ...QR, expiresAt: '1792000180000' },
  ]) assert.equal(readQrSession(value), null);
  for (const status of ['waiting', 'scanned', 'ready', 'expired']) assert.equal(readQrStatus({ status }), status);
  assert.equal(readQrStatus({ status: 'error', code: 'NETWORK' }), null);
});

test('the browser QR deadline never exceeds three minutes even if the server gives a later deadline', () => {
  const openedAt = 1_792_000_000_000;
  assert.equal(sessionDeadline(openedAt + 999_000, openedAt), openedAt + 180_000);
  assert.equal(sessionDeadline(openedAt + 30_000, openedAt), openedAt + 30_000);
});

test('authentication posts use the exact local endpoint and retain cancellation behavior', async t => {
  const controller = new AbortController();
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    assert.equal(input, '/api/auth/poll');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { sessionId: QR.sessionId });
    assert.equal(init?.signal, controller.signal);
    return new Response(JSON.stringify({ status: 'waiting' }));
  });
  assert.deepEqual(await authPost('poll', { sessionId: QR.sessionId }, controller.signal), { status: 'waiting' });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('quality labels reflect actual decoded heights without assuming the requested resolution', () => {
  assert.equal(decodedQuality(360), '360p');
  assert.equal(decodedQuality(720), '720p');
  assert.equal(decodedQuality(1080), '1080p');
  for (const height of [0, -1, NaN, Infinity, 720.5, 999999]) assert.equal(decodedQuality(height), null);
});
