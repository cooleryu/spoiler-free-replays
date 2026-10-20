import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BVID, ReplayError, errorCode, parseImport, parseMetadata, requestSchema,
  resultSchema, segmentSchema, validateSelection,
  type ErrorCode, type Evidence, type Metadata, type Segment,
} from '../server/domain';

// Format-valid synthetic identifiers: no network requests or real search results.
const A = 'BV1xx411c7mD';
const B = 'BV1yy411c7mE';
const part = (bvid = A, page = 1, cid = 100 + page): Segment => ({ bvid, page, cid });
const metadata = (bvid = A, count = 3, offset = 100): Metadata => parseMetadata({
  bvid, title: 'Synthetic fixture, never shown in the viewing interface',
  pages: Array.from({ length: count }, (_, i) => ({ page: i + 1, cid: offset + i + 1, title: `Fixture ${i + 1}` })),
}, bvid);
const evidence = (): Evidence => ({
  searches: 1, successfulSearches: 1, found: new Set([A, B]),
  metadata: new Map([[A, metadata()], [B, metadata(B, 2, 200)]]),
});
function hasCode(code: ErrorCode) {
  return (error: unknown) => error instanceof ReplayError && error.code === code;
}
function rejectsSelection(raw: unknown, code: ErrorCode = 'INCOMPLETE', source = evidence()) {
  assert.throws(() => validateSelection(raw, source), hasCode(code));
}

test('imports accept BV identifiers and only recognized Bilibili video URL shapes', () => {
  assert.equal(BVID.test(A), true);
  assert.deepEqual(parseImport(`  ${A}\n`), { bvid: A, page: 1 });
  for (const host of ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com']) {
    assert.deepEqual(parseImport(`https://${host}/video/${A}/?p=10&share_source=copy#reply`), { bvid: A, page: 10 });
  }
  assert.deepEqual(parseImport(`http://www.bilibili.com/video/${A}`), { bvid: A, page: 1 });
});

test('imports reject arbitrary hosts, SSRF shapes, credentials, ports and alternate paths', () => {
  const invalid = [
    '', 'av12345', 'BV0000000000', 'BV1xx411c7m', `${A}extra`,
    `https://127.0.0.1/video/${A}`, `http://localhost/video/${A}`, `http://[::1]/video/${A}`,
    `https://bilibili.com.evil.example/video/${A}`, `https://evil.example/bilibili.com/video/${A}`,
    `https://www.bilibili.com@evil.example/video/${A}`, `https://evil@www.bilibili.com/video/${A}`,
    `https://user:password@www.bilibili.com/video/${A}`, `https://www.bilibili.com:8080/video/${A}`,
    `ftp://www.bilibili.com/video/${A}`, `file:///video/${A}`, `javascript:alert('${A}')`,
    `//www.bilibili.com/video/${A}`, `https://b23.tv/${A}`,
    `https://www.bilibili.com/bangumi/play/${A}`, `https://www.bilibili.com/video/${A}/extra`,
    `https://www.bilibili.com/video/BV1xx411c7m0`,
  ];
  for (const value of invalid) assert.throws(() => parseImport(value), hasCode('INVALID_INPUT'), value);
});

test('imports reject duplicate or malformed page selectors', () => {
  for (const query of ['p=1&p=2', 'p=1&p=1', 'p=1&%70=2', 'p=', 'p=0', 'p=-1', 'p=01', 'p=1.5', 'p=1e2', 'p=NaN', 'p=1001']) {
    assert.throws(() => parseImport(`https://www.bilibili.com/video/${A}?${query}`), hasCode('INVALID_INPUT'), query);
  }
});

test('schemas whitelist only the intended input and playback identity fields', () => {
  assert.deepEqual(requestSchema.parse({ mode: 'search', input: '  fixture match  ' }), { mode: 'search', input: 'fixture match' });
  for (const value of [
    { mode: 'search', input: '' }, { mode: 'search', input: 'x'.repeat(301) },
    { mode: 'execute', input: 'fixture' }, { mode: 'search', input: 'fixture', command: 'ignored' },
  ]) assert.equal(requestSchema.safeParse(value).success, false);
  assert.equal(segmentSchema.safeParse(part()).success, true);
  for (const value of [
    { ...part(), title: 'Spoiler title' }, { ...part(), score: '3:0' }, { ...part(), duration: 100 },
    { ...part(), cid: '101' }, { ...part(), cid: 0 }, { ...part(), cid: 1.5 },
    { ...part(), cid: Number.MAX_SAFE_INTEGER + 1 }, { ...part(), page: 0 },
    { ...part(), page: 1.5 }, { ...part(), page: 1001 }, { ...part(), bvid: 'guessed' },
  ]) assert.equal(segmentSchema.safeParse(value).success, false);
  assert.equal(resultSchema.safeParse({ status: 'ready', segments: [part()], explanation: 'raw reasoning' }).success, false);
  rejectsSelection({ status: 'ready', segments: [{ ...part(), title: 'Spoiler title' }] });
});

