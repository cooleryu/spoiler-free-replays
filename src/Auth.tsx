import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { authPost, readQrSession, readQrStatus, sessionDeadline, type QrSession } from './auth-client';

type Phase = 'starting' | 'waiting' | 'scanned' | 'expired' | 'error';
interface DialogProps {
  phase: Phase; session: QrSession | null; onClose: () => void; onRetry: () => void;
  dialogRef?: RefObject<HTMLDivElement | null>;
}

export function AuthDialog({ phase, session, onClose, onRetry, dialogRef }: DialogProps) {
  return <div className="auth-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title" aria-describedby="auth-description auth-privacy" tabIndex={-1} ref={dialogRef}>
      <button className="auth-close" type="button" aria-label="关闭登录" onClick={onClose}>×</button>
      <span className="auth-eyebrow">可选登录</span><h2 id="auth-title">登录提升画质</h2>
      <p id="auth-description">手机哔哩哔哩扫码</p>
      <div className="auth-qr-area">
        {session && (phase === 'waiting' || phase === 'scanned') ? <img className="auth-qr" src={session.qrImage} alt="哔哩哔哩登录二维码" width="200" height="200" /> : <div className="auth-qr-placeholder" aria-hidden="true">{phase === 'starting' ? <span className="loading-ring"><span /></span> : <span className="auth-qr-expired">—</span>}</div>}
      </div>
      <p className={`auth-state ${phase === 'error' ? 'is-error' : ''}`} role="status">{phase === 'starting' ? '正在获取二维码' : phase === 'waiting' ? '等待扫码' : phase === 'scanned' ? '已扫码，请在手机确认' : phase === 'expired' ? '二维码已失效，请重新获取。' : '暂时无法连接登录服务，请重试。'}</p>
      {(phase === 'expired' || phase === 'error') && <button className="auth-retry" type="button" onClick={onRetry}>重新获取二维码</button>}
      <p className="auth-quality-note">登录后优先请求1080p，实际以可用片源为准。</p>
      <p id="auth-privacy" className="auth-privacy">登录仅保留在本次服务运行期间</p>
    </div>
  </div>;
}

interface AuthProps {
  onSessionChange: (loggedIn: boolean) => void;
  onStatus?: (loggedIn: boolean) => void;
  loginRequest?: number;
}

