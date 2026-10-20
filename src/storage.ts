export interface Segment {
  bvid: string;
  cid: number;
  page: number;
}

export interface SavedReplay {
  segments: Segment[];
  currentIndex: number;
}

export const STORAGE_KEY = 'next-match.replay.v1';

export function isSegment(value: unknown): value is Segment {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.bvid === 'string' &&
    /^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(candidate.bvid) &&
    Number.isSafeInteger(candidate.cid) &&
    (candidate.cid as number) > 0 &&
    Number.isSafeInteger(candidate.page) &&
    (candidate.page as number) > 0 && (candidate.page as number) <= 1000
  );
}

export function validSegments(value: unknown): value is Segment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) return false;
  if (!value.every(isSegment)) return false;
  return new Set(value.map(({ bvid, cid }) => `${bvid}:${cid}`)).size === value.length;
}

// Keep only playback identifiers. Never preserve server payloads or search text.
export function cleanSegments(segments: Segment[]): Segment[] {
  return segments.map(({ bvid, cid, page }) => ({ bvid, cid, page }));
}

export function restoreReplay(): SavedReplay | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return null;
    const { segments, currentIndex } = saved as Record<string, unknown>;
    if (
      !validSegments(segments) ||
      !Number.isSafeInteger(currentIndex) ||
      (currentIndex as number) < 0 ||
      (currentIndex as number) >= segments.length
    ) return null;
    return { segments: cleanSegments(segments), currentIndex: currentIndex as number };
  } catch {
    return null;
  }
}

export function saveReplay(segments: Segment[], currentIndex: number): void {
  try {
    if (!segments.length) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ segments: cleanSegments(segments), currentIndex }));
  } catch {
    // The current session remains usable when browser storage is unavailable.
  }
}

export function playerUrl(segment: Segment): string {
  const parameters = new URLSearchParams({
    bvid: segment.bvid,
    cid: String(segment.cid),
    autoplay: '1',
    danmaku: '0',
    poster: '0',
  });
  return `https://player.bilibili.com/player.html?${parameters}`;
}
