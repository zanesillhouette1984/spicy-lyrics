import Global from "../../components/Global/Global.ts";
import { SpotifyPlayer } from "../../components/Global/SpotifyPlayer.ts";
import { isExperimentEnabled } from "../experiments.ts";
import Logger from "../Logger.ts";

const pacerLogger = new Logger("Request Pacer");

/**
 * Holds per-track network requests back until the listener has settled on a
 * track.
 *
 * Every track change used to request that track's lyrics straight away, and the
 * NPV card keeps a lyrics view open nearly all the time, so skipping through a
 * queue sent one request per track. Fast skippers ran into the API's rate limit
 * ("You're going a little fast for us") on the track they finally stopped at.
 * A request now waits until its track has been playing for a settle time, and
 * is dropped if the track changes first: a run of skips costs one request, for
 * the track the user lands on.
 *
 * The settle time follows the listener:
 * - Listening (the previous track played for a while, or nothing has changed
 *   since startup): no wait, so normal playback loads lyrics exactly as before.
 * - Skipping: at least SKIPPING_SETTLE_MS, stretched to a little longer than the
 *   user has been lingering on each track, so someone flicking every couple of
 *   seconds doesn't get a request in on every one. A rhythm slower than
 *   MAX_SETTLE_MS can wait out gains nothing from a longer wait, so it gets the
 *   baseline.
 * - After the API rate-limits us, waits double for RATE_LIMIT_COOLDOWN_MS.
 *
 * Only network requests wait. Lyrics already in memory, in the local DB or in
 * the cache still apply the moment the track changes.
 */

/** Leaving a track sooner than this counts as a skip rather than a listen. */
const SKIP_DWELL_MS = 12_000;
/** The wait once the user is skipping. */
const SKIPPING_SETTLE_MS = 1_500;
/** How much longer than the user's skip rhythm to wait. */
const RHYTHM_FACTOR = 1.3;
/** The longest a skip rhythm may stretch the wait to. */
const MAX_SETTLE_MS = 5_000;
/** Recent skips the rhythm is taken from. */
const RHYTHM_SAMPLES = 5;
/** How long a rate-limit response keeps the waits doubled. */
const RATE_LIMIT_COOLDOWN_MS = 120_000;

type TrackRecord = {
  uri: string;
  /** performance.now() when the track started; -Infinity for the one playing at startup. */
  startedAt: number;
  /** performance.now() from which requests for it may go out. */
  settleAt: number;
};

let current: TrackRecord | null = null;
/** How long each track of the current run of skips was played, oldest first. */
const skipDwells: number[] = [];
let rateLimitedAt = Number.NEGATIVE_INFINITY;

const isPacingEnabled = () => isExperimentEnabled("requestPacing");

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isRateLimited(now: number): boolean {
  return now - rateLimitedAt < RATE_LIMIT_COOLDOWN_MS;
}

function settleDelay(now: number): number {
  let delay = 0;
  if (skipDwells.length > 0) {
    const rhythmWait = median(skipDwells) * RHYTHM_FACTOR;
    delay =
      rhythmWait <= MAX_SETTLE_MS ? Math.max(SKIPPING_SETTLE_MS, rhythmWait) : SKIPPING_SETTLE_MS;
  }
  if (isRateLimited(now)) delay = Math.max(delay, SKIPPING_SETTLE_MS) * 2;
  return delay;
}

function noteTrack(uri: string): void {
  if (current?.uri === uri) return;
  const now = performance.now();

  if (current === null) {
    // Already playing when we started: it has been on for an unknown while, so
    // the next change is never mistaken for a skip.
    current = { uri, startedAt: Number.NEGATIVE_INFINITY, settleAt: now };
    return;
  }

  const dwell = now - current.startedAt;
  if (dwell < SKIP_DWELL_MS) {
    skipDwells.push(dwell);
    if (skipDwells.length > RHYTHM_SAMPLES) skipDwells.shift();
  } else {
    skipDwells.length = 0;
  }

  const delay = settleDelay(now);
  current = { uri, startedAt: now, settleAt: now + delay };
  if (delay > 0) {
    pacerLogger.debug("Track change while skipping, holding requests", {
      uri,
      delayMs: Math.round(delay),
      recentSkips: skipDwells.length,
    });
  }
}

function isAnotherTrackPlaying(uri: string): boolean {
  const playing = SpotifyPlayer.GetUri();
  return playing != null && playing !== uri;
}

/**
 * Resolves true once a network request for `uri` may go out, or false if it
 * should be dropped: another track started (or `isSuperseded` turned true)
 * before the track settled.
 */
export async function WaitForTrackToSettle(
  uri: string,
  isSuperseded: () => boolean = () => false
): Promise<boolean> {
  if (!isPacingEnabled()) return true;
  if (isSuperseded() || isAnotherTrackPlaying(uri)) return false;
  // The songchange listener normally got here first; this covers the case
  // where a fetch for the new track starts before the event is delivered.
  noteTrack(uri);

  for (;;) {
    const remaining = current?.uri === uri ? current.settleAt - performance.now() : 0;
    if (remaining <= 0) return true;
    await new Promise((resolve) => setTimeout(resolve, remaining));
    if (isSuperseded() || isAnotherTrackPlaying(uri)) return false;
  }
}

/** The API answered with a rate limit; slow down for a while. */
export function NoteRateLimited(): void {
  rateLimitedAt = performance.now();
}

// Recorded whether or not pacing is on, so turning it on mid-session already
// knows how fast the user has been skipping.
Global.Event.listen("playback:songchange", (event: any) => {
  const uri: string | undefined = event?.data?.item?.uri ?? SpotifyPlayer.GetUri();
  if (uri) noteTrack(uri);
});

/** Debug surface, wired into `window.SpicyLyrics.request.pacer`. */
export const PacerDebug = {
  state: () => {
    const now = performance.now();
    return {
      enabled: isPacingEnabled(),
      uri: current?.uri ?? null,
      settlesInMs: current ? Math.max(0, Math.round(current.settleAt - now)) : 0,
      recentSkips: skipDwells.length,
      rhythmMs: skipDwells.length > 0 ? Math.round(median(skipDwells)) : null,
      rateLimited: isRateLimited(now),
    };
  },
};
