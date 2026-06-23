type AnalyticsParams = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    MAJA_ANALYTICS?: { gaMeasurementId?: string };
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const VISITOR_ID_KEY = 'konnakol_trainer_visitor_id';
const VISIT_COUNT_KEY = 'konnakol_trainer_visit_count';

let initialized = false;
let sessionStartedAtMs = 0;
let sessionEndSent = false;
let playbackStartedAtMs: number | null = null;
let hadPlaybackThisSession = false;

function readMeasurementId(): string {
  const fromEnv = import.meta.env.VITE_GA_MEASUREMENT_ID?.trim();
  if (fromEnv && fromEnv !== 'G-XXXXXXXXXX') return fromEnv;
  const fromConfig = window.MAJA_ANALYTICS?.gaMeasurementId?.trim();
  if (fromConfig && fromConfig !== 'G-XXXXXXXXXX') return fromConfig;
  return '';
}

function ensureVisitorId(): string {
  try {
    const existing = localStorage.getItem(VISITOR_ID_KEY);
    if (existing) return existing;
    const created =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `v_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(VISITOR_ID_KEY, created);
    return created;
  } catch {
    return 'anonymous';
  }
}

function bumpVisitCount(): number {
  try {
    const next = Number(localStorage.getItem(VISIT_COUNT_KEY) ?? '0') + 1;
    localStorage.setItem(VISIT_COUNT_KEY, String(next));
    return next;
  } catch {
    return 1;
  }
}

function baseParams(): AnalyticsParams {
  return {
    app: 'konnakol_trainer',
    visitor_id: ensureVisitorId(),
    build_commit:
      typeof __APP_BUILD_COMMIT__ === 'string' ? __APP_BUILD_COMMIT__.slice(0, 7) : 'unknown',
    page_path: window.location.pathname,
    page_location: window.location.href,
  };
}

function gtagEvent(eventName: string, params?: AnalyticsParams): void {
  if (!initialized || typeof window.gtag !== 'function') return;
  window.gtag('event', eventName, {
    ...baseParams(),
    ...params,
  });
}

export function trackUi(action: string, target: string, params?: AnalyticsParams): void {
  gtagEvent('trainer_ui', {
    action,
    target,
    ...params,
  });
}

export function initAnalytics(): void {
  if (initialized || typeof window === 'undefined') return;
  if (!import.meta.env.PROD) return;

  const measurementId = readMeasurementId();
  if (!measurementId) return;

  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function gtag(...args: unknown[]) {
    window.dataLayer!.push(args);
  };
  window.gtag('js', new Date());
  window.gtag('config', measurementId, {
    anonymize_ip: true,
    send_page_view: true,
    page_path: window.location.pathname,
    page_title: 'Konnakol Machine',
  });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);

  initialized = true;
  sessionStartedAtMs = Date.now();

  const visitCount = bumpVisitCount();
  gtagEvent('trainer_visit', {
    visit_count: visitCount,
    is_returning: visitCount > 1,
    referrer: document.referrer || '(direct)',
    screen: `${window.screen.width}x${window.screen.height}`,
    language: navigator.language,
  });
}

export function trackPlaybackStart(params: {
  tempo: number;
  bars: number;
  polyMode: boolean;
  polyVoices?: number;
}): void {
  playbackStartedAtMs = Date.now();
  hadPlaybackThisSession = true;
  gtagEvent('trainer_play', {
    tempo: params.tempo,
    bars: params.bars,
    poly_mode: params.polyMode,
    poly_voices: params.polyVoices ?? 0,
  });
}

export function trackPlaybackStop(): void {
  const startedAt = playbackStartedAtMs;
  playbackStartedAtMs = null;
  if (startedAt === null) return;
  const durationSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  gtagEvent('trainer_stop', {
    play_duration_sec: durationSec,
  });
}

export function trackSessionEnd(): void {
  if (!initialized || sessionStartedAtMs === 0 || sessionEndSent) return;
  sessionEndSent = true;
  const sessionDurationSec = Math.max(0, Math.round((Date.now() - sessionStartedAtMs) / 1000));
  gtagEvent('trainer_session_end', {
    session_duration_sec: sessionDurationSec,
    had_playback: hadPlaybackThisSession,
  });
}
