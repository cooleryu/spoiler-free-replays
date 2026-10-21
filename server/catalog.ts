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
export interface StoredMatch extends Match { publishedAt: number }
export interface Snapshot { version: 1; creatorMid: number; query: string; updatedAt: string; matches: StoredMatch[] }
const CATALOG_WARNINGS = ['SOURCE_UNAVAILABLE', 'RATE_LIMITED', 'NETWORK', 'TIMEOUT', 'BUSY'] as const;
export type CatalogWarning = typeof CATALOG_WARNINGS[number];
export interface PublicSnapshot extends Snapshot { stale: boolean; warning?: CatalogWarning; bundled?: true }
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

/** Reconstruct only safe catalog fields from a cache or shared directory response. */
export function parseSnapshot(raw: unknown, config: SourceConfig = sourceConfig, now = Date.now()): Snapshot | undefined {
  const parsed = z.object({
    version: z.literal(1), creatorMid: z.literal(config.creatorMid), query: z.literal(config.query),
    updatedAt: z.string().datetime({ offset: true }),
    matches: z.array(z.object({
      id: z.string().regex(BVID), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      event: z.literal(config.event), home: z.string().max(40), away: z.string().max(40),
      publishedAt: z.number().int().positive().safe(),
    })).max(50),
  }).safeParse(raw);
  if (!parsed.success || !Number.isFinite(now)) return;
  const saved = parsed.data;
  const updated = Date.parse(saved.updatedAt);
  if (updated < Date.UTC(2000, 0, 1) || updated > now + 300_000) return;
  const matches: StoredMatch[] = [];
  for (const item of saved.matches) {
    if (item.publishedAt < Date.UTC(2000, 0, 1) / 1000 || item.publishedAt > Math.min(now, updated) / 1000 + 300
      || item.date > shanghaiDate(now)) return;
    const match = parseMatchTitle(`【${item.event}】${Number(item.date.slice(5, 7))}月${Number(item.date.slice(8))}日 ${item.home} vs ${item.away}`, item.id, config);
    if (!match || ['id', 'date', 'event', 'home', 'away'].some(key => match[key as keyof Match] !== item[key as keyof Match])) return;
    matches.push({ ...match, publishedAt: item.publishedAt });
  }
  if (new Set(matches.map(match => match.id)).size !== matches.length) return;
  return { version: 1, creatorMid: config.creatorMid, query: config.query, updatedAt: saved.updatedAt, matches };
}

const snapshotStatusSchema = z.object({
  stale: z.boolean().optional(), warning: z.enum(CATALOG_WARNINGS).optional(), bundled: z.literal(true).optional(),
});
function catalogWarning(value: string): CatalogWarning {
  return CATALOG_WARNINGS.includes(value as CatalogWarning) ? value as CatalogWarning : 'SOURCE_UNAVAILABLE';
}

