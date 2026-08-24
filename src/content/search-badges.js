// Search-page card scanning, queue orchestration, badges, and tooltips.
(function initSearchBadges(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PawSearchBadges = api;
  }
})(globalThis, (root) => {
  function createSearchBadges(deps = {}) {
    const siteRegistry = deps.siteRegistry;
    const isSearchUrl = deps.isSearchUrl;
    const createSafeStorageWrapper = deps.createSafeStorageWrapper;
    const getSearchApolloData = deps.getSearchApolloData || (() => null);

  // ---------- Search Page Card Badging & Hover Tooltips ----------

  let searchQueue = null;
  let searchCardObserver = null;
  let searchTooltipEl = null;
  let activeTooltipTarget = null;
  let activeTooltipPropId = null;
  let tooltipLeaveTimer = null;

  // Every property id we have bound to a card, mapped to the card node that
  // owns it. This is the ledger I7's prune walks: a tracked id whose node has
  // left the DOM is stale work that must be dropped.
  const trackedSearchCards = new Map(); // propertyId -> card element
  const cardsByPropertyId = new Map(); // propertyId -> Set<card element> for O(1) duplicate checks

  function trackCardPropId(propId, card) {
    if (!propId || !card) return;
    let set = cardsByPropertyId.get(propId);
    if (!set) {
      set = new Set();
      cardsByPropertyId.set(propId, set);
    }
    set.add(card);
  }

  function untrackCardPropId(propId, card) {
    if (!propId) return;
    const set = cardsByPropertyId.get(propId);
    if (set) {
      if (card) set.delete(card);
      for (const node of set) {
        if (!node || !node.isConnected) set.delete(node);
      }
      if (set.size === 0) cardsByPropertyId.delete(propId);
    }
  }

  // I9: mutation-driven scans run on a leading-edge throttle. The first scan of
  // a burst runs synchronously (card binding must not lag a re-render), the rest
  // of the burst collapses into one trailing scan.
  const SEARCH_SCAN_THROTTLE_MS = 250;
  let lastSearchScanAt = 0;
  let searchScanThrottleTimer = null;

  // Scroll velocity tracking & settle detection (Issue #23)
  const SCROLL_VELOCITY_THRESHOLD_PX_S = 150;
  const SCROLL_SETTLE_DEBOUNCE_MS = 150;

  let lastScrollY = 0;
  let lastScrollTime = 0;
  let scrollRafId = null;
  let scrollSettleTimer = null;
  let isScrollPaused = false;
  let scrollListenersAttached = false;

  function onWindowScroll() {
    if (scrollRafId !== null) return; // Coalesce to one computation per frame

    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      const now = performance.now();
      const currentY = typeof window !== "undefined" ? (window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0) : 0;

      // Explicit first-event guard: initialize baseline without a false-positive
      // velocity spike. performance.now() is never exactly 0 once any time has
      // elapsed since navigation start, so this sentinel is unambiguous.
      if (lastScrollTime === 0) {
        lastScrollY = currentY;
        lastScrollTime = now;
        return;
      }

      const dt = now - lastScrollTime;
      if (dt > 0) {
        const velocity = (Math.abs(currentY - lastScrollY) / dt) * 1000;
        lastScrollY = currentY;
        lastScrollTime = now;

        if (velocity >= SCROLL_VELOCITY_THRESHOLD_PX_S && !isScrollPaused) {
          isScrollPaused = true;
          if (searchQueue && typeof searchQueue.setScrollPaused === "function") {
            searchQueue.setScrollPaused(true);
          }
        }
      }

      // Reset trailing settle debounce on every frame while scroll activity continues
      if (scrollSettleTimer !== null) clearTimeout(scrollSettleTimer);
      scrollSettleTimer = setTimeout(onScrollSettled, SCROLL_SETTLE_DEBOUNCE_MS);
    });
  }

  function onScrollSettled() {
    if (scrollSettleTimer !== null) {
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = null;
    }
    if (isScrollPaused) {
      isScrollPaused = false;
      if (searchQueue && typeof searchQueue.setScrollPaused === "function") {
        searchQueue.setScrollPaused(false);
      }
    }
  }

  // #18: mount priority for the badge, most to least preferred. This MUST be
  // tried one selector at a time. A single querySelector() with all three joined
  // by commas returns the first match in DOCUMENT ORDER, not the first selector
  // that matches — so on a card whose price element precedes its content column,
  // the badge lands in the narrow price box. That was invisible while the badge
  // was inline-flex and sized to its own text; once width is a percentage, the
  // container becomes the layout.
  const BADGE_CONTAINER_SELECTORS = [
    ".uitk-card-content",
    '[data-stid*="content"]',
    '[data-stid*="price"]',
  ];

  // Static query selector for search cards across desktop/mobile Vrbo layouts
  const DEFAULT_CARD_SELECTORS_QUERY = [
    '[data-stid="property-card"]',
    '[data-stid="lodging-card-responsive"]',
    '[data-testid="property-card"]',
    'article[data-stid*="card"]',
    'div[data-stid*="property-card"]',
  ].join(", ");

  function getSearchCardSelector() {
    const reg = siteRegistry;
    return reg?.getSearchCardSelector(location.href) || DEFAULT_CARD_SELECTORS_QUERY;
  }

  function resolveBadgeContainer(card) {
    const reg = siteRegistry;
    const selectors = reg?.getCardContentSelector(location.href) || BADGE_CONTAINER_SELECTORS;
    const list = Array.isArray(selectors) ? selectors : selectors.split(",").map((s) => s.trim());
    for (const selector of list) {
      const match = card.querySelector(selector);
      if (match) return match;
    }
    return card;
  }

  // Instrumentation for #23's gating condition. LOCAL ONLY: these are in-memory
  // counters, readable from the devtools console of this isolated world via
  // `__pawSearchStats()`. PRIVACY.md commits to no remote transmission of
  // browsing activity or analytics, so they are never written to
  // chrome.storage, never attached to a request, and never reported anywhere.
  const MAX_DEPTH_SAMPLES = 200;
  let searchStats = createEmptySearchStats();

  function createEmptySearchStats() {
    return {
      scans: 0,
      // Enqueue CALLS handed to the queue engine, not network requests. A call that
      // resolves from cache issues no fetch, so this is an upper bound on traffic.
      // For the true network count read `networkRequests` below.
      enqueued: 0,
      // Queue items actually withdrawn by remove() on viewport exit. This is I8b's
      // numerator in #23's "pruned by I8b versus dispatched" ratio.
      prunedOffscreen: 0,
      // Queue items actually withdrawn when a node was recycled to another property.
      prunedRecycled: 0,
      // CARDS dropped from tracking on an SPA re-render. Counted per card, not per
      // queue withdrawal, so it is NOT comparable to the two counters above.
      prunedStale: 0,
      lastQueueDepth: 0,
      maxQueueDepth: 0,
      depthSamples: [], // [{ t, depth, staged, reason }], bounded ring
      depthSamplesDropped: 0, // Samples evicted by the ring; nonzero means truncated history
    };
  }

  function resetSearchStats() {
    searchStats = createEmptySearchStats();
  }

  function sampleQueueDepth(reason) {
    if (!searchQueue || typeof searchQueue.getQueueLength !== "function") return;
    // enqueue() stages an item behind an async getCached() before pushing it to the
    // queue array, so getQueueLength() alone undercounts by whatever is still
    // staging — and under sustained scroll, which is the regime #23 gates on, that
    // is exactly when the staged population is nonzero. Record both.
    const queued = searchQueue.getQueueLength();
    const staged = typeof searchQueue.getPendingCount === "function"
      ? searchQueue.getPendingCount()
      : 0;
    const depth = queued + staged;
    searchStats.lastQueueDepth = depth;
    if (depth > searchStats.maxQueueDepth) searchStats.maxQueueDepth = depth;
    searchStats.depthSamples.push({ t: Date.now(), depth, staged, reason });
    if (searchStats.depthSamples.length > MAX_DEPTH_SAMPLES) {
      searchStats.depthSamples.shift();
      searchStats.depthSamplesDropped++;
    }
  }

  function getSearchStats() {
    return {
      ...searchStats,
      // Read through to the queue's own session counter: the number of requests
      // actually put on the wire. This is the denominator #23's gate needs, and it
      // is not the same as `enqueued`.
      networkRequests: searchQueue && typeof searchQueue.getSessionCount === "function"
        ? searchQueue.getSessionCount()
        : 0,
      depthSamples: searchStats.depthSamples.slice(),
    };
  }

  // Read-only devtools hook. Returns a copy; nothing here is persisted or sent.

  /**
   * Checks whether another live (connected) card DOM element currently shares
   * this property ID, lazily sweeping any detached/recycled nodes encountered
   * during iteration (deleting current elements in Set iteration is well-defined).
   */
  function anotherCardHasPropId(propId, exceptCard) {
    if (!propId) return false;
    const set = cardsByPropertyId.get(propId);
    if (!set || set.size === 0) return false;
    let hasAnother = false;
    for (const node of set) {
      // Lazy sweep: prune detached nodes so they don't linger across SPA re-renders
      if (!node || !node.isConnected) {
        set.delete(node);
      } else if (node !== exceptCard) {
        hasAnother = true;
      }
    }
    if (set.size === 0) cardsByPropertyId.delete(propId);
    return hasAnother;
  }

  // 8.1.1 Search-page Apollo fast path: before any listing-page request,
  // ask the page-world bridge for the exact PropertyInfo:<id> records the
  // search page already fetched. The response is delivered synchronously
  // during the request dispatch, so no card rendering is ever delayed on
  // it — when there is no usable record the path falls through to the
  // queue immediately.
  const discoveredSearchPropIds = new Set();
  let latestSearchApolloData = null;
  let searchApolloRequestId = 0;

  function requestSearchApolloData() {
    if (!discoveredSearchPropIds.size) return null;
    const requestId = ++searchApolloRequestId;
    const propertyIds = [];
    for (const id of discoveredSearchPropIds) {
      propertyIds.push(id);
      if (propertyIds.length === 40) break;
    }
    try {
      window.dispatchEvent(new CustomEvent("paw-search-apollo-request", { detail: { propertyIds, requestId } }));
    } catch (e) {
      return null;
    }
    // The bridge's response event fires synchronously inside the dispatch
    // above; only trust a payload answering THIS request.
    const payload = latestSearchApolloData || getSearchApolloData(requestId);
    return payload && payload.requestId === requestId ? payload : null;
  }

  function trySearchApolloFastPath(propId) {
    if (!propId) return null;
    const fetcher = globalThis.PawSearchFetcher;
    if (!fetcher) return null;
    discoveredSearchPropIds.add(propId);
    const payload = requestSearchApolloData();
    const record = payload && payload.results ? payload.results[propId] : null;
    if (!record || !Array.isArray(record.items) || !record.items.length) return null;
    const policy = typeof fetcher.resolveSearchApolloRecord === "function"
      ? fetcher.resolveSearchApolloRecord(record, propId, "search-page-state")
      : null;
    if (!policy) return null;
    return { status: "ok", propertyId: propId, policy, ts: Date.now(), _source: "search-page-state" };
  }

  function enqueueSearch(propId, url, priority = "normal") {
    const activeQueue = searchQueue;
    if (!activeQueue) return;

    try {
      const fast = trySearchApolloFastPath(propId);
      if (fast && globalThis.PawSearchFetcher?.hasConcretePolicy?.(fast.policy)) {
        const isRichOrDefinitive = fast.policy.petsAllowed === false ||
          fast.policy.maxDogs !== null ||
          fast.policy.weightLimit !== null ||
          fast.policy.fee !== null ||
          fast.policy.deposit !== null;

        if (isRichOrDefinitive) {
          activeQueue.setCached(propId, fast, { persist: false }).catch(() => {}).finally(() => {
            if (searchQueue && searchQueue === activeQueue && document.querySelector(`[data-paw-prop-id="${propId}"]`)) {
              activeQueue.enqueue(propId, url, priority);
            }
          });
          return;
        } else {
          // Preliminary instant render: paint preliminary badge immediately without blocking rich listing fetch
          const card = document.querySelector(`[data-paw-prop-id="${propId}"]`);
          const badge = card?.querySelector(".paw-search-badge");
          if (badge && badge.dataset.pawStatus === "loading") {
            updateBadgeUi(badge, fast);
          }
        }
      }
    } catch (e) {
      // Fall through to the normal queue path on any unexpected failure.
    }
    if (searchQueue && searchQueue === activeQueue) {
      activeQueue.enqueue(propId, url, priority);
      searchStats.enqueued++;
      sampleQueueDepth("enqueue");
    }
  }

  function clearTooltipLeaveTimer() {
    if (tooltipLeaveTimer) {
      clearTimeout(tooltipLeaveTimer);
      tooltipLeaveTimer = null;
    }
  }

  let isDismissingDialog = false;

  function scheduleTooltipHide(delayMs = 200) {
    clearTooltipLeaveTimer();
    tooltipLeaveTimer = setTimeout(() => {
      hideTooltip();
    }, delayMs);
  }

  function getListingValidation(urlStr) {
    if (globalThis.PawSearchFetcher?.validateListingUrl) {
      return globalThis.PawSearchFetcher.validateListingUrl(urlStr, location.href);
    }
    try {
      const u = new URL(urlStr, location.href);
      if (u.protocol !== "https:") return null;
      const registry = siteRegistry;
      if (!registry || !registry.isListingUrl(u.href)) return null;
      const propId = registry.getPropertyId(u.href);
      if (!propId) return null;
      const fetchUrl = registry.getCanonicalFetchUrl(u.href);
      return {
        propertyId: propId,
        navigationUrl: u.href,
        fetchUrl,
      };
    } catch {
      return null;
    }
  }

  function findCardListing(card) {
    const anchors = card.querySelectorAll("a[href]");
    for (const a of anchors) {
      const href = a.href || a.getAttribute("href");
      if (!href) continue;
      const validated = getListingValidation(href);
      if (validated) return validated;
    }
    return null;
  }

  function initSearchManager() {
    globalThis.__pawSearchStats = getSearchStats;
    if (!globalThis.PawSearchFetcher) return;
    if (!searchQueue) {
      searchQueue = globalThis.PawSearchFetcher.createSearchFetchQueue({
        storage: createSafeStorageWrapper()
      });
    }
    if (!searchTooltipEl) {
      searchTooltipEl = document.createElement("div");
      searchTooltipEl.id = "paw-search-tooltip";
      searchTooltipEl.className = "paw-search-tooltip";
      searchTooltipEl.setAttribute("role", "dialog");
      searchTooltipEl.setAttribute("aria-label", "Dog policy");
      searchTooltipEl.setAttribute("aria-hidden", "true");
      searchTooltipEl.style.display = "none";

      searchTooltipEl.addEventListener("mouseenter", () => {
        clearTooltipLeaveTimer();
      });
      searchTooltipEl.addEventListener("mouseleave", (e) => {
        if (e.relatedTarget && activeTooltipTarget?.contains(e.relatedTarget)) return;
        scheduleTooltipHide(200);
      });

      // Focus trap and Escape key listener inside dialog
      searchTooltipEl.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          const toFocus = activeTooltipTarget;
          isDismissingDialog = true;
          hideTooltip();
          toFocus?.focus();
          setTimeout(() => { isDismissingDialog = false; }, 150);
        } else if (e.key === "Tab") {
          const focusables = Array.from(searchTooltipEl.querySelectorAll('button, a[href], [tabindex="0"]')).filter(
            (el) => !el.disabled
          );
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey && (document.activeElement === first || !searchTooltipEl.contains(document.activeElement))) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && (document.activeElement === last || !searchTooltipEl.contains(document.activeElement))) {
            e.preventDefault();
            first.focus();
          }
        }
      });

      (document.body || document.documentElement).appendChild(searchTooltipEl);
    }

    const VIEWPORT_DWELL_MS = 400;
    // I4b: one-sided jitter, same rationale as the pacing jitter in the queue —
    // it only ever adds to the dwell, so the 400 ms floor is never undercut,
    // while a screenful of cards that enter the viewport together stops firing
    // its timers in unison.
    const VIEWPORT_DWELL_JITTER_MS = 200;

    if (!searchCardObserver) {
      searchCardObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const card = entry.target;
          if (entry.isIntersecting) {
            // I3: in-view state is read by the recycle path, which must not
            // enqueue for a card the user cannot see.
            card._pawInView = true;
            if (card._pawDwellTimer) {
              clearTimeout(card._pawDwellTimer);
              card._pawDwellTimer = null;
            }
            // Dwell debounce: only enqueue after card remains in viewport for
            // VIEWPORT_DWELL_MS (plus this card's own jitter).
            const dwellMs = VIEWPORT_DWELL_MS + Math.random() * VIEWPORT_DWELL_JITTER_MS;
            card._pawDwellTimer = setTimeout(() => {
              card._pawDwellTimer = null;
              const propId = card.getAttribute("data-paw-prop-id");
              const fetchUrl = card.getAttribute("data-paw-fetch-url") || card.getAttribute("data-paw-url");
              if (propId && fetchUrl && searchQueue && card.isConnected) {
                enqueueSearch(propId, fetchUrl, "normal");
              }
            }, dwellMs);
          } else {
            card._pawInView = false;
            // Scrolled out of viewport before dwell threshold: cancel background request
            if (card._pawDwellTimer) {
              clearTimeout(card._pawDwellTimer);
              card._pawDwellTimer = null;
            }
            // I8b: the timer is only half of it. Once the dwell has elapsed the
            // work lives in the queue, so a card that leaves the viewport must
            // also withdraw its queued item. remove() is a no-op for an id that
            // is already in flight, which is the correct boundary: that request
            // is on the wire and cancelling it buys nothing.
            const propId = card.getAttribute("data-paw-prop-id");
            if (propId && searchQueue && typeof searchQueue.remove === "function") {
              if (searchQueue.remove(propId)) {
                searchStats.prunedOffscreen++;
                sampleQueueDepth("prune-offscreen");
              }
            }
          }
        }
      }, { rootMargin: "150px 0px" });
    }

    if (!scrollListenersAttached && typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("scroll", onWindowScroll, { passive: true });
      if ("onscrollend" in window) {
        window.addEventListener("scrollend", onScrollSettled, { passive: true });
      }
      scrollListenersAttached = true;
    }

    scanSearchCards();
  }

  function cleanupSearchManager() {
    hideTooltip();
    discoveredSearchPropIds.clear();
    trackedSearchCards.clear();
    cardsByPropertyId.clear();
    if (searchScanThrottleTimer) {
      clearTimeout(searchScanThrottleTimer);
      searchScanThrottleTimer = null;
    }
    lastSearchScanAt = 0;
    if (scrollRafId !== null) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
    }
    if (scrollSettleTimer !== null) {
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = null;
    }
    if (scrollListenersAttached && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("scroll", onWindowScroll);
      if ("onscrollend" in window) {
        window.removeEventListener("scrollend", onScrollSettled);
      }
      scrollListenersAttached = false;
    }
    lastScrollY = 0;
    lastScrollTime = 0;
    isScrollPaused = false;
    // Counters are queue-scoped: they reset with the queue they describe.
    resetSearchStats();
    latestSearchApolloData = null;
    if (searchQueue) {
      searchQueue.dispose();
      searchQueue = null;
    }
    if (searchCardObserver) {
      searchCardObserver.disconnect();
      searchCardObserver = null;
    }
    const badges = document.querySelectorAll(".paw-search-badge");
    for (const b of badges) b.remove();
    const cards = document.querySelectorAll("[data-paw-prop-id]");
    for (const c of cards) {
      if (c._pawDwellTimer) {
        clearTimeout(c._pawDwellTimer);
        c._pawDwellTimer = null;
      }
      if (c._pawUnsub) {
        c._pawUnsub();
        c._pawUnsub = null;
      }
      c._pawInView = false;
      c.removeAttribute("data-paw-prop-id");
      c.removeAttribute("data-paw-url");
      c.removeAttribute("data-paw-fetch-url");
      c.removeAttribute("data-paw-nav-url");
    }
    if (searchTooltipEl) {
      searchTooltipEl.remove();
      searchTooltipEl = null;
    }
  }

  // I9: leading-edge throttle in front of scanSearchCards(). Vrbo's search
  // results mutate in long bursts (image swaps, price re-renders); before this,
  // every qualifying mutation ran a full re-scan.
  function requestSearchScan() {
    const now = Date.now();
    const sinceLast = now - lastSearchScanAt;
    if (sinceLast >= SEARCH_SCAN_THROTTLE_MS) {
      lastSearchScanAt = now;
      scanSearchCards();
      return;
    }
    if (searchScanThrottleTimer) return; // burst already has a trailing scan booked
    searchScanThrottleTimer = setTimeout(() => {
      searchScanThrottleTimer = null;
      lastSearchScanAt = Date.now();
      scanSearchCards();
    }, SEARCH_SCAN_THROTTLE_MS - sinceLast);
  }

  /**
   * I7: drop per-card state for property ids whose card has left the DOM, which
   * is what a search -> search re-render leaves behind.
   *
   * Deliberately NOT clearQueue(): that resets sessionRequestsCount to 0, and
   * the session budget has to survive search -> search — otherwise a user who
   * re-searches repeatedly gets an unbounded request allowance.
   *
   * Tearing down the subscription is not optional either. remove() only drops
   * *queued* work; a request already in flight for a pruned id still resolves
   * and calls notify(), which would repaint a card that has already moved on.
   */
  function pruneStaleSearchCards() {
    if (!searchQueue) return 0;
    let pruned = 0;
    for (const [propId, card] of Array.from(trackedSearchCards.entries())) {
      const boundId = card && typeof card.getAttribute === "function"
        ? card.getAttribute("data-paw-prop-id")
        : null;
      if (card && card.isConnected && boundId === propId) continue;

      // Only tear down the card's subscription when the card is still bound to
      // THIS id. If the node was recycled to a different property, _pawUnsub
      // belongs to the new binding and the old one was already released.
      if (card && boundId === propId) {
        if (card._pawUnsub) {
          try { card._pawUnsub(); } catch {}
          card._pawUnsub = null;
        }
        if (card._pawDwellTimer) {
          clearTimeout(card._pawDwellTimer);
          card._pawDwellTimer = null;
        }
        card._pawInView = false;
        if (searchCardObserver) {
          try { searchCardObserver.unobserve(card); } catch {}
        }
      }
      if (!anotherCardHasPropId(propId, card)) {
        searchQueue.remove(propId);
        discoveredSearchPropIds.delete(propId);
      }
      untrackCardPropId(propId, card);
      trackedSearchCards.delete(propId);
      pruned++;
    }
    if (pruned) {
      searchStats.prunedStale += pruned;
      sampleQueueDepth("prune-stale");
    }
    return pruned;
  }

  function scanSearchCards() {
    if (!isSearchUrl(location.href)) return;
    searchStats.scans++;
    const cards = document.querySelectorAll(getSearchCardSelector());
    for (const card of cards) {
      bindSearchCard(card);
    }
    // Cards the re-render dropped are stale the moment they leave the DOM.
    pruneStaleSearchCards();
  }

  function bindSearchCard(card) {
    const listing = findCardListing(card);
    if (!listing) return;
    const { propertyId: propId, fetchUrl, navigationUrl } = listing;

    const prevId = card.getAttribute("data-paw-prop-id");
    let badge = card.querySelector(".paw-search-badge");

    // Same property, same badge, subscription intact: nothing to rewire.
    // A missing _pawUnsub means a prune tore this card down while it was out of
    // the DOM, so fall through and re-subscribe — the propId is unchanged, so
    // the fall-through re-binds without issuing a new request.
    if (prevId === propId && badge && card._pawUnsub) {
      card.setAttribute("data-paw-fetch-url", fetchUrl);
      card.setAttribute("data-paw-nav-url", navigationUrl);
      card.setAttribute("data-paw-url", fetchUrl);
      trackedSearchCards.set(propId, card);
      trackCardPropId(propId, card);
      return;
    }

    // Clean up previous subscription and dwell timer if card was recycled
    if (card._pawDwellTimer) {
      clearTimeout(card._pawDwellTimer);
      card._pawDwellTimer = null;
    }
    if (card._pawUnsub) {
      card._pawUnsub();
      card._pawUnsub = null;
    }

    // The property this node used to show is stale work now: withdraw its
    // queued item too, unless some other live card still displays it.
    if (prevId && prevId !== propId) {
      if (trackedSearchCards.get(prevId) === card) trackedSearchCards.delete(prevId);
      untrackCardPropId(prevId, card);
      if (searchQueue && typeof searchQueue.remove === "function" && !anotherCardHasPropId(prevId, card)) {
        if (searchQueue.remove(prevId)) {
          searchStats.prunedRecycled++;
          sampleQueueDepth("prune-recycled");
        }
      }
    }

    card.setAttribute("data-paw-prop-id", propId);
    card.setAttribute("data-paw-fetch-url", fetchUrl);
    card.setAttribute("data-paw-nav-url", navigationUrl);
    card.setAttribute("data-paw-url", fetchUrl);
    discoveredSearchPropIds.add(propId);
    trackedSearchCards.set(propId, card);
    trackCardPropId(propId, card);

    // Watch visibility for prefetching
    if (searchCardObserver) {
      try { searchCardObserver.unobserve(card); } catch {}
      searchCardObserver.observe(card);
    }

    if (!badge) {
      badge = document.createElement("div");
      badge.className = "paw-search-badge paw-badge-loading";
      badge.setAttribute("tabindex", "0");
      badge.setAttribute("role", "button");
      badge.setAttribute("aria-haspopup", "dialog");
      badge.setAttribute("aria-controls", "paw-search-tooltip");
      badge.setAttribute("aria-expanded", "false");
      badge.setAttribute("aria-label", "Checking pet policy");
      badge.dataset.pawStatus = "loading";
      badge.dataset.pawText = "Checking pet policy...";
      badge.textContent = "⏳ Checking pet policy...";

      const targetContainer = resolveBadgeContainer(card);
      if (targetContainer !== card) {
        targetContainer.style.position = "relative";
        targetContainer.style.zIndex = "2";
        targetContainer.style.pointerEvents = "auto";
      }
      // #18: the badge goes in a slot the extension owns, not straight into
      // Vrbo's container. width: 100% on the badge would only behave if that
      // container happened to be a block; the slot makes the badge's width
      // independent of whether the host is block, flex-row, flex-column or grid.
      const slot = document.createElement("div");
      slot.className = "paw-badge-slot";
      slot.appendChild(badge);
      targetContainer.appendChild(slot);

      // Dynamic handlers read card data attributes at event time
      badge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currentId = card.getAttribute("data-paw-prop-id");
        const currentFetchUrl = card.getAttribute("data-paw-fetch-url") || card.getAttribute("data-paw-url");
        const currentNavUrl = card.getAttribute("data-paw-nav-url") || currentFetchUrl;
        if (currentId && currentFetchUrl) {
          showTooltipForBadge(badge, currentId, currentNavUrl, false);
        }
      });
      badge.addEventListener("mouseenter", () => {
        const currentId = card.getAttribute("data-paw-prop-id");
        const currentFetchUrl = card.getAttribute("data-paw-fetch-url") || card.getAttribute("data-paw-url");
        const currentNavUrl = card.getAttribute("data-paw-nav-url") || currentFetchUrl;
        if (currentId && currentFetchUrl) onBadgeHover(badge, currentId, currentFetchUrl, currentNavUrl, true);
      });
      badge.addEventListener("mouseleave", onBadgeLeave);
      badge.addEventListener("focus", () => {
        if (isDismissingDialog) return;
        const currentId = card.getAttribute("data-paw-prop-id");
        const currentFetchUrl = card.getAttribute("data-paw-fetch-url") || card.getAttribute("data-paw-url");
        const currentNavUrl = card.getAttribute("data-paw-nav-url") || currentFetchUrl;
        if (currentId && currentFetchUrl) onBadgeHover(badge, currentId, currentFetchUrl, currentNavUrl, true);
      });
      badge.addEventListener("blur", (e) => {
        if (e.relatedTarget && searchTooltipEl?.contains(e.relatedTarget)) return;
        scheduleTooltipHide(150);
      });
      badge.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const currentId = card.getAttribute("data-paw-prop-id");
          const currentFetchUrl = card.getAttribute("data-paw-fetch-url") || card.getAttribute("data-paw-url");
          const currentNavUrl = card.getAttribute("data-paw-nav-url") || currentFetchUrl;
          if (currentId && currentFetchUrl) {
            showTooltipForBadge(badge, currentId, currentNavUrl, true);
          }
        } else if (e.key === "Escape") {
          hideTooltip();
        }
      });
    } else if (prevId && prevId !== propId) {
      // Recycled node: dismiss open dialog if it was for previous entity, and reset old display
      if (activeTooltipTarget === badge || activeTooltipPropId === prevId) {
        hideTooltip();
      }
      badge.dataset.pawStatus = "loading";
      badge.dataset.pawText = "Checking pet policy...";
      badge.className = "paw-search-badge paw-badge-loading";
      badge.textContent = "⏳ Checking pet policy...";
      badge.setAttribute("aria-label", "Checking pet policy");
      // I3: a recycled node inherits the viewport state of the node, not of the
      // property. Enqueue only when that node is actually on screen — an
      // off-screen recycle re-binds silently and waits for the dwell gate to
      // fire when the card is scrolled into view.
      if (card._pawInView === true) {
        enqueueSearch(propId, fetchUrl, "normal");
      }
    }

    card._pawUnsub = searchQueue?.subscribe(propId, (data) => {
      if (card.getAttribute("data-paw-prop-id") === propId && badge.isConnected) {
        updateBadgeUi(badge, data);
        // Live dialog update: if dialog is currently open for this badge, rerender in place
        if (
          activeTooltipTarget === badge &&
          activeTooltipPropId === propId &&
          searchTooltipEl &&
          searchTooltipEl.style.display !== "none"
        ) {
          const navUrl = card.getAttribute("data-paw-nav-url") || card.getAttribute("data-paw-url");
          renderTooltipContent(data, navUrl, propId, false);
          positionTooltip(badge);
        }
      }
    });

    searchQueue?.getCached(propId, fetchUrl).then((cached) => {
      if (cached && card.getAttribute("data-paw-prop-id") === propId) {
        updateBadgeUi(badge, cached);
      }
    });
  }

  function updateBadgeUi(badge, data) {
    if (!badge || !data) return;

    const extractLib = globalThis.PawExtract;
    let badgeInfo = null;

    if (data.status === "ok" && data.policy && extractLib?.deriveSearchBadge) {
      badgeInfo = extractLib.deriveSearchBadge(data.policy);
    } else if (data.status === "capped") {
      badgeInfo = {
        statusKey: "capped",
        icon: "🐾",
        text: "Hover or open listing",
        className: "paw-search-badge paw-badge-capped",
      };
    } else {
      badgeInfo = {
        statusKey: data.status || "unknown",
        icon: "🐾",
        text: "Check pet rules on listing",
        className: "paw-search-badge paw-badge-unknown",
      };
    }

    if (badge.dataset.pawStatus === badgeInfo.statusKey && badge.dataset.pawText === badgeInfo.text) return;
    badge.dataset.pawStatus = badgeInfo.statusKey;
    badge.dataset.pawText = badgeInfo.text;
    // Report where this result came from: the search page's own Apollo
    // state (no listing fetch) or a listing-page fetch.
    badge.dataset.pawSource = data.status === "ok"
      ? (data._source || "listing-fetch")
      : (data.status || "unknown");
    badge.className = badgeInfo.className;
    badge.setAttribute("aria-label", badgeInfo.text);

    badge.textContent = "";
    const iconSpan = document.createElement("span");
    iconSpan.className = "paw-badge-icon";
    iconSpan.textContent = badgeInfo.icon;
    const textSpan = document.createElement("span");
    textSpan.className = "paw-badge-text";
    textSpan.textContent = " " + badgeInfo.text;
    badge.appendChild(iconSpan);
    badge.appendChild(textSpan);
  }

  function onBadgeHover(badge, propId, fetchUrl, navUrl, isHighPriority) {
    clearTooltipLeaveTimer();
    const parentCard = badge.closest ? badge.closest("[data-paw-prop-id]") : null;
    if (parentCard && parentCard._pawDwellTimer) {
      clearTimeout(parentCard._pawDwellTimer);
      parentCard._pawDwellTimer = null;
    }
    if (isHighPriority && searchQueue) {
      enqueueSearch(propId, fetchUrl, "high");
    }
    showTooltipForBadge(badge, propId, navUrl || fetchUrl, false);
  }

  function onBadgeLeave(e) {
    if (e.relatedTarget && searchTooltipEl?.contains(e.relatedTarget)) return;
    scheduleTooltipHide(200);
  }

  function showTooltipForBadge(badge, propId, url, isKeyboard = false) {
    if (!searchTooltipEl) return;
    clearTooltipLeaveTimer();
    activeTooltipTarget = badge;
    activeTooltipPropId = propId;
    badge.setAttribute("aria-expanded", "true");

    searchQueue?.getCached(propId, url).then((cached) => {
      // Async scope guard: verify active target, propId, element connectivity, and parent card propId
      const parentCard = badge.closest ? badge.closest("[data-paw-prop-id]") : null;
      if (
        activeTooltipTarget !== badge ||
        activeTooltipPropId !== propId ||
        !badge.isConnected ||
        (parentCard && parentCard.getAttribute("data-paw-prop-id") !== propId)
      ) {
        return;
      }
      renderTooltipContent(cached, url, propId, isKeyboard);
      positionTooltip(badge);
    });
  }

  function renderTooltipContent(data, url, propId, isKeyboard = false) {
    if (!searchTooltipEl) return;
    const hadFocusInside = document.activeElement && searchTooltipEl.contains(document.activeElement);
    searchTooltipEl.textContent = "";

    const header = document.createElement("div");
    header.className = "paw-tooltip-header";
    const titleSpan = document.createElement("span");
    titleSpan.textContent = "Dog policy";
    const closeBtn = document.createElement("button");
    closeBtn.className = "paw-tooltip-close";
    closeBtn.setAttribute("aria-label", "Close details");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      const toFocus = activeTooltipTarget;
      isDismissingDialog = true;
      hideTooltip();
      toFocus?.focus();
      setTimeout(() => { isDismissingDialog = false; }, 150);
    });
    header.appendChild(titleSpan);
    header.appendChild(closeBtn);
    searchTooltipEl.appendChild(header);

    const addRow = (label, valueText, toneClass, valueLines = null) => {
      const row = document.createElement("div");
      row.className = "paw-tooltip-row";
      const lbl = document.createElement("span");
      lbl.className = "paw-tooltip-label";
      lbl.textContent = label;
      const val = document.createElement("span");
      val.className = "paw-tooltip-val" + (toneClass ? " " + toneClass : "");
      if (Array.isArray(valueLines) && valueLines.length > 0) {
        for (const line of valueLines) {
          const lineSpan = document.createElement("span");
          lineSpan.className = "paw-tooltip-val-line";
          lineSpan.textContent = line;
          val.appendChild(lineSpan);
        }
      } else {
        val.textContent = valueText;
      }
      row.appendChild(lbl);
      row.appendChild(val);
      searchTooltipEl.appendChild(row);
    };

    const p = (data && data.policy) ? data.policy : data;

    if (!data || data.status === "loading") {
      const row = document.createElement("div");
      row.className = "paw-tooltip-row";
      const val = document.createElement("span");
      val.className = "paw-tooltip-val";
      val.textContent = "Checking the listing summary for pet rules...";
      row.appendChild(val);
      searchTooltipEl.appendChild(row);
    } else if (p && (data.status === "ok" || p.petsAllowed !== undefined || p.restrictionsFound !== undefined || p.maxDogs !== undefined || p.fee !== undefined)) {

      let rowsAdded = 0;

      if (p.petsAllowed !== null) {
        const statusText = p.petsAllowed === true ? "Yes" : "No";
        const statusTone = p.petsAllowed === true ? "paw-tone-good" : "paw-tone-bad";
        addRow("Dogs allowed", statusText, statusTone);
        rowsAdded++;
      } else if (p.approvalRequired || p.restrictionsFound || (p.restrictionNoteCount && p.restrictionNoteCount > 0)) {
        addRow("Pet policy", "Pet restrictions apply", "paw-tone-warn");
        rowsAdded++;
      }
      if (p.maxDogs !== null) {
        addRow("Maximum dogs", String(p.maxDogs));
        rowsAdded++;
      }
      if (p.weightLimit) {
        const unitStr = p.weightLimit.unit === "lb" ? "lbs" : p.weightLimit.unit;
        addRow("Weight limit", `${p.weightLimit.value} ${unitStr}`);
        rowsAdded++;
      } else if (p.weightPerDog) {
        addRow("Weight limit", String(p.weightPerDog));
        rowsAdded++;
      }
      const isTieredFee = p.fee?.tiered || (p.fee?.text && /\$0\s+(?:1st|first)/i.test(p.fee.text));
      if (isTieredFee) {
        if (p.fee?.text) {
          addRow("Pet fee", p.fee.text, "paw-tone-warn");
        } else {
          addRow("Pet fee", "", "paw-tone-warn", ["1st dog free", "subsequent fee applies"]);
        }
        rowsAdded++;
      } else if (p.fee && p.fee.amount !== null) {
        const curSym = p.fee.currency === "USD" ? "$" : `${p.fee.currency} `;
        let perStr = "";
        if (p.fee.perPet && p.fee.period && p.fee.period !== "unknown" && p.fee.period !== "pet") {
          perStr = ` per pet per ${p.fee.period}`;
        } else if (p.fee.period && p.fee.period !== "unknown") {
          perStr = ` per ${p.fee.period}`;
        }
        addRow("Pet fee", `${curSym}${p.fee.amount}${perStr}`);
        rowsAdded++;
      } else if (p.fee) {
        const feeText = typeof p.fee === "string" ? p.fee : (p.fee.text || "Pet fee applies");
        addRow("Pet fee", feeText, "paw-tone-warn");
        rowsAdded++;
      }
      if (p.deposit && p.deposit.amount !== null) {
        const curSym = p.deposit.currency === "USD" ? "$" : `${p.deposit.currency} `;
        addRow("Pet deposit", `${curSym}${p.deposit.amount}`);
        rowsAdded++;
      } else if (p.deposit) {
        const depText = typeof p.deposit === "string" ? p.deposit : (p.deposit.text || "Deposit applies");
        addRow("Pet deposit", depText, "paw-tone-warn");
        rowsAdded++;
      }
      if (p.approvalRequired === true || p.preReg === true) {
        addRow("Prior approval", "Required", "paw-tone-warn");
        rowsAdded++;
      }

      if (rowsAdded === 0) {
        addRow("Pet policy", "Check listing for complete rules");
      }

      // Contradiction summary
      const hasConflict = p.contradictions?.maxDogs ||
        p.contradictions?.weightLimit ||
        p.contradictions?.fee ||
        p.maxDogsAlternates?.length ||
        p.weightAlternates?.length ||
        p.feeAlternates?.length;

      if (hasConflict) {
        const warnBox = document.createElement("div");
        warnBox.className = "paw-tooltip-notes paw-tone-warn";
        warnBox.innerHTML = "⚠️ <strong>Some pet-policy details conflict.</strong><br>Open the listing to verify the complete rules.";
        searchTooltipEl.appendChild(warnBox);
      }
    } else if (data.status === "rate_limited") {
      const row = document.createElement("div");
      row.className = "paw-tooltip-row";
      const val = document.createElement("span");
      val.className = "paw-tooltip-val";
      val.textContent = "Pet policy lookup paused due to request limits.";
      row.appendChild(val);
      searchTooltipEl.appendChild(row);
    } else if (data.status === "capped") {
      const row = document.createElement("div");
      row.className = "paw-tooltip-row";
      const val = document.createElement("span");
      val.className = "paw-tooltip-val";
      val.textContent = "Background check paused to protect session limits.";
      row.appendChild(val);
      searchTooltipEl.appendChild(row);
    } else {
      // Unavailable / Fallback (unknown, timeout, error)
      const row = document.createElement("div");
      row.className = "paw-tooltip-row";
      const val = document.createElement("span");
      val.className = "paw-tooltip-val";
      val.textContent = "Pet policy details were not available in the search result.";
      row.appendChild(val);
      searchTooltipEl.appendChild(row);
    }

    const footer = document.createElement("div");
    footer.className = "paw-tooltip-footer";
    const link = document.createElement("a");
    const registry = siteRegistry;
    if (typeof url === "string" && ((registry && registry.isListingUrl(url, location.href)) || url.startsWith("/"))) {
      link.href = url;
    } else {
      link.href = "#";
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open listing for complete rules ↗";
    footer.appendChild(link);
    searchTooltipEl.appendChild(footer);

    if (isKeyboard || hadFocusInside) {
      setTimeout(() => closeBtn.focus(), 10);
    }
  }

  function positionTooltip(badge) {
    if (!searchTooltipEl || !badge) return;
    searchTooltipEl.style.display = "block";
    const rect = badge.getBoundingClientRect();
    const tooltipHeight = searchTooltipEl.offsetHeight || 180;
    const tooltipWidth = 290;

    let top = rect.bottom + 4;
    if (top + tooltipHeight > window.innerHeight - 10) {
      top = Math.max(10, rect.top - tooltipHeight - 4);
    }

    let left = rect.left;
    if (left + tooltipWidth > window.innerWidth - 16) {
      left = Math.max(16, window.innerWidth - tooltipWidth - 16);
    }

    searchTooltipEl.style.top = `${top}px`;
    searchTooltipEl.style.left = `${left}px`;
    searchTooltipEl.classList.add("paw-tooltip-visible");
    searchTooltipEl.setAttribute("aria-hidden", "false");
  }

  function hideTooltip() {
    clearTooltipLeaveTimer();
    if (searchTooltipEl) {
      searchTooltipEl.classList.remove("paw-tooltip-visible");
      searchTooltipEl.setAttribute("aria-hidden", "true");
      searchTooltipEl.style.display = "none";
      if (activeTooltipTarget) {
        activeTooltipTarget.setAttribute("aria-expanded", "false");
        activeTooltipTarget = null;
        activeTooltipPropId = null;
      }
    }
  }


    return {
      start: initSearchManager,
      stop: cleanupSearchManager,
      scan: scanSearchCards,
      requestScan: requestSearchScan,
      isActive: () => Boolean(searchQueue),
      prune: pruneStaleSearchCards,
      hideTooltip,
      setApolloData: (payload) => { latestSearchApolloData = payload; },
      __test: {
        initSearchManager,
        cleanupSearchManager,
        scanSearchCards,
        bindSearchCard,
        updateBadgeUi,
        renderTooltipContent,
        positionTooltip,
        showTooltipForBadge,
        scheduleTooltipHide,
        getListingValidation,
        findCardListing,
        resolveBadgeContainer,
        requestSearchApolloData,
        trySearchApolloFastPath,
        enqueueSearch,
        sampleQueueDepth,
        trackCardPropId,
        untrackCardPropId,
        requestSearchScan,
        pruneStaleSearchCards,
        getSearchStats,
        getSearchQueue: () => searchQueue,
        getTrackedSearchCards: () => trackedSearchCards,
        getSearchCardObserver: () => searchCardObserver,
        getSearchTooltip: () => searchTooltipEl,
        SEARCH_SCAN_THROTTLE_MS,
        onWindowScroll,
        onScrollSettled,
        getIsScrollPaused: () => isScrollPaused,
        getScrollListenersAttached: () => scrollListenersAttached,
        SCROLL_VELOCITY_THRESHOLD_PX_S,
        SCROLL_SETTLE_DEBOUNCE_MS,
      },
    };
  }

  return { createSearchBadges };
});
