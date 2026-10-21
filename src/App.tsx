import { useEffect, useRef, useState } from 'react';
import { cleanSegments, restoreReplay, saveReplay, validSegments, type Segment } from './storage';
import { matchDate, readCatalog, updateTime, type Catalog, type Match } from './catalog';
import Player from './Player';
import Auth from './Auth';

type Phase = 'idle' | 'preparing' | 'ready' | 'playing';
interface ReplayState {
  phase: Phase;
  segments: Segment[];
  currentIndex: number;
}

const EMPTY_REPLAY: ReplayState = { phase: 'idle', segments: [], currentIndex: 0 };
const EMPTY_CATALOG: Catalog = { sourceName: '指定赛事账号', matches: [], updatedAt: null, stale: false };
const ERRORS: Record<string, string> = {
  SOURCE_UNAVAILABLE: '暂时无法获取比赛列表，请稍后刷新。',
  RATE_LIMITED: 'B 站暂时限制了公开检索，请稍后再刷新。',
  MATCH_UNAVAILABLE: '这场比赛暂时无法播放，请选择其他比赛，或稍后重试。',
  NETWORK: '网络连接失败，请稍后重试。',
  TIMEOUT: '这次等待有些久，请稍后重试。',
  CANCELLED: '准备已取消，可以重新选择。',
  BUSY: '已有比赛正在准备，请稍后重试。',
  INTERNAL: '这次没有准备成功，请稍后重试。',
};

function errorMessage(code: unknown, fallback = 'INTERNAL'): string {
  return typeof code === 'string' && Object.hasOwn(ERRORS, code) ? ERRORS[code] : ERRORS[fallback];
}