export default function Auth({ onSessionChange, onStatus, loginRequest = 0 }: AuthProps) {
  const [loggedIn, setLoggedIn] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('starting');
  const [session, setSession] = useState<QrSession | null>(null);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const logoutRequest = useRef<AbortController | null>(null);
  const sessionId = useRef<string | null>(null);
  const epoch = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeCallback = useRef(onSessionChange);
  changeCallback.current = onSessionChange;
  const statusCallback = useRef(onStatus);
  statusCallback.current = onStatus;
  const handledLoginRequest = useRef(loginRequest);

  function cancelRemote(id: string) { void authPost('cancel', { sessionId: id }, undefined, true).catch(() => {}); }
  function stop(cancelSession = true) {
    epoch.current++;
    request.current?.abort(); request.current = null;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    if (expiryTimer.current) clearTimeout(expiryTimer.current);
    pollTimer.current = null; expiryTimer.current = null;
    const id = sessionId.current; sessionId.current = null;
    if (cancelSession && id) cancelRemote(id);
  }
  function close() { stop(); setSession(null); setOpen(false); }

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/auth/status', { signal: controller.signal });
        const data: unknown = await response.json();
        if (!controller.signal.aborted && response.ok && data && typeof data === 'object' && typeof (data as Record<string, unknown>).loggedIn === 'boolean') {
          const currentStatus = (data as { loggedIn: boolean }).loggedIn;
          setLoggedIn(currentStatus);
          statusCallback.current?.(currentStatus);
        }
      } catch { /* Login remains optional when status is temporarily unavailable. */ }
      finally { if (!controller.signal.aborted) setStatusLoading(false); }
    })();
    const leave = () => { stop(); logoutRequest.current?.abort(); setSession(null); setOpen(false); };
    window.addEventListener('pagehide', leave);
    return () => { controller.abort(); stop(); logoutRequest.current?.abort(); window.removeEventListener('pagehide', leave); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
      if (!controls?.length) { event.preventDefault(); dialog.current?.focus(); return; }
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    const containFocus = (event: FocusEvent) => { if (event.target instanceof Node && !dialog.current?.contains(event.target)) dialog.current?.focus(); };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', containFocus);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [open]);

  async function start() {
    stop();
    setOpen(true); setPhase('starting'); setSession(null); setError('');
    const currentEpoch = epoch.current;
    const controller = new AbortController(); request.current = controller;
    const openedAt = Date.now();
    const isCurrent = () => !controller.signal.aborted && epoch.current === currentEpoch;
    const expire = () => { if (!isCurrent()) return; stop(); setSession(null); setPhase('expired'); };
    expiryTimer.current = setTimeout(expire, 180_000);
    try {
      const result = readQrSession(await authPost('start', {}, controller.signal));
      if (!result) throw new Error('INVALID_SESSION');
      if (!isCurrent()) { cancelRemote(result.sessionId); return; }
      sessionId.current = result.sessionId;
      const deadline = sessionDeadline(result.expiresAt, openedAt);
      if (deadline <= Date.now()) { expire(); return; }
      setSession(result); setPhase('waiting');
      if (expiryTimer.current) clearTimeout(expiryTimer.current);
      expiryTimer.current = setTimeout(expire, deadline - Date.now());
      const schedule = () => {
        if (!isCurrent()) return;
        if (Date.now() >= deadline) { expire(); return; }
        pollTimer.current = setTimeout(() => void poll(), Math.min(3000, deadline - Date.now()));
      };
      const poll = async () => {
        if (!isCurrent()) return;
        if (Date.now() >= deadline) { expire(); return; }
        try {
          const status = readQrStatus(await authPost('poll', { sessionId: result.sessionId }, controller.signal));
          if (!isCurrent()) return;
          if (status === 'ready') {
            stop(false); setLoggedIn(true); setSession(null); setOpen(false); changeCallback.current(true);
          } else if (status === 'expired') expire();
          else if (status === 'waiting' || status === 'scanned') { setPhase(status); schedule(); }
          else throw new Error('INVALID_STATUS');
        } catch {
          if (!isCurrent()) return;
          stop(); setSession(null); setPhase('error');
        }
      };
      schedule();
    } catch {
      if (!isCurrent()) return;
      stop(); setSession(null); setPhase('error');
    }
  }

  async function logout() {
    if (logoutRequest.current) return;
    const controller = new AbortController(); logoutRequest.current = controller;
    setLogoutLoading(true); setError('');
    try {
      const result = await authPost('logout', {}, controller.signal);
      if (controller.signal.aborted) return;
      if (!result || typeof result !== 'object' || (result as Record<string, unknown>).status !== 'ok') throw new Error('INVALID_STATUS');
      setLoggedIn(false); changeCallback.current(false);
    } catch { if (!controller.signal.aborted) setError('暂时未能退出，请重试。'); }
    finally { if (logoutRequest.current === controller) { logoutRequest.current = null; setLogoutLoading(false); } }
  }

  useEffect(() => {
    if (loginRequest <= handledLoginRequest.current || statusLoading || logoutLoading) return;
    handledLoginRequest.current = loginRequest;
    // Only a new external request opens login; preserve an already-open QR session.
    if (!loggedIn && !open) void start();
  }, [loginRequest, statusLoading, logoutLoading, loggedIn, open]);

  return <div className="auth-entry">
    {loggedIn ? <><span className="auth-logged-in">已登录</span><button className="auth-header-button" type="button" disabled={logoutLoading} onClick={() => void logout()}>{logoutLoading ? '退出中' : '退出登录'}</button></> : <button className="auth-header-button" type="button" disabled={statusLoading} onClick={() => void start()} aria-haspopup="dialog">登录提升画质</button>}
    {error && <span className="auth-header-error" role="alert">{error}</span>}
    {open && createPortal(<AuthDialog phase={phase} session={session} onClose={close} onRetry={() => void start()} dialogRef={dialog} />, document.body)}
  </div>;
}
