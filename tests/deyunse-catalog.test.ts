import assert from 'node:assert/strict';
import test from 'node:test';
import { DeyunseCatalog, DEYUNSE_BVID, deyunseMatchId, isDeyunseMatchId } from '../server/deyunse-catalog';
import { ReplayError } from '../server/domain';

const signal = () => new AbortController().signal;
const unavailable = (error: unknown) => error instanceof ReplayError && error.code === 'MATCH_UNAVAILABLE';
const page = (cid: number, part: string, index: number) => ({ cid, part, page: index, duration: 999 });
const fixture = () => ({
  bvid: DEYUNSE_BVID, owner: { mid: 8739477 }, title: 'DO NOT DISPLAY ORIGINAL TITLE',
  desc: 'DO NOT DISPLAY DESCRIPTION', pic: 'https://example.invalid/cover.jpg',
  pages: [page(101, '解说甲：AAA vs BBB（纯净版）', 1), page(102, '解说乙: CCC vs DDD (纯净版)', 2),
    page(103, '解说甲：AAA vs BBB（弹幕版）', 3), page(104, '其他内容', 4)],
});

test('only independent clean-version entries are exposed, with no raw metadata', async () => {
  const catalog = new DeyunseCatalog({ source: { video: async () => fixture() } });
  const result = await catalog.get(signal());
  assert.deepEqual(result.matches.map(m => [m.home, m.away]), [['AAA', 'BBB'], ['CCC', 'DDD']]);
  assert.deepEqual(Object.keys(result.matches[0]).sort(), ['away', 'date', 'event', 'home', 'id']);
  assert.doesNotMatch(JSON.stringify(result), /DO NOT DISPLAY|duration|pic|纯净版|弹幕版|解说/);
  assert.deepEqual(await catalog.watch(result.matches[1].id, signal()), [{ bvid: DEYUNSE_BVID, cid: 102, page: 2 }]);
  await assert.rejects(catalog.watch(deyunseMatchId(DEYUNSE_BVID, 103), signal()), unavailable);
});

test('wrong ownership, ambiguous clean duplicates and unsafe labels cannot become matches', async () => {
  const wrong = fixture(); wrong.owner.mid = 1;
  await assert.rejects(new DeyunseCatalog({ source: { video: async () => wrong } }).get(signal()), unavailable);
  const duplicate = fixture();
  duplicate.pages.push(page(105, '另一前缀：bbb vs aaa（纯净版）', 5), page(106, 'AAA WINNER vs BBB（纯净版）', 6),
    page(107, 'AAA vs WINNER（纯净版）', 7), page(108, 'AAA 2-0 vs BBB（纯净版）', 8));
  const catalog = new DeyunseCatalog({ source: { video: async () => duplicate } });
  assert.deepEqual((await catalog.get(signal())).matches.map(m => m.id), [deyunseMatchId(DEYUNSE_BVID, 102)]);
  assert.equal(isDeyunseMatchId(`deyunse:${DEYUNSE_BVID}:9007199254740992`), false);
  assert.equal(isDeyunseMatchId(`deyunse:${DEYUNSE_BVID}:0101`), false);
});

test('watch revalidates clean identity and resolves current page after a reorder', async () => {
  let data = fixture();
  const catalog = new DeyunseCatalog({ source: { video: async () => data } });
  const id = (await catalog.get(signal())).matches[0].id;
  data = { ...data, pages: [...data.pages].reverse().map((p, i) => ({ ...p, page: i + 1 })) };
  assert.deepEqual(await catalog.watch(id, signal()), [{ bvid: DEYUNSE_BVID, cid: 101, page: 4 }]);
  data.pages[3].part = '解说甲：EEE vs FFF（纯净版）';
  await assert.rejects(catalog.watch(id, signal()), unavailable);
  data.pages[3].part = '解说甲：AAA vs BBB（弹幕版）';
  await assert.rejects(catalog.watch(id, signal()), unavailable);
});

test('saved identifiers can resume after restart while cancelled refresh keeps previous safe data', async () => {
  let now = Date.parse('2026-10-24T02:00:00Z');
  let data = fixture();
  const catalog = new DeyunseCatalog({ now: () => now, source: { video: async () => data } });
  assert.deepEqual(await catalog.watch(deyunseMatchId(DEYUNSE_BVID, 101), signal()), [{ bvid: DEYUNSE_BVID, cid: 101, page: 1 }]);
  const before = await catalog.get(signal());
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(catalog.refresh(cancelled.signal), (error: unknown) => error instanceof ReplayError && error.code === 'CANCELLED');
  assert.deepEqual(await catalog.get(signal()), before);
  now += 5000; data = { ...data, owner: { mid: 1 } };
  const stale = await catalog.refresh(signal());
  assert.equal(stale.stale, true);
  assert.equal(stale.warning, 'SOURCE_UNAVAILABLE');
  assert.deepEqual(stale.matches, before.matches);
});
