import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { fetchWithoutWBI } from '@xzxzzx/bilibili-mcp/dist/bilibili/http.js';
import sourceConfig from '../config/source.json';
import { BVID, ReplayError, parseMetadata, type Segment } from './domain';
import { localDir, root } from './paths';

export interface SourceConfig {
  creatorMid: number; sourceName: string; query: string; event: string; year: number; lookbackDays: number;
}
export interface Match {
  id: string; date: string; event: string; home: string; away: string;
}
interface StoredMatch extends Match { publishedAt: number }
interface Snapshot { version: 1; creatorMid: number; query: string; updatedAt: string; matches: StoredMatch[] }
export interface CatalogResult {
  status: 'ready'; sourceName: string; updatedAt: string | null; stale: boolean;
  matches: Match[]; warning?: string;
  bundled?: boolean;
}
export interface PublicSource {
  videos(signal: AbortSignal): Promise<unknown>;
  video(bvid: string, signal: AbortSignal): Promise<unknown>;
}
const SHANGHAI_OFFSET = 8 * 3600_000;
const DAY = 86400_000;
export function shanghaiDate(now: number) { return new Date(now + SHANGHAI_OFFSET).toISOString().slice(0, 10); }
export function recentCutoff(now: number, days: number) {
  return Math.floor((now + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET - days * DAY;
}

/** Exact known title grammar; anything ambiguous or containing a score is omitted, never shown raw. */
export function parseMatchTitle(title: string, bvid: string, config: SourceConfig = sourceConfig): Match | null {
  const clean = title.replace(/<\/?em(?:\s+class=["']keyword["'])?>/gi, '').trim();
  if (clean.length > 512 || /[<>]|\d\s*[:：-]\s*\d/.test(clean) || !BVID.test(bvid)) return null;
  const match = clean.match(/^[【\[]([^】\]]+)[】\]]\s*(\d{1,2})月(\d{1,2})日\s+([A-Za-z][A-Za-z0-9 ._-]{0,39}?)\s+vs\s+([A-Za-z][A-Za-z0-9 ._-]{0,39})$/i);
  if (!match || match[1] !== config.event) return null;
  const date = `${config.year}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  const home = match[4].trim(), away = match[5].trim();
  if (home.toLowerCase() === away.toLowerCase()) return null;
  return { id: bvid, date, event: config.event, home, away };
}

export function normalizeSearch(raw: unknown, now = Date.now(), config: SourceConfig = sourceConfig): StoredMatch[] {
  // The public API can return HTTP/code success with a verification voucher instead of results.
  // Treat that as a source restriction, never as a successful empty catalog.
  if (raw && typeof raw === 'object' && 'v_voucher' in raw) throw new ReplayError('RATE_LIMITED');
  const data = z.object({ result: z.array(z.unknown()).max(100) }).safeParse(raw);
  if (!data.success) throw new ReplayError('SOURCE_UNAVAILABLE');
  const cutoff = recentCutoff(now, config.lookbackDays) / 1000;
  const byId = new Map<string, StoredMatch>();
  for (const value of data.data.result) {
    const row = z.object({ mid: z.number().int(), bvid: z.string().regex(BVID),
      title: z.string().max(512), pubdate: z.number().int().positive() }).safeParse(value);
    if (!row.success || row.data.mid !== config.creatorMid || row.data.pubdate < cutoff || row.data.pubdate > now / 1000 + 300) continue;
    const match = parseMatchTitle(row.data.title, row.data.bvid, config);
    if (!match || match.date > shanghaiDate(now)) continue;
    byId.set(match.id, { ...match, publishedAt: row.data.pubdate });
  }
  return [...byId.values()].sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
}

function gameNumber(title: string): number | null {
  const match = title.trim().match(/^第([一二三四五六七八九十]|\d{1,2})局$/);
  if (!match) return null;
  return /^\d+$/.test(match[1]) ? Number(match[1]) : '一二三四五六七八九十'.indexOf(match[1]) + 1;
}
export function matchSegments(raw: unknown, selected: Match, config: SourceConfig = sourceConfig): Segment[] {
  const video = z.object({ bvid: z.literal(selected.id), title: z.string(),
    owner: z.object({ mid: z.literal(config.creatorMid) }),
    pages: z.array(z.object({ page: z.number(), cid: z.number(), part: z.string() })).min(1).max(1000),
  }).safeParse(raw);
  if (!video.success) throw new ReplayError('MATCH_UNAVAILABLE');
  const confirmed = parseMatchTitle(video.data.title, selected.id, config);
  if (!confirmed || ['date', 'event', 'home', 'away'].some(key => confirmed[key as keyof Match] !== selected[key as keyof Match])) throw new ReplayError('MATCH_UNAVAILABLE');
  let metadata;
  try { metadata = parseMetadata({ bvid: selected.id, title: video.data.title,
    pages: video.data.pages.map(p => ({ page: p.page, cid: p.cid, title: p.part })) }, selected.id); }
  catch { throw new ReplayError('MATCH_UNAVAILABLE'); }
  // Verified uploads label games 第一局...; commentary, interviews and draw ceremonies are not games.
  // Unknown parts fail closed instead of silently pretending we know whether a game is missing.
  if (metadata.pages.some(p => gameNumber(p.title) === null && !/^(赛后采访|赛前评论|瑞士轮抽签|赛前节目|赛前分析|开场|颁奖仪式)$/.test(p.title.trim()))) throw new ReplayError('MATCH_UNAVAILABLE');
  const games = metadata.pages.filter(p => gameNumber(p.title) !== null)
    .sort((a, b) => gameNumber(a.title)! - gameNumber(b.title)!);
  if (!games.length || games.some((p, index) => gameNumber(p.title) !== index + 1)) throw new ReplayError('MATCH_UNAVAILABLE');
  return games.map(({ page, cid }) => ({ bvid: selected.id, cid, page }));
}

function sourceFailure(error: unknown, signal: AbortSignal): ReplayError {
  if (signal.aborted) return new ReplayError('CANCELLED');
  if (error instanceof ReplayError) return error;
  const value = error as { code?: unknown; statusCode?: unknown; originalError?: { code?: unknown } };
  if (value?.statusCode === 412 || value?.statusCode === 429 || [value?.code, value?.originalError?.code].some(code => ['-352', '-412'].includes(String(code)))) return new ReplayError('RATE_LIMITED');
  return new ReplayError('SOURCE_UNAVAILABLE');
}

export function createPublicSource(config: SourceConfig = sourceConfig): PublicSource {
  return {
    // Fixed public endpoint and local query. No cookies, browser, login, arbitrary URL or model execution.
    videos: signal => fetchWithoutWBI('/x/web-interface/wbi/search/type', {
      search_type: 'video', keyword: config.query, page: 1, page_size: 50, order: 'pubdate', duration: 4,
    }, {}, signal),
    video: (bvid, signal) => fetchWithoutWBI('/x/web-interface/view', { bvid }, {}, signal),
  };
}

/** One bounded public query on first use or explicit refresh; no timer or background collection. */
export class MatchCatalog {
  private snapshot?: Snapshot;
  private loaded?: Promise<void>;
  private pending?: Promise<CatalogResult>;
  private lastAttempt = 0;
  private bundled = false;
  constructor(private options: { source?: PublicSource; now?: () => number; cacheFile?: string | null; seedFile?: string | null; config?: SourceConfig } = {}) {}
  private get config() { return this.options.config ?? sourceConfig; }
  private get source() { return this.options.source ?? createPublicSource(this.config); }
  private get now() { return this.options.now?.() ?? Date.now(); }
  private get cacheFile() { return this.options.cacheFile === null ? null : this.options.cacheFile ?? resolve(localDir, 'catalog.json'); }
  private get seedFile() { return this.options.seedFile === null ? null : this.options.seedFile ?? resolve(root, 'config/catalog.seed.json'); }
  private async readSnapshot(file: string | null): Promise<Snapshot | undefined> {
    if (!file) return;
    try {
      const text = await readFile(file, 'utf8');
      if (text.length > 100_000) return;
      const saved = JSON.parse(text) as Snapshot;
      if (saved.version !== 1 || saved.creatorMid !== this.config.creatorMid || saved.query !== this.config.query
        || !Number.isFinite(Date.parse(saved.updatedAt)) || !Array.isArray(saved.matches) || saved.matches.length > 50) return;
      const matches = saved.matches.filter(m => {
        if (!Number.isSafeInteger(m.publishedAt) || m.publishedAt <= 0 || typeof m.home !== 'string' || typeof m.away !== 'string' || typeof m.date !== 'string') return false;
        const parsed = parseMatchTitle(`【${m.event}】${Number(m.date.slice(5, 7))}月${Number(m.date.slice(8))}日 ${m.home} vs ${m.away}`, m.id, this.config);
        return parsed && ['id', 'date', 'event', 'home', 'away'].every(key => parsed[key as keyof Match] === m[key as keyof Match]);
      });
      if (matches.length !== saved.matches.length || new Set(matches.map(m => m.id)).size !== matches.length) return;
      return { version: 1, creatorMid: saved.creatorMid, query: saved.query, updatedAt: saved.updatedAt,
        matches: matches.map(({ id, date, event, home, away, publishedAt }) => ({ id, date, event, home, away, publishedAt })) };
    } catch { return; }
  }
  private async load() {
    this.loaded ??= (async () => {
      this.snapshot = await this.readSnapshot(this.cacheFile);
      if (this.snapshot) return;
      this.snapshot = await this.readSnapshot(this.seedFile);
      this.bundled = Boolean(this.snapshot);
    })();
    await this.loaded;
  }
  private present(warning?: string): CatalogResult {
    const cutoff = recentCutoff(this.now, this.config.lookbackDays) / 1000;
    return { status: 'ready', sourceName: this.config.sourceName, updatedAt: this.snapshot?.updatedAt ?? null,
      stale: this.bundled || Boolean(warning) || !this.snapshot || this.now - Date.parse(this.snapshot.updatedAt) > 15 * 60_000,
      matches: (this.snapshot?.matches ?? []).filter(m => m.publishedAt >= cutoff)
        .map(({ id, date, event, home, away }) => ({ id, date, event, home, away })),
      ...(this.bundled ? { bundled: true } : {}),
      ...(warning ? { warning } : {}) };
  }
  async get(signal: AbortSignal): Promise<CatalogResult> {
    await this.load();
    if (signal.aborted) throw new ReplayError('CANCELLED');
    return this.snapshot ? this.present() : this.refresh(signal);
  }
  async refresh(signal: AbortSignal): Promise<CatalogResult> {
    await this.load();
    if (signal.aborted) throw new ReplayError('CANCELLED');
    if (this.pending) throw new ReplayError('BUSY');
    if (this.lastAttempt && this.now - this.lastAttempt < 3000) {
      if (this.snapshot) return this.present('RATE_LIMITED');
      throw new ReplayError('RATE_LIMITED');
    }
    this.lastAttempt = this.now;
    this.pending = (async () => {
      try {
        const raw = await this.source.videos(signal);
        if (signal.aborted) throw new ReplayError('CANCELLED');
        const snapshot: Snapshot = { version: 1, creatorMid: this.config.creatorMid, query: this.config.query,
          updatedAt: new Date(this.now).toISOString(), matches: normalizeSearch(raw, this.now, this.config) };
        if (this.cacheFile) {
          try {
            await mkdir(resolve(this.cacheFile, '..'), { recursive: true, mode: 0o700 });
            await writeFile(`${this.cacheFile}.tmp`, JSON.stringify(snapshot), { mode: 0o600, signal });
            if (signal.aborted) throw new ReplayError('CANCELLED');
            await rename(`${this.cacheFile}.tmp`, this.cacheFile);
          } catch { /* An unwritable optional cache must not block the real response. */ }
        }
        if (signal.aborted) throw new ReplayError('CANCELLED');
        this.snapshot = snapshot;
        this.bundled = false;
        return this.present();
      } catch (e) {
        const failure = sourceFailure(e, signal);
        if (failure.code === 'CANCELLED') throw failure;
        if (this.snapshot) return this.present(failure.code);
        throw failure;
      }
    })();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  async watch(id: string, signal: AbortSignal): Promise<Segment[]> {
    await this.load();
    if (signal.aborted) throw new ReplayError('CANCELLED');
    const selected = this.snapshot?.matches.find(match => match.id === id);
    if (!selected || !this.present().matches.some(m => m.id === id)) throw new ReplayError('MATCH_UNAVAILABLE');
    try {
      const data = await this.source.video(selected.id, signal);
      if (signal.aborted) throw new ReplayError('CANCELLED');
      return matchSegments(data, selected, this.config);
    } catch (e) { throw sourceFailure(e, signal); }
  }
}