test('metadata sorts page numbers numerically, including P2 before P10', () => {
  const input = metadata(A, 12);
  input.pages.reverse();
  const parsed = parseMetadata(input, A);
  assert.deepEqual(parsed.pages.map(p => p.page), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(parsed.pages[1].cid, 102);
  assert.equal(parsed.pages[9].cid, 110);
});

test('metadata rejects missing pages, duplicate pages or cid values and mismatched BV', () => {
  const input = metadata();
  const invalid = [
    { ...input, pages: [] }, { ...input, pages: input.pages.filter(p => p.page !== 2) },
    { ...input, pages: input.pages.slice(1) },
    { ...input, pages: [input.pages[0], { ...input.pages[1], page: 1 }] },
    { ...input, pages: [input.pages[0], { ...input.pages[1], cid: 101 }] },
    { ...input, pages: [{ page: 1, cid: '101', title: 'Fixture' }] },
    { ...input, pages: [{ page: 1, cid: 0, title: 'Fixture' }] },
    { ...input, bvid: B },
  ];
  for (const value of invalid) assert.throws(() => parseMetadata(value, A), hasCode('INCOMPLETE'));
});

test('selection accepts only ordered identities verified in tool evidence', () => {
  const segments = [part(A, 1), part(A, 2), part(A, 3), part(B, 1, 201), part(B, 2, 202)];
  assert.deepEqual(validateSelection({ status: 'ready', segments }, evidence()), segments);
});

test('selection refuses guessed BV, cid, page and missing metadata', () => {
  rejectsSelection({ status: 'ready', segments: [part(A, 1, 999)] });
  rejectsSelection({ status: 'ready', segments: [part(A, 2, 101)] });
  rejectsSelection({ status: 'ready', segments: [part(A, 4, 104)] });
  const notFoundByTool = evidence();
  notFoundByTool.found.delete(A);
  rejectsSelection({ status: 'ready', segments: [part()] }, 'INCOMPLETE', notFoundByTool);
  const notVerified = evidence();
  notVerified.metadata.delete(A);
  rejectsSelection({ status: 'ready', segments: [part()] }, 'INCOMPLETE', notVerified);
});

test('selection rejects duplicates, descending pages and re-entry into an earlier BV', () => {
  rejectsSelection({ status: 'ready', segments: [part(), part()] });
  rejectsSelection({ status: 'ready', segments: [part(A, 2), part(A, 1)] });
  rejectsSelection({ status: 'ready', segments: [part(A, 1), part(B, 1, 201), part(A, 2)] });
});

test('empty results require successful search evidence and mismatched candidates remain ambiguous', () => {
  const emptyEvidence = evidence();
  emptyEvidence.found.clear();
  emptyEvidence.metadata.clear();
  rejectsSelection({ status: 'not_found', segments: [] }, 'NOT_FOUND', emptyEvidence);
  // Candidates from a wrong year or opponent are not proof that no results exist.
  rejectsSelection({ status: 'not_found', segments: [] }, 'AMBIGUOUS');
  rejectsSelection({ status: 'ambiguous', segments: [] }, 'AMBIGUOUS');
  rejectsSelection({ status: 'incomplete', segments: [] });
  rejectsSelection({ status: 'ready', segments: [] });
  rejectsSelection({ status: 'not_found', segments: [part()] });
  for (const successfulSearches of [0]) {
    rejectsSelection({ status: 'not_found', segments: [] }, 'NETWORK', { ...emptyEvidence, successfulSearches });
    rejectsSelection({ status: 'ready', segments: [part()] }, 'NETWORK', { ...evidence(), successfulSearches });
  }
});

test('unexpected internal error details are reduced to an allowlisted error code', () => {
  assert.equal(errorCode(new Error('secret or raw upstream output')), 'INTERNAL');
  assert.equal(errorCode({ code: 'BILIBILI_LOGIN' }), 'INTERNAL');
  assert.equal(errorCode(new ReplayError('BILIBILI_LOGIN')), 'BILIBILI_LOGIN');
});
