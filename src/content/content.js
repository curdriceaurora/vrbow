// Content-script controller: owns shared state and routes module events.
(() => {
  function getSiteRegistry() {
    if (globalThis.PawSiteRegistry) return globalThis.PawSiteRegistry;
    console.warn("[vrbow] PawSiteRegistry is unavailable; check script load order");
    return null;
  }

  const registry = getSiteRegistry();
  const lifecycleApi = globalThis.PawLifecycle || (
    typeof require === "function" ? require("./lifecycle.js") : null
  );
  const panelApi = globalThis.PawPdpPanel || (
    typeof require === "function" ? require("./pdp-panel.js") : null
  );
  const searchApi = globalThis.PawSearchBadges || (
    typeof require === "function" ? require("./search-badges.js") : null
  );

  let lifecycle;
  let pdpPanel;
  let searchBadges;
  let rescanTimer = null;
  let lastPolicy = null;
  let apolloDataListener = null;
  let searchApolloDataListener = null;

  function isListingUrl(url) {
    return registry?.isListingUrl(url || location.href) || false;
  }

  function isSearchUrl(url) {
    return registry?.isSearchUrl(url || location.href) || false;
  }

  function classifyUrl(url) {
    if (isSearchUrl(url)) return "search";
    if (isListingUrl(url)) return "listing";
    return "other";
  }

  function scheduleRescan(delay) {
    if (rescanTimer !== null) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => pdpPanel.scan(false), delay);
  }

  async function withMutationsSuppressed(work) {
    lifecycle.setMutationSuppressed(true);
    try {
      return await work();
    } finally {
      lifecycle.setMutationSuppressed(false);
    }
  }

  function searchEnabled(callback) {
    lifecycle.storage.get(["paw_enable_search_badging"], (data) => {
      callback(data?.paw_enable_search_badging === true);
    });
  }

  function handleNavigate({ previousUrl, pageKind }) {
    searchBadges.hideTooltip();
    if (pageKind === "search") {
      pdpPanel.reset();
      if (previousUrl) searchBadges.prune();
      searchEnabled((enabled) => {
        if (enabled) searchBadges.start();
      });
      return;
    }

    searchBadges.stop();
    pdpPanel.reset();
    if (pageKind !== "listing") return;
    window.dispatchEvent(new CustomEvent("vdp-request-apollo-data"));
    scheduleRescan(previousUrl ? 1200 : 1000);
    setTimeout(() => pdpPanel.scan(false), previousUrl ? 3200 : 3500);
  }

  function handleMutate({ isSearchPage, elapsedMs }) {
    if (isSearchPage) {
      if (searchBadges.isActive()) searchBadges.requestScan();
      return;
    }
    scheduleRescan(elapsedMs > 4000 ? 0 : 900);
  }

  function handleInvalidate() {
    if (rescanTimer !== null) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
    if (apolloDataListener) window.removeEventListener("vdp-apollo-data", apolloDataListener);
    if (searchApolloDataListener) window.removeEventListener("vdp-search-apollo-data", searchApolloDataListener);
    searchBadges.stop();
    pdpPanel.reset();
  }

  lifecycle = lifecycleApi.createLifecycle({
    classifyUrl,
    isSearchUrl,
    onNavigate: handleNavigate,
    onMutate: handleMutate,
    onInvalidate: handleInvalidate,
  });

  pdpPanel = panelApi.createPdpPanel({
    siteRegistry: registry,
    getListingIdFromUrl: (url) => registry?.getPropertyId(url || location.href) || null,
    isListingUrl,
    looksLikeListingPage: () => isListingUrl(location.href),
    safeStorageSet: (data) => lifecycle.storage.set(data),
    scheduleRescan,
    withMutationsSuppressed,
    onPolicy: ({ policy }) => {
      lastPolicy = policy;
      window.__pawLastPolicy = policy;
    },
  });

  searchBadges = searchApi.createSearchBadges({
    createSafeStorageWrapper: () => lifecycle.storage,
    siteRegistry: registry,
    isSearchUrl,
  });

  apolloDataListener = (event) => {
    if (!lifecycle.isContextValid()) {
      lifecycle.__test.invalidate();
      return;
    }
    pdpPanel.setApolloData(event.detail);
    scheduleRescan(150);
  };
  window.addEventListener("vdp-apollo-data", apolloDataListener);

  searchApolloDataListener = (event) => {
    if (!lifecycle.isContextValid()) {
      lifecycle.__test.invalidate();
      return;
    }
    searchBadges.setApolloData(event.detail);
  };
  window.addEventListener("vdp-search-apollo-data", searchApolloDataListener);

  try {
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (!lifecycle.isContextValid()) {
        lifecycle.__test.invalidate();
        return;
      }
      if (area !== "local" || !changes.paw_enable_search_badging || !isSearchUrl(location.href)) return;
      if (changes.paw_enable_search_badging.newValue === true) {
        searchBadges.start();
      } else {
        searchBadges.stop();
      }
    });
  } catch (error) {
    if (error?.message?.includes("Extension context invalidated")) {
      lifecycle.__test.invalidate();
    } else {
      console.warn("vrbow: unexpected error registering storage listener", error);
    }
  }

  try {
    chrome.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
      if (!lifecycle.isContextValid()) {
        lifecycle.__test.invalidate();
        return;
      }
      if (message?.type === "vdp-get-policy") {
        sendResponse({ policy: lastPolicy, url: location.href });
      } else if (message?.type === "vdp-rescan") {
        pdpPanel.scan(true).then(() => {
          if (lifecycle.isContextValid()) sendResponse({ policy: lastPolicy });
        });
        return true;
      } else if (message?.type === "vdp-test-trigger-invalidation") {
        lifecycle.__test.invalidate("test");
        sendResponse({ ok: true });
      }
      return true;
    });
  } catch (error) {
    if (error?.message?.includes("Extension context invalidated")) {
      lifecycle.__test.invalidate();
    } else {
      console.warn("vrbow: unexpected error registering runtime listener", error);
    }
  }

  lifecycle.start();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      __test: {
        onUrlMaybeChanged: lifecycle.__test.checkUrl,
        withMutationsSuppressed,
        handleNavigate,
        handleMutate,
        handleInvalidate,
        getSiteRegistry,
        getLifecycle: () => lifecycle,
        getPanel: () => pdpPanel,
        getSearchBadges: () => searchBadges,
      },
    };
  }
})();
