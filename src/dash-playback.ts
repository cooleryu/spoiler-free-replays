export interface DashPlayback {
  destroy: () => void;
}

function selectedManifest(manifest: string): boolean {
  if (!manifest || manifest.length > 100_000 || /<!DOCTYPE|<!ENTITY/i.test(manifest)) return false;
  const document = new DOMParser().parseFromString(manifest, 'application/xml');
  const mpd = document.documentElement;
  if (document.getElementsByTagName('parsererror').length || mpd.localName !== 'MPD' || mpd.getAttribute('type') !== 'static') return false;
  const periods = document.getElementsByTagNameNS('*', 'Period');
  const adaptations = document.getElementsByTagNameNS('*', 'AdaptationSet');
  if (periods.length !== 1 || adaptations.length !== 2) return false;
  const types = new Set<string>();
  for (const adaptation of adaptations) {
    const representations = adaptation.getElementsByTagNameNS('*', 'Representation');
    if (representations.length !== 1) return false;
    const type = adaptation.getAttribute('contentType')
      || (adaptation.getAttribute('mimeType') || representations[0].getAttribute('mimeType') || '').split('/')[0];
    if ((type !== 'audio' && type !== 'video') || types.has(type)) return false;
    types.add(type);
  }
  return types.size === 2;
}

/** Attach a server-selected audio/video MPD. Readiness and playback stay with the video element. */
export async function attachDash(video: HTMLVideoElement, manifest: string, onError: () => void, signal?: AbortSignal): Promise<DashPlayback> {
  const checkActive = () => { if (signal?.aborted) throw new DOMException('Playback cancelled', 'AbortError'); };
  try {
    checkActive();
    if (!selectedManifest(manifest)) throw new Error('DASH_UNAVAILABLE');
    // Keep the browser-only library out of server rendering and load it only for DASH sources.
    const dashjs = await import('dashjs');
    // Another source may have replaced this one while the library was loading.
    checkActive();
    const player = dashjs.MediaPlayer().create();
    const source = URL.createObjectURL(new Blob([manifest], { type: 'application/dash+xml' }));
    let destroyed = false;
    let failed = false;

    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      signal?.removeEventListener('abort', destroy);
      try { player.off(dashjs.MediaPlayer.events.ERROR, handleError); } catch { /* Already torn down. */ }
      try { player.destroy(); } catch { /* destroy invokes reset and detaches the media source. */ }
      finally { URL.revokeObjectURL(source); }
    };
    const handleError = (event: unknown) => {
      if (destroyed || failed) return;
      const error = event && typeof event === 'object' ? (event as { error?: unknown }).error : undefined;
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      // These optional subsystems are disabled; neither error makes the selected A/V stream fatal.
      if (code === dashjs.MediaPlayer.errors.TIME_SYNC_FAILED_ERROR_CODE
        || code === dashjs.MediaPlayer.errors.TIMED_TEXT_ERROR_ID_PARSE_CODE) return;
      failed = true;
      // Do not reset the library in the middle of its event dispatch, or expose errors with signed URLs.
      queueMicrotask(() => {
        if (destroyed) return;
        // Let Player capture the current position before the media source is detached.
        try { onError(); } finally { destroy(); }
      });
    };

    try {
      signal?.addEventListener('abort', destroy, { once: true });
      checkActive();
      player.updateSettings({
        debug: { logLevel: dashjs.Debug.LOG_LEVEL_NONE, dispatchEvent: false },
        errors: { recoverAttempts: { mediaErrorDecode: 0 } },
        streaming: {
          abr: { autoSwitchBitrate: { audio: false, video: false } },
          liveCatchup: { enabled: false },
          gaps: { jumpGaps: false, jumpLargeGaps: false, enableStallFix: false },
          utcSynchronization: { enabled: false },
          text: { defaultEnabled: false },
          cmcd: { enabled: false, applyParametersFromMpd: false },
          applyContentSteering: false,
          lastBitrateCachingInfo: { enabled: false },
          lastMediaSettingsCachingInfo: { enabled: false },
          saveLastMediaSettingsForCurrentStreamingSession: false,
        },
      });
      player.on(dashjs.MediaPlayer.events.ERROR, handleError);
      // Set the fallback for every request type; no Bilibili cookies are sent by the DASH client.
      player.setXHRWithCredentialsForType('default', false);
      video.autoplay = false;
      player.initialize(video, source, false);
      checkActive();
      return { destroy };
    } catch (error) {
      destroy();
      throw error;
    }
  } catch {
    if (signal?.aborted) throw new DOMException('Playback cancelled', 'AbortError');
    throw new Error('DASH_UNAVAILABLE');
  }
}
