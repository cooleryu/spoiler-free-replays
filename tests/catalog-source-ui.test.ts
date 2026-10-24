import assert from 'node:assert/strict';
import test from 'node:test';
import { activeMatchForSegment, requestCatalog, type Match } from '../src/catalog';

const bvid = 'BV1xx411c7mD';
const match = (id: string): Match => ({ id, date: '2026-10-24', event: '赛事', home: 'AAA', away: 'BBB' });

test('separate matches within one BV resolve by CID instead of the upload alone', () => {
  const first = match(`deyunse:${bvid}:101`);
  const second = match(`deyunse:${bvid}:202`);
  assert.equal(activeMatchForSegment([first, second], { bvid, cid: 202, page: 4 }), second);
  assert.equal(activeMatchForSegment([first], { bvid, cid: 202, page: 4 }), undefined);
  const official = match(bvid);
  assert.equal(activeMatchForSegment([official], { bvid, cid: 202, page: 4 }), official);
});

test('source switching retries a cancelling server request without falling back to another source', async () => {
  const requests: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
  const result = await requestCatalog('deyunse', true, new AbortController().signal, (async (url, options) => {
    requests.push({ url: String(url), method: options?.method, body: options?.body });
    return requests.length === 1
      ? Response.json({ status: 'error', code: 'BUSY' }, { status: 409 })
      : Response.json({ status: 'ready', matches: [] });
  }) as typeof fetch);
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.url === '/api/matches/refresh?source=deyunse' && request.method === 'POST' && request.body === '{}'));
});

test('a superseded catalog response is rejected before it can replace the selected source', async () => {
  const controller = new AbortController();
  const reason = new Error('selection changed');
  await assert.rejects(requestCatalog('official', false, controller.signal, (async () => {
    controller.abort(reason);
    return Response.json({ status: 'ready', matches: [] });
  }) as typeof fetch), error => error === reason);
});
