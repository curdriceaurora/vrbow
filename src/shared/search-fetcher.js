// search-fetcher.js
// Throttled background fetch queue for search result pet policies. Composes the
// backoff ladder (pacing/pressure), the search cache (memory + storage persistence),
// and the response parser (Apollo/HTML -> policy) into the queue engine that owns
// dispatch order, concurrency, scroll gating, and session budget. Re-exports the
// parser and cache helpers so existing consumers keep one require/global surface.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./backoff-ladder.js"),
      require("./search-cache.js"),
      require("./search-response-parser.js")
    );
  } else {
    root.PawSearchFetcher = factory(root.PawBackoffLadder, root.PawSearchCache, root.PawSearchResponseParser);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (backoffLadder, searchCache, parser) {
  "use strict";

  const DEFAULT_CONCURRENCY = 2;
  const DEFAULT_SESSION_CAP = 40;
  const DEFAULT_IDLE_TIMEOUT_MS = 1000; // Mandatory fallback timeout for requestIdleCallback

  /**
   * Resolved lazily on every call (not captured once) so a site adapter registered
   * after this module loads — or a test that reassigns globalThis.PawSiteRegistry —
   * is picked up immediately.
   */
  function getSiteRegistry() {
    return (typeof globalThis !== "undefined" && globalThis.PawSiteRegistry) ||
      (typeof require === "function" ? require("./site-registry.js") : null);
  }

  /**
   * Search Fetch Queue Engine: dispatch ordering, concurrency, scroll gating, and
   * session budget, wired to a backoff ladder for pacing and a search cache for
   * persistence.
   */
  function createSearchFetchQueue(options = {}) {
    const fetchFn = options.fetchFn || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    const maxConcurrent = options.maxConcurrent !== undefined ? options.maxConcurrent : DEFAULT_CONCURRENCY;
    const sessionCap = options.sessionCap !== undefined ? options.sessionCap : DEFAULT_SESSION_CAP;
    const idleCallbackTimeoutMs = typeof options.idleCallbackTimeoutMs === "number"
      ? options.idleCallbackTimeoutMs
      : DEFAULT_IDLE_TIMEOUT_MS;
    const requestIdleCallbackFn = typeof options.requestIdleCallbackFn === "function"
      ? options.requestIdleCallbackFn
      : (typeof globalThis.requestIdleCallback === "function"
          ? globalThis.requestIdleCallback.bind(globalThis)
          : ((fn, opts) => {
              const start = Date.now();
              return setTimeout(() => {
                fn({
                  didTimeout: Boolean(opts && typeof opts.timeout === "number" && (Date.now() - start) >= opts.timeout),
                  timeRemaining: () => Math.max(0, 50 - (Date.now() - start)),
                });
              }, 0);
            }));
    const cancelIdleCallbackFn = typeof options.cancelIdleCallbackFn === "function"
      ? options.cancelIdleCallbackFn
      : (typeof globalThis.cancelIdleCallback === "function"
          ? globalThis.cancelIdleCallback.bind(globalThis)
          : ((id) => clearTimeout(id)));

    const ladder = backoffLadder.createBackoffLadder({
      baseDelayMs: options.minDelayMs,
      highPriorityFloorMs: options.highPriorityFloorMs,
      errorClusterThreshold: options.errorClusterThreshold,
      errorClusterWindowMs: options.errorClusterWindowMs,
      cleanWindowMs: options.cleanWindowMs,
      pauseOnChallengeMs: options.pauseOnChallengeMs,
      randomFn: options.randomFn,
    });

    const cache = searchCache.createSearchCache({
      storage: options.storage,
      ttlMs: options.ttlMs,
      cooldownMs: options.cooldownMs,
      maxMemoryEntries: options.maxMemoryEntries,
      maintenanceIntervalMs: options.maintenanceIntervalMs,
      autoMaintenance: options.autoMaintenance,
    });

    const queue = []; // [{ propertyId, url, priority }]
    const activeRequests = new Set();
    const enqueuedOrActive = new Set();
    const subscribers = new Map(); // propertyId -> Set of callbacks
    const highPriorityIds = new Set();

    let sessionRequestsCount = 0;
    let isProcessing = false;
    let isDisposed = false;
    let idleHandle = null;
    let scrollPaused = false;
    // enqueue() stages a property synchronously but only pushes it to `queue` after an
    // async storage lookup. Tokens let remove() cancel a still-pending push.
    const pendingEnqueues = new Map();
    let enqueueSeq = 0;
    let maxObservedConcurrency = 0;
    let pauseTimer = null;
    const scheduledTimers = new Set();

    function scheduleTimer(fn, ms) {
      if (isDisposed) return null;
      const timer = setTimeout(() => {
        scheduledTimers.delete(timer);
        if (!isDisposed) fn();
      }, ms);
      scheduledTimers.add(timer);
      return timer;
    }

    function scheduleProcessQueue() {
      if (isDisposed) return;

      // High-priority cut-through: cancel pending idle callback and dispatch synchronously
      if (highPriorityIds.size > 0) {
        if (idleHandle !== null) {
          cancelIdleCallbackFn(idleHandle);
          idleHandle = null;
        }
        processQueue();
        return;
      }

      // Coalesce duplicate idle dispatches
      if (idleHandle !== null) return;

      idleHandle = requestIdleCallbackFn(() => {
        idleHandle = null;
        if (!isDisposed) {
          processQueue();
        }
      }, { timeout: idleCallbackTimeoutMs });
    }

    function setScrollPaused(paused) {
      const wasPaused = scrollPaused;
      scrollPaused = Boolean(paused);
      if (wasPaused && !scrollPaused && !isDisposed) {
        scheduleProcessQueue();
      }
    }

    function subscribe(propertyId, callback) {
      if (!subscribers.has(propertyId)) {
        subscribers.set(propertyId, new Set());
      }
      subscribers.get(propertyId).add(callback);
      return () => {
        const set = subscribers.get(propertyId);
        if (set) {
          set.delete(callback);
          if (set.size === 0) subscribers.delete(propertyId);
        }
      };
    }

    function notify(propertyId, data) {
      const cbs = subscribers.get(propertyId);
      if (cbs) {
        for (const cb of cbs) {
          try {
            cb(data);
          } catch (e) {
            console.error("PawCheck subscriber error:", e);
          }
        }
      }
    }

    async function processQueue() {
      if (isProcessing || isDisposed) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      if (ladder.isPaused()) {
        const remainingPause = ladder.getPausedUntil() - Date.now();
        scheduleTimer(processQueue, remainingPause + 50);
        return;
      }

      isProcessing = true;
      try {
        while (
          queue.length > 0 &&
          activeRequests.size < maxConcurrent &&
          !isDisposed &&
          (typeof document === "undefined" || document.visibilityState !== "hidden") &&
          !ladder.isPaused()
        ) {
          // Peek the next item FIRST: per-class pacing floors cannot be evaluated before
          // the item's class is known, so the gate below runs after the priority pick.
          let nextIndex = queue.findIndex((item) => item.priority === "high" || highPriorityIds.has(item.propertyId));
          const isHighPriority = nextIndex !== -1;
          if (nextIndex === -1) nextIndex = 0;
          const candidate = queue[nextIndex];

          // SCROLL GATE: normal items break the loop without touching any other state
          // (ladder, pause, clean-window are all untouched); high-priority
          // items (user hover) proceed unimpeded regardless of scroll state.
          if (!isHighPriority && scrollPaused) {
            break;
          }

          // Resolutions that issue no network request are settled before the pacing gate,
          // so a skipped item never consumes a dispatch slot's worth of delay.

          // Check session cap: background requests are capped; explicit user hover (priority: "high") bypasses the background cap
          if (!isHighPriority && sessionRequestsCount >= sessionCap) {
            queue.splice(nextIndex, 1);
            highPriorityIds.delete(candidate.propertyId);
            enqueuedOrActive.delete(candidate.propertyId);
            const result = { status: "capped", propertyId: candidate.propertyId };
            cache.recordTerminalState(candidate.propertyId, result, true);
            notify(candidate.propertyId, result);
            continue;
          }

          // Check memory cache once more before firing network
          const cached = cache.peekMemory(candidate.propertyId);
          if (cached && !cache.isShallowPreliminaryPolicy(cached.data?.policy)) {
            queue.splice(nextIndex, 1);
            highPriorityIds.delete(candidate.propertyId);
            enqueuedOrActive.delete(candidate.propertyId);
            notify(candidate.propertyId, cached.data);
            continue;
          }

          // Pacing gate. Jitter is applied ONCE to the resolved max(...), never per term.
          const wait = ladder.computeDispatchWait(isHighPriority, Date.now());
          if (wait > 0) {
            scheduleTimer(processQueue, ladder.applyJitter(wait));
            break;
          }

          const [nextItem] = queue.splice(nextIndex, 1);
          highPriorityIds.delete(nextItem.propertyId);

          // Execute fetch
          sessionRequestsCount++;
          const dispatchedAt = Date.now();
          ladder.recordDispatch(isHighPriority, dispatchedAt);
          activeRequests.add(nextItem.propertyId);
          maxObservedConcurrency = Math.max(maxObservedConcurrency, activeRequests.size);

          executeFetch(nextItem.propertyId, nextItem.url)
            .finally(() => {
              activeRequests.delete(nextItem.propertyId);
              enqueuedOrActive.delete(nextItem.propertyId);
              if (!isDisposed) scheduleProcessQueue();
            });
        }
      } finally {
        isProcessing = false;
      }
    }

    const activeControllers = new Map();
    const requestTimeoutMs = options.requestTimeoutMs || 6000;

    async function executeFetch(propertyId, url) {
      if (isDisposed) return;
      const controller = new AbortController();
      activeControllers.set(propertyId, controller);
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        if (!fetchFn) throw new Error("No fetch implementation available");

        const validated = parser.validateListingUrl(url);
        let targetUrl = validated ? validated.fetchUrl : url;

        try {
          const siteRegistry = getSiteRegistry();
          if (siteRegistry && typeof siteRegistry.decorateFetchUrl === "function") {
            targetUrl = siteRegistry.decorateFetchUrl(targetUrl);
          }
        } catch {}

        const res = await fetchFn(targetUrl, {
          signal: controller.signal,
          headers: {
            "Accept-Language": "en-US,en;q=0.9",
          },
        });

        if (isDisposed) return;

        if (res.status === 429 || res.status === 403) {
          // One shared counter: noteHardBlock sets the pause AND advances the ladder,
          // exactly once for this event.
          ladder.noteHardBlock();
          const result = { status: "rate_limited", propertyId };
          cache.recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }

        if (!res.ok) {
          // Only 5xx is server pressure and feeds the error cluster. A 404 (or any
          // other 4xx that is not 429/403) proves the server is healthy and answering
          // — the property is simply gone. It is fully inert, exactly like `unknown`:
          // it neither advances the ladder nor resets the clean window, so a scatter
          // of delisted listings cannot hold the ladder elevated and block recovery.
          if (res.status >= 500) ladder.noteSoftFailure();
          const result = { status: "error", code: res.status, propertyId };
          cache.recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }

        // Class 12: Detect redirects & extract canonical ID from res.url
        let canonicalId = null;
        if (res.url && typeof res.url === "string") {
          try {
            const resValidated = parser.validateListingUrl(res.url);
            if (resValidated && resValidated.propertyId && resValidated.propertyId.toLowerCase() !== propertyId.toLowerCase()) {
              canonicalId = resValidated.propertyId;
            }
          } catch {}
        }

        const html = await res.text();
        if (isDisposed) return;

        let parsed = null;
        try {
          const siteRegistry = getSiteRegistry();
          if (siteRegistry && typeof siteRegistry.parseListingData === "function") {
            parsed = siteRegistry.parseListingData(targetUrl, html, propertyId, canonicalId);
          } else {
            parsed = parser.parseListingHtml(html, propertyId, canonicalId);
          }
        } catch {
          parsed = parser.parseListingHtml(html, propertyId, canonicalId);
        }

        if (parsed && !parsed.policy && !parsed.isChallenge && typeof parsed === "object" && ("petsAllowed" in parsed || "maxDogs" in parsed || "restrictionsFound" in parsed)) {
          parsed = { ok: true, propertyId, canonicalId, policy: parsed };
        }

        if (parsed && parsed.isChallenge) {
          ladder.noteHardBlock();
          const result = { status: "rate_limited", propertyId };
          cache.recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }

        const effectiveCanonicalId = canonicalId || parsed?.canonicalId;
        const hasConcrete = parser.hasConcretePolicy(parsed && parsed.policy);

        if (hasConcrete) {
          ladder.noteSuccess();
          const data = {
            status: "ok",
            propertyId,
            canonicalId: effectiveCanonicalId || propertyId,
            policy: parsed.policy,
            ts: Date.now(),
          };
          cache.clearTerminalState(propertyId);
          if (effectiveCanonicalId) cache.clearTerminalState(effectiveCanonicalId);

          const cachedResult = await cache.setCached(propertyId, data, { persist: true, targetUrl });

          // Class 12 & Class 10: Cache under canonical ID and update alias map
          if (effectiveCanonicalId && effectiveCanonicalId.toLowerCase() !== propertyId.toLowerCase()) {
            await cache.setCached(effectiveCanonicalId, { ...data, propertyId: effectiveCanonicalId }, { persist: true, targetUrl });
            cache.setAlias(propertyId, effectiveCanonicalId, { persist: true });
          }

          if (parsed?.aliases && Array.isArray(parsed.aliases)) {
            for (const alias of parsed.aliases) {
              if (alias && alias.toLowerCase() !== propertyId.toLowerCase()) {
                cache.setAlias(alias, effectiveCanonicalId || propertyId);
              }
            }
          }

          const winner = (cachedResult && cachedResult.data) ? cachedResult.data : data;
          notify(propertyId, winner);
          if (effectiveCanonicalId && effectiveCanonicalId !== propertyId) {
            notify(effectiveCanonicalId, winner);
          }
        } else {
          // `unknown` follows a SUCCESSFUL fetch and parse that found no concrete policy.
          // It is not a failure: it must not advance the ladder and must not reset the
          // clean window, so no pacing signal is emitted here.
          const result = {
            status: "unknown",
            propertyId,
            policy: null,
          };
          cache.recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
        }
      } catch (err) {
        if (isDisposed) return;
        if (err.name === "AbortError") {
          // Stalled request timed out: emit terminal timeout result (never cached)
          ladder.noteSoftFailure();
          const result = { status: "timeout", propertyId };
          cache.recordTerminalState(propertyId, result, false);
          notify(propertyId, result);
          return;
        }
        ladder.noteSoftFailure();
        const result = { status: "error", error: err.message, propertyId };
        cache.recordTerminalState(propertyId, result, false);
        notify(propertyId, result);
      } finally {
        clearTimeout(timer);
        activeControllers.delete(propertyId);
      }
    }

    function enqueue(propertyId, url, priority = "normal") {
      if (!propertyId || !url || isDisposed) return;

      // 1. Check memory cache synchronously (with alias lookup)
      const mem = cache.peekMemory(propertyId);
      if (mem) {
        notify(propertyId, mem.data);
        if (mem.targetId !== propertyId) notify(mem.targetId, mem.data);
        if (!cache.isShallowPreliminaryPolicy(mem.data?.policy)) {
          return;
        }
      }

      // 2. Check terminal-state cooldown
      const terminal = cache.getTerminalState(propertyId);
      if (terminal) {
        // If high priority and bypass is allowed (e.g. background-capped property receiving its 1 explicit attempt)
        if (priority === "high" && terminal.allowBypass) {
          cache.clearTerminalState(propertyId);
          // proceed to enqueue attempt
        } else {
          notify(propertyId, terminal.data);
          return;
        }
      }

      // 3. Synchronous duplicate check to prevent race conditions
      if (enqueuedOrActive.has(propertyId)) {
        if (priority === "high") {
          highPriorityIds.add(propertyId);
          const item = queue.find((q) => q.propertyId === propertyId);
          if (item) item.priority = "high";
        }
        return;
      }
      if (priority === "high") {
        highPriorityIds.add(propertyId);
      }
      enqueuedOrActive.add(propertyId);

      // 4. Check storage cache
      const token = ++enqueueSeq;
      pendingEnqueues.set(propertyId, token);
      cache.getCached(propertyId).then((cached) => {
        if (isDisposed) return;
        // remove() (or a newer enqueue) invalidated this staged push.
        if (pendingEnqueues.get(propertyId) !== token) return;
        pendingEnqueues.delete(propertyId);
        if (cached && cached.status === "ok") {
          enqueuedOrActive.delete(propertyId);
          highPriorityIds.delete(propertyId);
          notify(propertyId, cached);
          return;
        }

        queue.push({ propertyId, url, priority });
        scheduleProcessQueue();
      });
    }

    /**
     * I8a: cancel a single queued (or still-staging) item. Returns true if something
     * was cancelled, false for an unknown id or one already in flight.
     *
     * Clearing `enqueuedOrActive` is mandatory, not cosmetic: enqueue() early-returns
     * on `enqueuedOrActive.has(propertyId)`, so splicing the queue array alone would
     * lock that property out of enqueueing for the rest of the session.
     *
     * Deliberately does NOT touch sessionRequestsCount or terminal cooldowns:
     * clearQueue() semantics are unchanged and the session budget must survive.
     */
    function remove(propertyId) {
      if (!propertyId || isDisposed) return false;
      if (activeRequests.has(propertyId)) return false; // in-flight: not removable

      const idx = queue.findIndex((item) => item.propertyId === propertyId);
      const known = idx !== -1 || pendingEnqueues.has(propertyId) || enqueuedOrActive.has(propertyId);
      if (!known) return false;

      if (idx !== -1) queue.splice(idx, 1);
      pendingEnqueues.delete(propertyId);
      enqueuedOrActive.delete(propertyId);
      highPriorityIds.delete(propertyId);
      return true;
    }

    function clearQueue() {
      queue.length = 0;
      enqueuedOrActive.clear();
      highPriorityIds.clear();
      pendingEnqueues.clear();
      sessionRequestsCount = 0;
      cache.clearCooldowns();
    }

    function onVisibilityChange() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        scheduleProcessQueue();
      }
    }

    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    function dispose() {
      isDisposed = true;
      clearQueue();
      for (const ctrl of activeControllers.values()) {
        try { ctrl.abort(); } catch {}
      }
      activeControllers.clear();
      for (const t of scheduledTimers) {
        clearTimeout(t);
      }
      scheduledTimers.clear();
      if (idleHandle !== null) {
        cancelIdleCallbackFn(idleHandle);
        idleHandle = null;
      }
      if (pauseTimer) {
        clearTimeout(pauseTimer);
        pauseTimer = null;
      }
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      subscribers.clear();
      cache.dispose();
    }

    return {
      getCached: cache.getCached,
      setCached: cache.setCached,
      enqueue,
      remove,
      clearQueue,
      dispose,
      subscribe,
      setScrollPaused,
      isScrollPaused: () => scrollPaused,
      getQueueLength: () => queue.length,
      // Items staged by enqueue() whose async getCached() has not resolved yet, so
      // they are not in `queue` and not yet counted by getQueueLength(). #23's gate
      // reads queue depth under sustained scroll, where this population is nonzero.
      getPendingCount: () => pendingEnqueues.size,
      getActiveCount: () => activeRequests.size,
      getSessionCount: () => sessionRequestsCount,
      getMaxObservedConcurrency: () => maxObservedConcurrency,
      isPaused: ladder.isPaused,
      getLadderStep: ladder.getLadderStep,
      getEffectiveMinDelayMs: ladder.effectiveMinDelayMs,
      getHighPriorityDelayMs: ladder.hpMinDelayMs,
      isInCooldown: cache.isInCooldown,
      getMemoryCacheSize: cache.getSize,
    };
  }

  return {
    CACHE_PREFIX: searchCache.CACHE_PREFIX,
    ALIAS_PREFIX: searchCache.ALIAS_PREFIX,
    walkApolloNode: parser.walkApolloNode,
    parseListingHtml: parser.parseListingHtml,
    hasConcretePolicy: parser.hasConcretePolicy,
    resolveSearchApolloRecord: parser.resolveSearchApolloRecord,
    createSearchFetchQueue,
    extractPropertyIdFromUrl: parser.extractPropertyIdFromUrl,
    validateListingUrl: parser.validateListingUrl,
    performStorageMaintenance: searchCache.performStorageMaintenance,
    calculatePolicyCompleteness: searchCache.calculatePolicyCompleteness,
    canPolicyUpgrade: searchCache.canPolicyUpgrade,
    serializeSearchPolicyForCache: searchCache.serializeSearchPolicyForCache,
  };
});