function Icon({ name, className = '' }: { name: 'play' | 'arrow' | 'check' | 'refresh'; className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {name === 'play' && <path d="m9 5 11 7-11 7V5Z" fill="currentColor" />}
      {name === 'arrow' && <path d="M4 12h15m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
      {name === 'check' && <path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
      {name === 'refresh' && <><path d="M19 8a8 8 0 1 0 1 7M19 3v5h-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>}
    </svg>
  );
}

export function MatchList({ matches, onSelect, disabled = false }: { matches: Match[]; onSelect: (match: Match) => void; disabled?: boolean }) {
  return (
    <ul className="match-list" aria-label="近期比赛">
      {matches.map((match) => (
        <li key={match.id}>
          <button className="match-row" type="button" disabled={disabled} onClick={() => onSelect(match)} aria-label={`${matchDate(match.date)} ${match.event} ${match.home} 对阵 ${match.away}，观看比赛`}>
            <span className="match-meta"><time dateTime={match.date}>{matchDate(match.date)}</time><span className="match-event">{match.event}</span></span>
            <span className="match-teams"><span className="team-name home-team">{match.home}</span><span className="versus">VS</span><span className="team-name away-team">{match.away}</span></span>
            <span className="row-play"><span>观看</span><Icon name="arrow" /></span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  const [replay, setReplay] = useState<ReplayState>(() => {
    const saved = restoreReplay();
    return saved ? { ...saved, phase: 'ready' } : EMPTY_REPLAY;
  });
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [watchError, setWatchError] = useState('');
  const [playbackMessage, setPlaybackMessage] = useState('');
  const [playbackVersion, setPlaybackVersion] = useState(0);
  const catalogRequest = useRef<AbortController | null>(null);
  const watchRequest = useRef<AbortController | null>(null);
  const { phase, segments, currentIndex } = replay;

  useEffect(() => { saveReplay(segments, currentIndex); }, [segments, currentIndex]);

  useEffect(() => {
    // Let StrictMode discard its first mount before starting a catalog request.
    const start = setTimeout(() => void loadCatalog(false), 0);
    const stop = () => {
      clearTimeout(start);
      catalogRequest.current?.abort();
      watchRequest.current?.abort();
      catalogRequest.current = null;
      watchRequest.current = null;
    };
    const onPageHide = () => {
      const wasPreparing = Boolean(watchRequest.current);
      stop();
      setCatalogLoading(false);
      if (wasPreparing) setReplay(EMPTY_REPLAY);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      stop();
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  async function loadCatalog(refresh: boolean) {
    if (catalogRequest.current) return;
    const controller = new AbortController();
    catalogRequest.current = controller;
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const response = await fetch(refresh ? '/api/matches/refresh' : '/api/matches', {
        ...(refresh ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
        signal: controller.signal,
      });
      const result: unknown = await response.json();
      if (controller.signal.aborted || catalogRequest.current !== controller) return;
      const next = response.ok ? readCatalog(result) : null;
      if (next) {
        setCatalog(next);
        setCatalogError(next.warning ? errorMessage(next.warning, 'SOURCE_UNAVAILABLE') : '');
      } else {
        const code = result && typeof result === 'object' ? (result as Record<string, unknown>).code : undefined;
        setCatalogError(errorMessage(code, 'SOURCE_UNAVAILABLE'));
      }
    } catch {
      if (controller.signal.aborted || catalogRequest.current !== controller) return;
      setCatalogError(ERRORS.NETWORK);
    } finally {
      if (catalogRequest.current === controller) {
        catalogRequest.current = null;
        setCatalogLoading(false);
      }
    }
  }

  async function watch(match: Match) {
    if (watchRequest.current) return;
    const controller = new AbortController();
    watchRequest.current = controller;
    setWatchError('');
    setPlaybackMessage('');
    setReplay({ ...EMPTY_REPLAY, phase: 'preparing' });
    try {
      const response = await fetch('/api/watch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: match.id }), signal: controller.signal,
      });
      const result: unknown = await response.json();
      if (controller.signal.aborted || watchRequest.current !== controller) return;
      const data = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      if (response.ok && data.status === 'ready' && validSegments(data.segments)) {
        setReplay({ phase: 'playing', segments: cleanSegments(data.segments), currentIndex: 0 });
      } else {
        setWatchError(errorMessage(data.code, 'MATCH_UNAVAILABLE'));
        setReplay(EMPTY_REPLAY);
      }
    } catch {
      if (controller.signal.aborted || watchRequest.current !== controller) return;
      setWatchError(ERRORS.NETWORK);
      setReplay(EMPTY_REPLAY);
    } finally {
      if (watchRequest.current === controller) watchRequest.current = null;
    }
  }

  function returnToList() {
    watchRequest.current?.abort();
    watchRequest.current = null;
    setReplay(EMPTY_REPLAY);
    setWatchError('');
    setPlaybackMessage('');
  }

  function segmentEnded() {
    if (currentIndex + 1 >= segments.length) {
      setPlaybackMessage('当前清单已播完');
      return;
    }
    setPlaybackMessage('');
    setReplay((value) => ({ ...value, currentIndex: value.currentIndex + 1 }));
  }

  const listError = watchError || catalogError;
  const activeMatch = catalog.matches.find(match => match.id === segments[currentIndex]?.bvid);
  return (
    <div className={`app-shell ${phase === 'playing' ? 'watching' : ''}`}>
      <header className="site-header">
        <div className="site-identity"><a className="wordmark" href="/" aria-label="无剧透回放首页"><Icon name="play" /><span>无剧透回放</span></a><span className="header-note">开源免费</span></div>
        <Auth onSessionChange={() => setPlaybackVersion(value => value + 1)} />
      </header>
      <main>
        {phase === 'playing' && <div className="viewer-heading">
          <div><p className="eyebrow">比赛回放</p><h1 className="match-heading">{activeMatch ? <>{activeMatch.home}<span className="heading-versus">vs</span>{activeMatch.away}</> : '正在观看'}</h1></div>
          {activeMatch && <p className="match-context">{activeMatch.event}<span>{matchDate(activeMatch.date)}</span></p>}
        </div>}
        <section className={`viewer ${phase === 'playing' ? 'is-playing' : ''} ${phase === 'idle' ? 'is-catalog' : ''}`} aria-label="比赛观看区域" aria-busy={phase === 'preparing'}>
          {phase === 'idle' && (
            <div className="catalog-content">
              <div className="catalog-heading"><div><p className="eyebrow">近期比赛</p><h1>比赛回放</h1></div><p className="viewer-description">选一场，从第一局开始。</p></div>
              <div className="catalog-toolbar">
                <div className="catalog-status"><span className="source-label">{catalog.sourceName}</span><span className="update-label" role="status">{catalog.updatedAt ? `${catalog.bundled ? '内置名单 · 核验于' : '更新于'} ${updateTime(catalog.updatedAt)}` : catalogLoading ? '正在获取近期比赛…' : '尚未获取比赛列表'}</span></div>
                <button className="refresh-button" type="button" disabled={catalogLoading} onClick={() => void loadCatalog(true)}><Icon name="refresh" className={catalogLoading ? 'is-spinning' : ''} />{catalogLoading ? '更新中' : '刷新'}</button>
              </div>
              {listError && <p className="error-message" role="alert">{listError}{catalog.matches.length > 0 && !watchError ? ' 已保留现有列表。' : ''}</p>}
              {catalog.stale && !catalogError && <p className="stale-message">{catalog.bundled ? '这是随版本附带的已核验比赛，并非完整赛程。点击刷新可尝试获取近期回放。' : '当前显示上次保存的列表，可点击刷新获取更新。'}</p>}
              {catalog.matches.length > 0 ? <MatchList matches={catalog.matches} disabled={catalogLoading} onSelect={(match) => void watch(match)} /> : (
                <div className="catalog-empty" role="status"><span className={catalogLoading ? 'loading-ring small' : 'empty-mark'} aria-hidden="true">{catalogLoading ? <span /> : '—'}</span><p>{catalogLoading ? '正在整理近期比赛' : catalogError ? '比赛列表暂时没有取到' : '暂未检索到近期比赛回放'}</p><span>{catalogLoading ? '稍等片刻，比赛会出现在这里。' : '稍后点击刷新，看看有没有新比赛。'}</span></div>
              )}
              <div className="catalog-bottom-note"><span>不显示比分、总局数与视频时长</span><span>公开检索可能有收录延迟</span></div>
            </div>
          )}
          {phase === 'preparing' && (
            <div className="viewer-content state-content"><div className="loading-ring" aria-hidden="true"><span /></div><h1 role="status">正在准备比赛</h1><p className="viewer-description">正在连接视频，请稍等。</p><button className="secondary-button" type="button" onClick={returnToList}>取消</button></div>
          )}
          {phase === 'ready' && (
            <div className="viewer-content state-content"><div className="ready-mark" aria-hidden="true"><Icon name="play" /></div><h1 role="status">已准备好</h1><p className="viewer-description">已保留你上次观看的比赛片段。</p><button className="primary-button start-button" type="button" disabled={catalogLoading} onClick={() => setReplay((value) => ({ ...value, phase: 'playing' }))}><Icon name="play" />开始观看</button><button className="text-button ready-reset" type="button" onClick={returnToList}>返回比赛列表</button></div>
          )}
          {phase === 'playing' && <Player segment={segments[currentIndex]} playbackVersion={playbackVersion} onEnded={segmentEnded} completionMessage={playbackMessage} onPlaying={() => setPlaybackMessage('')} />}
        </section>
        {phase === 'playing' ? (
          <div className="playback-area"><button className="text-button outside-button" type="button" onClick={returnToList}><span className="back-arrow"><Icon name="arrow" /></span>返回比赛列表</button><span className="keyboard-hint"><kbd>←</kbd><kbd>→</kbd> 微调 5 秒<span className="hint-separator" />空格键播放 / 暂停</span></div>
        ) : null}
      </main>
      {phase !== 'playing' && <footer className="site-footer"><span>无剧透回放 · 开源免费</span><span>视频来自哔哩哔哩</span></footer>}
    </div>
  );
}
