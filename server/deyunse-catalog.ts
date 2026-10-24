import { z } from 'zod';
import { createPublicSource, type CatalogResult, type Match, type PublicSource } from './catalog';
import { ReplayError, parseMetadata, type Segment } from './domain';

// This adapter intentionally admits only the upload the user selected, not the creator's feed.
export const DEYUNSE_BVID = 'BV1c5na61EdC';
const CREATOR_MID = 8739477;
const MATCH_DATE = '2026-10-24';
const EVENT = '2026全球总决赛';
const SOURCE_NAME = '德云色';
interface Entry { match: Match; segment: Segment }

export function isDeyunseVideo(bvid: string): boolean { return bvid === DEYUNSE_BVID; }
export function deyunseMatchId(bvid: string, cid: number): string { return `deyunse:${bvid}:${cid}`; }
export function isDeyunseMatchId(id: string): boolean {
  const prefix = `deyunse:${DEYUNSE_BVID}:`;
  if (!id.startsWith(prefix)) return false;
  const cid = id.slice(prefix.length);
  return /^[1-9]\d{0,15}$/.test(cid) && Number.isSafeInteger(Number(cid));
}

function pureMatch(part: string): { home: string; away: string } | null {
  if (part.length > 160 || /[<>\u0000-\u001f]/.test(part)) return null;
  // The commentator prefix is discarded. Only compact team identifiers in an exact clean-version label survive.
  const parsed = part.trim().match(/^(?:[^：:()（）<>]{1,30}[：:]\s*)?([A-Za-z][A-Za-z0-9]{0,9})\s+vs\s+([A-Za-z][A-Za-z0-9]{0,9})\s*[（(]纯净版[）)]$/i);
  if (!parsed) return null;
  const home = parsed[1].toUpperCase(), away = parsed[2].toUpperCase();
  const outcome = /^(WIN|WINS|WINNER|WINNERS|LOSE|LOSES|LOSS|LOSER|LOSERS|VICTORY|DEFEAT|ADVANCE|ELIMINATED|SWEEP)$/;
  if (home === away || outcome.test(home) || outcome.test(away)) return null;
  return { home, away };
}

function entriesFrom(raw: unknown): Entry[] {
  const parsed = z.object({
    bvid: z.literal(DEYUNSE_BVID), owner: z.object({ mid: z.literal(CREATOR_MID) }),
    pages: z.array(z.object({ page: z.number(), cid: z.number(), part: z.string().max(1000) })).min(1).max(1000),
  }).safeParse(raw);
  if (!parsed.success) throw new ReplayError('MATCH_UNAVAILABLE');
  let pages;
  try {
    pages = parseMetadata({ bvid: DEYUNSE_BVID, title: '',
      pages: parsed.data.pages.map(p => ({ page: p.page, cid: p.cid, title: p.part })) }, DEYUNSE_BVID).pages;
  } catch { throw new ReplayError('MATCH_UNAVAILABLE'); }
  const byPair = new Map<string, Entry>();
  const ambiguous = new Set<string>();
  for (const page of pages) {
    const pair = pureMatch(page.title);
    if (!pair) continue;
    const pairKey = [pair.home, pair.away].sort().join(':');
    if (byPair.has(pairKey)) { ambiguous.add(pairKey); continue; }
    byPair.set(pairKey, {
      match: { id: deyunseMatchId(DEYUNSE_BVID, page.cid), date: MATCH_DATE, event: EVENT, ...pair },
      segment: { bvid: DEYUNSE_BVID, cid: page.cid, page: page.page },
    });
  }
  const entries = [...byPair].filter(([pairKey]) => !ambiguous.has(pairKey)).map(([, entry]) => entry);
  if (!entries.length || entries.length > 50) throw new ReplayError('MATCH_UNAVAILABLE');
  return entries;
}

