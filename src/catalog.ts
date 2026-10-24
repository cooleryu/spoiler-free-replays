import type { Segment } from './storage';

export type CatalogSource = 'official' | 'deyunse';

export interface Match {
  id: string;
  date: string;
  event: string;
  home: string;
  away: string;
}

export interface Catalog {
  sourceName: string;
  updatedAt: string | null;
  stale: boolean;
  matches: Match[];
  warning?: string;
  bundled?: boolean;
}

export function activeMatchForSegment(matches: Match[], segment?: Segment): Match | undefined {
  if (!segment) return;
  return matches.find(match => match.id === segment.bvid || match.id === `deyunse:${segment.bvid}:${segment.cid}`);
}

export async function requestCatalog(source: CatalogSource, refresh: boolean, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const address = `${refresh ? '/api/matches/refresh' : '/api/matches'}${source === 'deyunse' ? '?source=deyunse' : ''}`;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await fetcher(address, {
      ...(refresh ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}), signal,
    });
    const result: unknown = await response.json();
    signal.throwIfAborted();
    // A cancelled request can take a moment to release the local server's request slot.
    if (attempt < 3 && response.status === 409 && result && typeof result === 'object'
      && (result as Record<string, unknown>).code === 'BUSY') {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 250);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
      continue;
    }
    return { ok: response.ok, result };
  }
}

function shortText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

function isMatch(value: unknown): value is Match {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return shortText(item.id, 200) && shortText(item.event, 100) &&
    shortText(item.home, 80) && shortText(item.away, 80) &&
    typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
    Number.isFinite(Date.parse(`${item.date}T00:00:00Z`)) &&
    new Date(`${item.date}T00:00:00Z`).toISOString().slice(0, 10) === item.date;
}

// Copy only the fields this screen needs; never retain raw video metadata.
export function readCatalog(value: unknown): Catalog | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (data.status !== 'ready' || typeof data.stale !== 'boolean' ||
    !(data.updatedAt === null || (typeof data.updatedAt === 'string' && Number.isFinite(Date.parse(data.updatedAt)))) ||
    !Array.isArray(data.matches) || data.matches.length > 200 || !data.matches.every(isMatch) ||
    new Set(data.matches.map(({ id }) => id)).size !== data.matches.length) return null;
  return {
    sourceName: shortText(data.sourceName, 100) ? data.sourceName.trim() : '指定赛事账号',
    updatedAt: data.updatedAt,
    stale: data.stale,
    matches: data.matches.map(({ id, date, event, home, away }) => ({ id, date, event, home, away })),
    ...(typeof data.warning === 'string' ? { warning: data.warning } : {}),
    ...(data.bundled === true ? { bundled: true } : {}),
  };
}

export function matchDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

export function updateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}