async function fetchSharedSnapshot(address: string, config: SourceConfig, now: number, signal: AbortSignal): Promise<PublicSnapshot> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  try {
    const url = new URL(address);
    if (address.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.hash) throw new ReplayError('SOURCE_UNAVAILABLE');
    // The destination comes only from local configuration. Never send local login state or follow redirects.
    const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' },
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: requestSignal });
    if (response.status === 412 || response.status === 429) {
      await response.body?.cancel();
      throw new ReplayError('RATE_LIMITED');
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 100_000) {
      await response.body?.cancel();
      throw new ReplayError('SOURCE_UNAVAILABLE');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 100_000) { await reader.cancel(); throw new ReplayError('SOURCE_UNAVAILABLE'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const snapshot = parseSnapshot(raw, config, now);
    const status = snapshotStatusSchema.required({ stale: true }).safeParse(raw);
    if (!snapshot || !status.success) throw new ReplayError('SOURCE_UNAVAILABLE');
    return { ...snapshot, stale: status.data.stale, ...(status.data.warning ? { warning: status.data.warning } : {}),
      ...(status.data.bundled ? { bundled: true } : {}) };
  } catch (error) {
    if (!signal.aborted && requestSignal.aborted) throw new ReplayError('TIMEOUT');
    throw sourceFailure(error, signal);
  }
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

/** One bounded directory request on first use or explicit refresh; no timer or background collection. */
export class MatchCatalog {
  private snapshot?: Snapshot;
  private loaded?: Promise<void>;
  private pending?: Promise<CatalogResult>;
  private lastAttempt = 0;
  private bundled = false;
  private sourceStale = false;
  private lastWarning?: CatalogWarning;
  private remoteStarted = false;
  private initialRemote?: Promise<CatalogResult>;
  constructor(private options: { source?: PublicSource; now?: () => number; cacheFile?: string | null; seedFile?: string | null; config?: SourceConfig; catalogUrl?: string | null } = {}) {}
  private get config() { return this.options.config ?? sourceConfig; }
  private get source() { return this.options.source ?? createPublicSource(this.config); }
  private get now() { return this.options.now?.() ?? Date.now(); }
  private get cacheFile() { return this.options.cacheFile === null ? null : this.options.cacheFile ?? resolve(localDir, 'catalog.json'); }
  private get seedFile() { return this.options.seedFile === null ? null : this.options.seedFile ?? resolve(root, 'config/catalog.seed.json'); }
  private get catalogUrl() { return this.options.catalogUrl?.trim() || null; }
  private async readSnapshot(file: string | null): Promise<PublicSnapshot | undefined> {
    if (!file) return;
    try {
      const text = await readFile(file, 'utf8');
      if (Buffer.byteLength(text) > 100_000) return;
      const raw: unknown = JSON.parse(text);
      const snapshot = parseSnapshot(raw, this.config, this.now);
      const status = snapshotStatusSchema.safeParse(raw);
      if (!snapshot || !status.success) return;
      return { ...snapshot, stale: status.data.stale ?? false,
        ...(status.data.warning ? { warning: status.data.warning } : {}), ...(status.data.bundled ? { bundled: true } : {}) };
    } catch { return; }
  }
  private async load() {
    this.loaded ??= (async () => {
      const cached = await this.readSnapshot(this.cacheFile);
      if (cached) {
        this.snapshot = cached;
        this.bundled = Boolean(cached.bundled);
        this.sourceStale = cached.stale;
        this.lastWarning = cached.warning;
        return;
      }
      this.snapshot = await this.readSnapshot(this.seedFile);
      this.bundled = Boolean(this.snapshot);
    })();
    await this.loaded;
  }
  private present(warning: string | undefined = this.lastWarning): CatalogResult {
    const cutoff = recentCutoff(this.now, this.config.lookbackDays) / 1000;
    return { status: 'ready', sourceName: this.config.sourceName, updatedAt: this.snapshot?.updatedAt ?? null,
      stale: this.bundled || this.sourceStale || Boolean(warning) || !this.snapshot || this.now - Date.parse(this.snapshot.updatedAt) > 15 * 60_000,
      matches: (this.snapshot?.matches ?? []).filter(m => m.publishedAt >= cutoff)
        .map(({ id, date, event, home, away }) => ({ id, date, event, home, away })),
      ...(this.bundled ? { bundled: true } : {}),
      ...(warning ? { warning } : {}) };
  }
  async get(signal: AbortSignal): Promise<CatalogResult> {
    await this.load();
    if (signal.aborted) throw new ReplayError('CANCELLED');
    if (this.catalogUrl && !this.remoteStarted) {
      this.remoteStarted = true;
      this.initialRemote = (async () => {
        try { return await (this.pending ?? this.refresh(signal)); }
        finally { this.initialRemote = undefined; }
      })();
    }
    if (this.initialRemote) {
      const result = await this.initialRemote;
      if (signal.aborted) throw new ReplayError('CANCELLED');
      return result;
    }
    return this.snapshot ? this.present() : this.refresh(signal);
  }
  async refresh(signal: AbortSignal): Promise<CatalogResult> {
    await this.load();
    if (signal.aborted) throw new ReplayError('CANCELLED');
    if (this.pending) throw new ReplayError('BUSY');
    if (this.catalogUrl) this.remoteStarted = true;
    if (this.lastAttempt && this.now - this.lastAttempt < 3000) {
      if (this.snapshot) return this.present('RATE_LIMITED');
      throw new ReplayError('RATE_LIMITED');
    }
    this.lastAttempt = this.now;
    this.pending = (async () => {
      try {
        let snapshot: Snapshot;
        let remote: PublicSnapshot | undefined;
        if (this.catalogUrl) {
          remote = await fetchSharedSnapshot(this.catalogUrl, this.config, this.now, signal);
          if (this.snapshot && Date.parse(remote.updatedAt) < Date.parse(this.snapshot.updatedAt)) {
            this.sourceStale = true;
            this.lastWarning = remote.warning ?? 'SOURCE_UNAVAILABLE';
            return this.present();
          }
          snapshot = remote;
        } else {
          const raw = await this.source.videos(signal);
          snapshot = { version: 1, creatorMid: this.config.creatorMid, query: this.config.query,
            updatedAt: new Date(this.now).toISOString(), matches: normalizeSearch(raw, this.now, this.config) };
        }
        if (signal.aborted) throw new ReplayError('CANCELLED');
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
        this.bundled = Boolean(remote?.bundled);
        this.sourceStale = remote?.stale ?? false;
        this.lastWarning = remote?.warning;
        return this.present();
      } catch (e) {
        const failure = sourceFailure(e, signal);
        if (failure.code === 'CANCELLED') throw failure;
        this.lastWarning = catalogWarning(failure.code);
        if (this.snapshot) return this.present();
        throw failure;
      }
    })();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  /** Safe directory-service response; pass the just-completed refresh result to preserve its warning. */
  publicSnapshot(result: CatalogResult = this.present()): PublicSnapshot {
    if (!this.snapshot) throw new ReplayError('SOURCE_UNAVAILABLE');
    const visible = new Set(result.matches.map(match => match.id));
    return { version: 1, creatorMid: this.snapshot.creatorMid, query: this.snapshot.query, updatedAt: this.snapshot.updatedAt,
      matches: this.snapshot.matches.filter(match => visible.has(match.id)).slice(0, 50)
        .map(({ id, date, event, home, away, publishedAt }) => ({ id, date, event, home, away, publishedAt })),
      stale: result.stale, ...(result.bundled ? { bundled: true } : {}),
      ...(result.warning ? { warning: catalogWarning(result.warning) } : {}) };
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