function failure(error: unknown, signal: AbortSignal): ReplayError {
  if (signal.aborted) return new ReplayError('CANCELLED');
  if (error instanceof ReplayError) return error;
  const value = error as { code?: unknown; statusCode?: unknown; originalError?: { code?: unknown } };
  if (value?.statusCode === 412 || value?.statusCode === 429
    || [value?.code, value?.originalError?.code].some(code => ['-352', '-412'].includes(String(code)))) return new ReplayError('RATE_LIMITED');
  return new ReplayError('SOURCE_UNAVAILABLE');
}

/** A daily multipart upload becomes independent, clean-version matches. No raw metadata is cached. */
export class DeyunseCatalog {
  private entries?: Entry[];
  private updatedAt: string | null = null;
  private lastAttempt?: number;
  private warning?: string;
  private pending?: Promise<CatalogResult>;
  constructor(private options: { source?: Pick<PublicSource, 'video'>; now?: () => number } = {}) {}
  private get now() { return this.options.now?.() ?? Date.now(); }
  private get source() { return this.options.source ?? createPublicSource(); }
  private present(): CatalogResult {
    return { status: 'ready', sourceName: SOURCE_NAME, updatedAt: this.updatedAt,
      stale: Boolean(this.warning) || !this.updatedAt || this.now - Date.parse(this.updatedAt) > 15 * 60_000,
      matches: (this.entries ?? []).map(({ match }) => ({ ...match })),
      ...(this.warning ? { warning: this.warning } : {}) };
  }
  private async read(signal: AbortSignal): Promise<Entry[]> {
    if (signal.aborted) throw new ReplayError('CANCELLED');
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    try {
      const raw = await this.source.video(DEYUNSE_BVID, requestSignal);
      if (requestSignal.aborted) throw new ReplayError(signal.aborted ? 'CANCELLED' : 'TIMEOUT');
      return entriesFrom(raw);
    } catch (error) {
      if (!signal.aborted && requestSignal.aborted) throw new ReplayError('TIMEOUT');
      throw failure(error, signal);
    }
  }
  private save(entries: Entry[]) {
    this.entries = entries;
    this.updatedAt = new Date(this.now).toISOString();
    this.warning = undefined;
  }
  async get(signal: AbortSignal): Promise<CatalogResult> {
    if (signal.aborted) throw new ReplayError('CANCELLED');
    return this.entries ? this.present() : this.refresh(signal);
  }
  async refresh(signal: AbortSignal): Promise<CatalogResult> {
    if (signal.aborted) throw new ReplayError('CANCELLED');
    if (this.pending) return this.pending;
    if (this.lastAttempt !== undefined && this.now - this.lastAttempt < 3000) {
      if (!this.entries) throw new ReplayError('RATE_LIMITED');
      this.warning = 'RATE_LIMITED';
      return this.present();
    }
    this.lastAttempt = this.now;
    this.pending = (async () => {
      try { this.save(await this.read(signal)); }
      catch (error) {
        const problem = failure(error, signal);
        if (problem.code === 'CANCELLED' || !this.entries) throw problem;
        this.warning = problem.code === 'MATCH_UNAVAILABLE' ? 'SOURCE_UNAVAILABLE' : problem.code;
      }
      return this.present();
    })();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  async watch(id: string, signal: AbortSignal): Promise<Segment[]> {
    if (!isDeyunseMatchId(id)) throw new ReplayError('MATCH_UNAVAILABLE');
    const previous = this.entries?.find(entry => entry.match.id === id);
    if (this.entries && !previous) throw new ReplayError('MATCH_UNAVAILABLE');
    const current = await this.read(signal);
    const selected = current.find(entry => entry.match.id === id);
    if (!selected || (previous && (selected.match.home !== previous.match.home || selected.match.away !== previous.match.away))) {
      throw new ReplayError('MATCH_UNAVAILABLE');
    }
    this.save(current);
    // Never append another clean match or its alternate version to this playback queue.
    return [{ ...selected.segment }];
  }
}
