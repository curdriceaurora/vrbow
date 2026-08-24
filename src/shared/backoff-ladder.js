// backoff-ladder.js
// Adaptive dispatch pacing for the search fetch queue: the delay ladder, dispatch-wait
// math, and the pressure/recovery signals that step it up and down. No fetch, cache, or
// storage concerns live here — this module only tracks timing state and answers "how
// long until the next dispatch is allowed".

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PawBackoffLadder = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Base of the adaptive delay ladder. effectiveMinDelayMs = baseDelayMs * 2 ** ladderStep,
  // so background pacing walks 800 -> 1600 -> 3200 ms.
  const DEFAULT_BASE_DELAY_MS = 800;
  // Global dispatch floor applied to EVERY dispatch regardless of class, high priority
  // included. Scales on the same shared ladder: 250 -> 500 -> 1000 ms.
  const DEFAULT_HIGH_PRIORITY_FLOOR_MS = 250;
  // ladderStep saturates here: 800 * 2 ** 2 = 3200 ms. There is no step 3.
  const DEFAULT_MAX_LADDER_STEP = 2;
  // One-sided jitter: +[0, 30%] of the resolved wait, never below the floor. A symmetric
  // +/- jitter would permit firing faster than the rate limit it is meant to enforce.
  const DEFAULT_JITTER_RATIO = 0.3;
  // Timeouts / 5xx only escalate after a small cluster, so one noisy timeout does not throttle.
  const DEFAULT_ERROR_CLUSTER_THRESHOLD = 3;
  const DEFAULT_ERROR_CLUSTER_WINDOW_MS = 60000;
  // Recovery is deliberately asymmetric: one success never steps down, a sustained
  // clean window (zero non-successes) does.
  const DEFAULT_CLEAN_WINDOW_MS = 60000;
  const DEFAULT_PAUSE_ON_CHALLENGE_MS = 30000; // 30s backoff if 429 or challenge encountered

  /**
   * Creates an adaptive backoff ladder tracking dispatch pacing, pressure escalation,
   * and success-driven recovery for the search fetch queue.
   */
  function createBackoffLadder(options = {}) {
    const baseDelayMs = options.baseDelayMs !== undefined ? options.baseDelayMs : DEFAULT_BASE_DELAY_MS;
    // Clamp is an invariant of the two-tracker design, not a test convenience:
    // lastDispatchAt gates EVERY dispatch, so hpFloor is the aggregate rate limit
    // sitting underneath the per-class background floor. Letting it exceed
    // baseDelayMs would make the "global" floor stricter than the background floor
    // it is supposed to sit under, and background items would then be paced by the
    // high-priority term instead of their own. At production constants the clamp is
    // inert (min(250, 800) = 250); it only binds when baseDelayMs is configured
    // below 250 ms.
    const highPriorityFloorMs = Math.min(
      options.highPriorityFloorMs !== undefined ? options.highPriorityFloorMs : DEFAULT_HIGH_PRIORITY_FLOOR_MS,
      baseDelayMs
    );
    const errorClusterThreshold = options.errorClusterThreshold !== undefined
      ? options.errorClusterThreshold
      : DEFAULT_ERROR_CLUSTER_THRESHOLD;
    const errorClusterWindowMs = options.errorClusterWindowMs !== undefined
      ? options.errorClusterWindowMs
      : DEFAULT_ERROR_CLUSTER_WINDOW_MS;
    const cleanWindowMs = options.cleanWindowMs !== undefined ? options.cleanWindowMs : DEFAULT_CLEAN_WINDOW_MS;
    const pauseOnChallengeMs = options.pauseOnChallengeMs !== undefined
      ? options.pauseOnChallengeMs
      : DEFAULT_PAUSE_ON_CHALLENGE_MS;
    const randomFn = typeof options.randomFn === "function" ? options.randomFn : Math.random;

    let ladderStep = 0;
    let pausedUntil = 0;
    let lastDispatchAt = 0;
    let lastBgStart = 0;
    let lastNonSuccessAt = Date.now();
    const softFailureTimes = [];

    function effectiveMinDelayMs() {
      return baseDelayMs * Math.pow(2, ladderStep);
    }

    function hpMinDelayMs() {
      return highPriorityFloorMs * Math.pow(2, ladderStep);
    }

    /** One-sided jitter, applied ONCE to an already-resolved wait. */
    function applyJitter(waitMs) {
      if (!(waitMs > 0)) return waitMs;
      return waitMs + randomFn() * DEFAULT_JITTER_RATIO * waitMs;
    }

    function bumpLadder() {
      if (ladderStep < DEFAULT_MAX_LADDER_STEP) ladderStep++;
    }

    /**
     * Restarts the clean window used for recovery. Called only by the two pressure
     * outcomes below (hard block, soft failure). Everything else — `unknown`, 404 and
     * other non-429/403 4xx — is inert on this path as well as on the ladder.
     */
    function noteNonSuccess() {
      lastNonSuccessAt = Date.now();
    }

    /**
     * 429 / 403 / bot challenge. Does exactly two things, once per event:
     * sets the hard pause AND advances the shared ladder. The pause is the
     * immediate stop; the ladder is what makes the resumption slower.
     */
    function noteHardBlock() {
      pausedUntil = Date.now() + pauseOnChallengeMs;
      noteNonSuccess();
      bumpLadder();
    }

    /** Timeout / 5xx / network error: escalates only on a cluster. */
    function noteSoftFailure() {
      const now = Date.now();
      noteNonSuccess();
      softFailureTimes.push(now);
      while (softFailureTimes.length > 0 && now - softFailureTimes[0] > errorClusterWindowMs) {
        softFailureTimes.shift();
      }
      if (softFailureTimes.length >= errorClusterThreshold) {
        softFailureTimes.length = 0; // next escalation needs another full cluster
        bumpLadder();
      }
    }

    /**
     * A concrete-policy success. Steps down only after a sustained clean window.
     *
     * Recovery is success-driven BY DESIGN, not on a timer: a ladder sitting above
     * step 0 with zero traffic does not self-heal, it waits for the next successful
     * fetch. This is intentional. An idle queue issues no requests, so an elevated
     * floor costs nothing while idle, and the first request after an idle stretch is
     * the one that most needs to be careful. Queues do not outlive a page session,
     * so there is no long-lived state to leak.
     */
    function noteSuccess() {
      const now = Date.now();
      if (ladderStep > 0 && now - lastNonSuccessAt >= cleanWindowMs) {
        ladderStep--;
        lastNonSuccessAt = now; // the next step-down needs another full window
      }
    }

    /**
     * wait = max(hpFloor - since(lastDispatchAt), classFloor - since(classStart))
     * Background needs both terms: the global one binds when a hover has just fired,
     * the class one otherwise. High priority only needs the global term, since
     * lastDispatchAt already covers every previous high-priority dispatch.
     */
    function computeDispatchWait(isHighPriority, now) {
      const globalWait = hpMinDelayMs() - (now - lastDispatchAt);
      if (isHighPriority) return Math.max(globalWait, 0);
      const classWait = effectiveMinDelayMs() - (now - lastBgStart);
      return Math.max(globalWait, classWait, 0);
    }

    /** Records a dispatch's timestamp against the tracker(s) its class uses. */
    function recordDispatch(isHighPriority, dispatchedAt) {
      lastDispatchAt = dispatchedAt;
      if (!isHighPriority) lastBgStart = dispatchedAt;
    }

    function isPaused(now = Date.now()) {
      return now < pausedUntil;
    }

    function getPausedUntil() {
      return pausedUntil;
    }

    return {
      noteHardBlock,
      noteSoftFailure,
      noteSuccess,
      computeDispatchWait,
      recordDispatch,
      applyJitter,
      effectiveMinDelayMs,
      hpMinDelayMs,
      isPaused,
      getPausedUntil,
      getLadderStep: () => ladderStep,
    };
  }

  return {
    createBackoffLadder,
  };
});
