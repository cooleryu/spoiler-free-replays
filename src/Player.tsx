import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { lockNormalRate, playerShortcut, requestPlayback, SEEK_STEPS, seekTarget, type SeekStep } from './player-controls';
import type { Segment } from './storage';

type Connection = 'loading' | 'ready' | 'error';
interface Props { segment: Segment; onEnded: () => void; completionMessage?: string; onPlaying?: () => void; playbackVersion?: number }

export function decodedQuality(height: number): string | null {
  return Number.isSafeInteger(height) && height > 0 && height <= 16384 ? `${height}p` : null;
}

function PlayerIcon({ name }: { name: 'play' | 'pause' | 'volume' | 'muted' | 'fullscreen' }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
    {name === 'play' && <path d="m8 5 11 7-11 7V5Z" fill="currentColor" />}
    {name === 'pause' && <><path d="M7 5h4v14H7zM15 5h4v14h-4z" fill="currentColor" /></>}
    {(name === 'volume' || name === 'muted') && <path d="M4 9h4l5-4v14l-5-4H4V9Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />}
    {name === 'volume' && <path d="M17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    {name === 'muted' && <path d="m17 9 5 6m0-6-5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    {name === 'fullscreen' && <path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
  </svg>;
}

function SeekIcon({ seconds, forward = false }: { seconds: number; forward?: boolean }) {
  return <svg className="seek-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
    <path d="M5 8a8 8 0 1 1-1 8M5 3v5h5" transform={forward ? 'translate(24 0) scale(-1 1)' : undefined} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <text x="12" y="15.5" textAnchor="middle" fill="currentColor" fontSize="8" fontWeight="600">{seconds}</text>
  </svg>;
}

export default function Player({ segment, onEnded, completionMessage = '', onPlaying, playbackVersion = 0 }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const sourceVersion = useRef(0);
  const authVersion = useRef(playbackVersion);
  const sourceAssigned = useRef(false);
  const sourceUrl = useRef('');
  const automaticRetryUsed = useRef(false);
  const lastPosition = useRef(0);
  const restorePosition = useRef<number | null>(null);
  const desiredPlaying = useRef(true);
  const endedHandled = useRef(false);
  const volumeValue = useRef(1);
  const audibleVolume = useRef(1);
  const mutedValue = useRef(false);
  const segmentValue = useRef(segment);
  segmentValue.current = segment;
  const [connection, setConnection] = useState<Connection>('loading');
  const [playing, setPlaying] = useState(false);
  const [intendsPlay, setIntendsPlay] = useState(true);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlMessage, setControlMessage] = useState('');
  const [quality, setQuality] = useState<string | null>(null);
  const [seekSeconds, setSeekSeconds] = useState<5 | 30 | 60>(5);

  function setIntent(value: boolean) { desiredPlaying.current = value; setIntendsPlay(value); }

  async function connect(selected: Segment, epoch: number, position: number) {
    sourceVersion.current++;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    sourceAssigned.current = false;
    restorePosition.current = position;
    lastPosition.current = position;
    setConnection('loading');
    setControlMessage('');
    setPlaying(false);
    setQuality(null);
    const media = video.current;
    if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
    try {
      const url = await requestPlayback(selected, controller.signal);
      if (controller.signal.aborted || generation.current !== epoch || request.current !== controller) return;
      const current = video.current;
      if (!current) return;
      sourceUrl.current = url;
      sourceAssigned.current = true;
      current.src = url;
      current.load();
    } catch {
      if (controller.signal.aborted || generation.current !== epoch || request.current !== controller) return;
      if (!automaticRetryUsed.current) {
        automaticRetryUsed.current = true;
        request.current = null;
        void connect(selected, epoch, position);
      } else setConnection('error');
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  useEffect(() => {
    const current = video.current;
    const epoch = ++generation.current;
    authVersion.current = playbackVersion;
    automaticRetryUsed.current = false;
    endedHandled.current = false;
    lastPosition.current = 0;
    setIntent(true);
    // Deferring one turn lets StrictMode's discarded mount cancel before any request starts.
    const start = setTimeout(() => void connect(segment, epoch, 0), 0);
    return () => {
      clearTimeout(start);
      generation.current++;
      sourceVersion.current++;
      request.current?.abort();
      request.current = null;
      sourceAssigned.current = false;
      if (current) { current.pause(); current.removeAttribute('src'); current.load(); }
    };
  }, [segment.bvid, segment.cid, segment.page]);

  useEffect(() => {
    if (authVersion.current === playbackVersion) return;
    authVersion.current = playbackVersion;
    const position = restorePosition.current ?? (currentSource() ? video.current?.currentTime : undefined) ?? lastPosition.current;
    automaticRetryUsed.current = false;
    void connect(segmentValue.current, generation.current, Number.isFinite(position) ? position : 0);
  }, [playbackVersion]);

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === container.current);
    const onPageHide = () => {
      generation.current++;
      sourceVersion.current++;
      request.current?.abort();
      request.current = null;
      sourceAssigned.current = false;
      setIntent(false);
      video.current?.pause();
      video.current?.removeAttribute('src');
      video.current?.load();
      setConnection('error');
    };
    document.addEventListener('fullscreenchange', updateFullscreen);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('fullscreenchange', updateFullscreen);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  function currentSource() {
    return sourceAssigned.current && video.current?.currentSrc === sourceUrl.current;
  }

  function mediaFailed() {
    if (!currentSource()) return;
    const position = restorePosition.current ?? video.current?.currentTime ?? lastPosition.current;
    lastPosition.current = Number.isFinite(position) ? position : 0;
    sourceAssigned.current = false;
    video.current?.pause();
    setPlaying(false);
    if (!automaticRetryUsed.current) {
      automaticRetryUsed.current = true;
      void connect(segmentValue.current, generation.current, lastPosition.current);
    } else setConnection('error');
  }

  function metadataReady() {
    const current = video.current;
    if (!current || !currentSource()) return;
    setQuality(decodedQuality(current.videoHeight));
    lockNormalRate(current);
    current.volume = volumeValue.current;
    current.muted = mutedValue.current;
    if (restorePosition.current !== null) {
      const position = restorePosition.current;
      try {
        current.currentTime = Number.isFinite(current.duration) && current.duration > 0
          ? Math.min(position, Math.max(0, current.duration - 0.05)) : position;
        lastPosition.current = current.currentTime;
        restorePosition.current = null;
      } catch { /* Retry the restoration when the media can play. */ }
    }
  }

  async function play() {
    const current = video.current;
    if (!current || !sourceAssigned.current) return;
    const epoch = generation.current;
    const version = sourceVersion.current;
    try { lockNormalRate(current); await current.play(); }
    catch (error) {
      if (generation.current === epoch && sourceVersion.current === version && !current.error && currentSource() && error instanceof DOMException && error.name === 'NotAllowedError') {
        setIntent(false);
        setPlaying(false);
      }
    }
  }

  function canPlay() {
    if (!currentSource()) return;
    metadataReady();
    setConnection('ready');
    if (desiredPlaying.current) void play();
  }

  function togglePlayback() {
    setControlMessage('');
    if (connection === 'error') return;
    const current = video.current;
    if (connection === 'loading') { setIntent(!desiredPlaying.current); return; }
    if (!current) return;
    if (current.paused) {
      endedHandled.current = false;
      setIntent(true);
      void play();
    } else { setIntent(false); current.pause(); }
  }

  function jump(step: SeekStep) {
    const current = video.current;
    if (!current || connection !== 'ready') return;
    endedHandled.current = false;
    try { current.currentTime = seekTarget(current.currentTime, step, current.duration); }
    catch { /* Media may become temporarily unseekable during a network interruption. */ }
  }

  function toggleMute() {
    const value = !(mutedValue.current || volumeValue.current === 0);
    if (!value && volumeValue.current === 0) {
      volumeValue.current = audibleVolume.current;
      setVolume(audibleVolume.current);
      if (video.current) video.current.volume = audibleVolume.current;
    }
    mutedValue.current = value;
    setMuted(value);
    if (video.current) video.current.muted = value;
  }

  function changeVolume(value: number) {
    if (value > 0) audibleVolume.current = value;
    volumeValue.current = value;
    mutedValue.current = value === 0;
    setVolume(value);
    setMuted(value === 0);
    if (video.current) { video.current.volume = value; video.current.muted = value === 0; }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === container.current) await document.exitFullscreen();
      else if (container.current?.requestFullscreen) await container.current.requestFullscreen();
      else setControlMessage('当前浏览器暂不支持全屏。');
    } catch { setControlMessage('暂时无法进入全屏，请重试。'); }
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const editingControl = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable;
    const action = playerShortcut(event.key, editingControl, event.altKey || event.ctrlKey || event.metaKey);
    if (!action) return;
    event.preventDefault();
    if (event.repeat && action !== 'back' && action !== 'forward') return;
    if (action === 'play') togglePlayback();
    else if (action === 'back') jump(-5);
    else if (action === 'forward') jump(5);
    else if (action === 'mute') toggleMute();
    else void toggleFullscreen();
  }

  function finished() {
    if (!video.current?.ended || endedHandled.current || !currentSource()) return;
    endedHandled.current = true;
    setIntent(false);
    setPlaying(false);
    onEnded();
  }

  const showPause = connection === 'loading' ? intendsPlay : playing;
  return (
    <div className="match-player" ref={container} tabIndex={0} onKeyDown={keyboard} aria-label="比赛播放器">
      <div className="media-stage">
        <video ref={video} className="match-video" controls={false} playsInline disablePictureInPicture disableRemotePlayback controlsList="nodownload noplaybackrate noremoteplayback" preload="auto" tabIndex={-1} aria-label="比赛画面，单击播放或暂停"
          onClick={() => { togglePlayback(); container.current?.focus({ preventScroll: true }); }}
          onContextMenu={event => event.preventDefault()}
          onLoadedMetadata={metadataReady} onCanPlay={canPlay} onError={mediaFailed}
          onResize={event => { if (currentSource()) setQuality(decodedQuality(event.currentTarget.videoHeight)); }}
          onRateChange={event => lockNormalRate(event.currentTarget)}
          onPlay={event => { if (currentSource() && !event.currentTarget.paused) { setPlaying(true); onPlaying?.(); } }} onPause={event => { if (event.currentTarget.paused) setPlaying(false); }}
          onTimeUpdate={event => { if (sourceAssigned.current && restorePosition.current === null && Number.isFinite(event.currentTarget.currentTime)) lastPosition.current = event.currentTarget.currentTime; }}
          onVolumeChange={event => { const current = event.currentTarget; volumeValue.current = current.volume; if (current.volume > 0) audibleVolume.current = current.volume; mutedValue.current = current.muted; setVolume(current.volume); setMuted(current.muted); }}
          onEnded={finished}
        />
        {connection === 'loading' && <div className="player-notice" role="status"><span className="loading-ring small" aria-hidden="true"><span /></span><span>正在连接回放</span></div>}
        {connection === 'error' && <div className="player-notice" role="alert"><p>暂时未能连接回放</p><button className="secondary-button" type="button" onClick={() => void connect(segmentValue.current, generation.current, lastPosition.current)}>重新连接</button></div>}
      </div>
      <div className="player-footer"><div className="player-bottom-controls">
        <div className="player-transport">
          <button className="player-icon-button jump-button jump-back" type="button" disabled={connection !== 'ready'} onClick={() => jump(-seekSeconds as SeekStep)} aria-label={`后退 ${seekSeconds} 秒`}><SeekIcon seconds={seekSeconds} /></button>
          <button className="player-icon-button player-primary-button play-toggle" type="button" disabled={connection === 'error'} onClick={togglePlayback} aria-label={showPause ? '暂停' : '播放'}><PlayerIcon name={showPause ? 'pause' : 'play'} /><span>{showPause ? '暂停' : '播放'}</span></button>
          <button className="player-icon-button jump-button jump-forward" type="button" disabled={connection !== 'ready'} onClick={() => jump(seekSeconds)} aria-label={`前进 ${seekSeconds} 秒`}><SeekIcon seconds={seekSeconds} forward /></button>
        </div>
        <div className="player-step-control"><label htmlFor="player-seek-step">每次</label><select id="player-seek-step" aria-label="跳转幅度" value={seekSeconds} onChange={event => { const value = Number(event.target.value); if (value === 5 || value === 30 || value === 60) setSeekSeconds(value); }}>{SEEK_STEPS.filter(step => step > 0).map(step => <option key={step} value={step}>{step}秒</option>)}</select></div>
        <div className="volume-control"><button className="player-icon-button" type="button" onClick={toggleMute} aria-label={muted || volume === 0 ? '取消静音' : '静音'} aria-pressed={muted}><PlayerIcon name={muted || volume === 0 ? 'muted' : 'volume'} /></button><label htmlFor="player-volume">音量</label><input id="player-volume" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={event => changeVolume(Number(event.target.value))} aria-label="音量" /></div>
        <div className="player-display-controls">{quality && <span className="player-quality" aria-label={`实际画质 ${quality}`}>{quality}</span>}<button className="player-icon-button fullscreen-toggle" type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? '退出全屏' : '全屏'}><PlayerIcon name="fullscreen" /><span>{fullscreen ? '退出全屏' : '全屏'}</span></button></div>
      </div>
      {controlMessage && <p className="player-control-message" role="status">{controlMessage}</p>}
      {completionMessage && <p className="player-completion-message" role="status">{completionMessage}</p>}
      </div>
    </div>
  );
}
