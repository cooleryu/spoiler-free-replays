import { z } from 'zod';

export const BVID = /^BV[1-9A-HJ-NP-Za-km-z]{10}$/;
export const segmentSchema = z.object({
  bvid: z.string().regex(BVID), cid: z.number().int().positive().safe(),
  page: z.number().int().min(1).max(1000),
}).strict();
export type Segment = z.infer<typeof segmentSchema>;
export const requestSchema = z.object({
  mode: z.enum(['search', 'import']), input: z.string().trim().min(1).max(300),
}).strict();
export type PrepareInput = z.infer<typeof requestSchema>;
export const resultSchema = z.object({
  status: z.enum(['ready', 'not_found', 'ambiguous', 'incomplete']),
  segments: z.array(segmentSchema).max(1000),
}).strict();
export const outputSchema = {
  type: 'object', additionalProperties: false, required: ['status', 'segments'],
  properties: {
    status: { type: 'string', enum: ['ready', 'not_found', 'ambiguous', 'incomplete'] },
    segments: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['bvid', 'cid', 'page'],
      properties: { bvid: { type: 'string' }, cid: { type: 'integer' }, page: { type: 'integer' } },
    } },
  },
};
export type ErrorCode = 'CODEX_MISSING' | 'CODEX_LOGIN' | 'BILIBILI_LOGIN' | 'TOOL_UNAVAILABLE'
  | 'NETWORK' | 'NOT_FOUND' | 'AMBIGUOUS' | 'INCOMPLETE' | 'INVALID_INPUT'
  | 'TIMEOUT' | 'CANCELLED' | 'BUSY' | 'INTERNAL'
  | 'SOURCE_UNAVAILABLE' | 'RATE_LIMITED' | 'MATCH_UNAVAILABLE';
export class ReplayError extends Error {
  constructor(public code: ErrorCode, options?: ErrorOptions) { super(code, options); this.name = 'ReplayError'; }
}
export function errorCode(error: unknown): ErrorCode {
  return error instanceof ReplayError ? error.code : 'INTERNAL';
}

/** Deliberately no redirects, short links, arbitrary hosts, userinfo or ports. */
export function parseImport(input: string): { bvid: string; page: number } {
  const value = input.trim();
  if (BVID.test(value)) return { bvid: value, page: 1 };
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10})\/?$/);
    const pages = url.searchParams.getAll('p');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)
      || !match || pages.length > 1 || (pages.length === 1 && !/^[1-9]\d{0,2}$/.test(pages[0]))) {
      throw new Error();
    }
    return { bvid: match[1], page: Number(pages[0] ?? 1) };
  } catch { throw new ReplayError('INVALID_INPUT'); }
}

export interface Metadata {
  bvid: string; title: string; description: string; author?: string;
  pubdate?: string | number; tags?: unknown;
  pages: { page: number; cid: number; title: string; duration?: number }[];
}
export function parseMetadata(raw: unknown, bvid: string): Metadata {
  const parsed = z.object({
    bvid: z.literal(bvid), title: z.string(), description: z.string().default(''),
    author: z.string().optional(), pubdate: z.union([z.string(), z.number()]).optional(),
    tags: z.unknown().optional(),
    pages: z.array(z.object({
      page: z.number().int().min(1).max(1000), cid: z.number().int().positive().safe(),
      title: z.string(), duration: z.number().optional(),
    })).min(1).max(1000),
  }).safeParse(raw);
  if (!parsed.success) throw new ReplayError('INCOMPLETE');
  const meta = parsed.data;
  meta.pages.sort((a, b) => a.page - b.page);
  if (new Set(meta.pages.map(p => p.cid)).size !== meta.pages.length
    || meta.pages.some((p, i) => p.page !== i + 1)) throw new ReplayError('INCOMPLETE');
  return meta;
}

export interface Evidence {
  searches: number; successfulSearches: number; found: Set<string>; metadata: Map<string, Metadata>;
}
export function validateSelection(raw: unknown, evidence: Evidence): Segment[] {
  const result = resultSchema.safeParse(raw);
  if (!result.success) throw new ReplayError('INCOMPLETE');
  const { status, segments } = result.data;
  if (status === 'ambiguous' && !segments.length && !evidence.searches) throw new ReplayError('AMBIGUOUS');
  if (!evidence.successfulSearches) throw new ReplayError('NETWORK');
  if (status !== 'ready') {
    if (segments.length) throw new ReplayError('INCOMPLETE');
    // An empty-result statement is only accepted after an actual empty search.
    if (status === 'not_found' && !evidence.found.size) throw new ReplayError('NOT_FOUND');
    if (status === 'not_found') throw new ReplayError('AMBIGUOUS');
    throw new ReplayError(status === 'ambiguous' ? 'AMBIGUOUS' : 'INCOMPLETE');
  }
  if (!segments.length) throw new ReplayError('INCOMPLETE');
  const seen = new Set<string>();
  const lastPages = new Map<string, number>();
  const completedVideos = new Set<string>();
  let currentVideo: string | undefined;
  for (const s of segments) {
    const key = `${s.bvid}:${s.cid}`;
    const meta = evidence.metadata.get(s.bvid);
    if (!evidence.found.has(s.bvid) || !meta?.pages.some(p => p.page === s.page && p.cid === s.cid)
      || seen.has(key) || (lastPages.has(s.bvid) && s.page <= lastPages.get(s.bvid)!)) {
      throw new ReplayError('INCOMPLETE');
    }
    if (currentVideo !== s.bvid) {
      if (currentVideo) completedVideos.add(currentVideo);
      if (completedVideos.has(s.bvid)) throw new ReplayError('INCOMPLETE');
      currentVideo = s.bvid;
    }
    seen.add(key); lastPages.set(s.bvid, s.page);
  }
  return segments;
}
