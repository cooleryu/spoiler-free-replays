export interface QrSession { sessionId: string; qrImage: string; expiresAt: number }
export type QrStatus = 'waiting' | 'scanned' | 'ready' | 'expired';

export function readQrSession(value: unknown): QrSession | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (typeof data.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.sessionId) ||
    typeof data.qrImage !== 'string' || data.qrImage.length > 1_000_000 ||
    !/^data:image\/(?:png|gif|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(data.qrImage) ||
    !Number.isSafeInteger(data.expiresAt) || (data.expiresAt as number) <= 0) return null;
  return { sessionId: data.sessionId, qrImage: data.qrImage, expiresAt: data.expiresAt as number };
}

export function readQrStatus(value: unknown): QrStatus | null {
  if (!value || typeof value !== 'object') return null;
  const status = (value as Record<string, unknown>).status;
  return status === 'waiting' || status === 'scanned' || status === 'ready' || status === 'expired' ? status : null;
}

export function sessionDeadline(expiresAt: number, openedAt: number): number {
  return Math.min(expiresAt, openedAt + 180_000);
}

export async function authPost(action: 'start' | 'poll' | 'cancel' | 'logout', body: Record<string, string>, signal?: AbortSignal, keepalive = false): Promise<unknown> {
  const response = await fetch(`/api/auth/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, keepalive,
  });
  const result: unknown = await response.json();
  if (!response.ok || (result && typeof result === 'object' && (result as Record<string, unknown>).status === 'error')) throw new Error('AUTH_UNAVAILABLE');
  return result;
}
