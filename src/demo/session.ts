/**
 * When the shared hosted demo reseeds. A new Cloudflare Access session resets
 * it only after IDLE_MS without any requests, so overlapping reviewers never
 * wipe each other's work and a returning session keeps its data.
 */
export const IDLE_MS = 15 * 60_000;

export type DemoState = {
  lastActivity: number | null;
  lastResetAt: number | null;
  /** Access session → when it was last seen and when its token expires */
  sessions: Record<string, { seen: number; expires: number }>;
};

export type DemoStatus = {
  enabled: true;
  idleMinutes: number;
  /** Another session made a request within the idle window */
  othersActive: boolean;
  lastResetAt: string | null;
  /** This request reseeded the demo */
  reset: boolean;
};

/**
 * Local dev, where `GET /api/demo` has no shared demo to report. The demo can
 * still be reset to the seed from the running server.
 */
export type LocalDemoStatus = {
  enabled: false;
  resettable: boolean;
  /** This request reseeded the demo */
  reset?: boolean;
};

export const emptyDemoState = (): DemoState => ({
  lastActivity: null,
  lastResetAt: null,
  sessions: {}
});

function status(
  state: DemoState,
  reset: boolean,
  othersActive: boolean
): DemoStatus {
  return {
    enabled: true,
    idleMinutes: IDLE_MS / 60_000,
    othersActive,
    lastResetAt:
      state.lastResetAt === null
        ? null
        : new Date(state.lastResetAt).toISOString(),
    reset
  };
}

/**
 * Records a request. The first request ever also seeds the database, and an
 * unfinished earlier reset (`resetPending`) is retried before anything else.
 */
export function admitSession(
  state: DemoState,
  session: string,
  expires: number,
  now: number,
  resetPending = false
): { reset: boolean; state: DemoState; status: DemoStatus } {
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).filter(([, s]) => s.expires > now)
  );
  const idle =
    state.lastActivity === null || now - state.lastActivity >= IDLE_MS;
  const reset =
    resetPending ||
    state.lastResetAt === null ||
    (!(session in sessions) && idle);
  const othersActive =
    !reset &&
    Object.entries(sessions).some(
      ([key, s]) => key !== session && now - s.seen < IDLE_MS
    );
  sessions[session] = { seen: now, expires };
  const next = {
    lastActivity: now,
    lastResetAt: reset ? now : state.lastResetAt,
    sessions
  };
  return { reset, state: next, status: status(next, reset, othersActive) };
}

/** A reviewer asked for fresh data; other sessions stay known. */
export function resetSession(
  state: DemoState,
  now: number
): { state: DemoState; status: DemoStatus } {
  const next = { ...state, lastActivity: now, lastResetAt: now };
  return { state: next, status: status(next, true, false) };
}
