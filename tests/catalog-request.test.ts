import assert from 'node:assert/strict';
import test from 'node:test';
import { activeMatchForSegment, requestCatalog, type Match } from '../src/catalog';

const bvid = 'BV1xx411c7mD';
const match = (id: string): Match => ({ id, date: '2026-10-24', event: '赛事', home: 'AAA', away: 'BBB' });

test('the active match is resolved from the official upload identifier', () => {
  const official = match(bvid);
  assert.equal(activeMatchForSegment([official], { bvid, cid: 202, page: 4 }), official);
  assert.equal(activeMatchForSegment([], { bvid, cid: 202, page: 4 }), undefined);
  assert.equal(activeMatchForSegment([official]), undefined);
});

test('catalog refresh retries while a cancelled server request releases its slot', async () => {
  const requests: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
  const result = await requestCatalog(true, new AbortController().signal, (async (url, options) => {
    requests.push({ url: String(url), method: options?.method, body: options?.body });
    return requests.length === 1
      ? Response.json({ status: 'error', code: 'BUSY' }, { status: 409 })
      : Response.json({ status: 'ready', matches: [] });
  }) as typeof fetch);
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.url === '/api/matches/refresh' && request.method === 'POST' && request.body === '{}'));
});

test('a cancelled catalog response is rejected before it can replace the current list', async () => {
  const controller = new AbortController();
  const reason = new Error('request cancelled');
  await assert.rejects(requestCatalog(false, controller.signal, (async () => {
    controller.abort(reason);
    return Response.json({ status: 'ready', matches: [] });
  }) as typeof fetch), error => error === reason);
});
