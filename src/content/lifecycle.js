// Content-script context, storage, URL, and DOM mutation lifecycle.
(function initLifecycle(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PawLifecycle = api;
  }
})(globalThis, (root) => {
  const INTERNAL_SELECTOR = ".paw-search-badge, .paw-search-tooltip, .paw-badge-slot, #paw-panel";

  function createLifecycle(deps = {}) {
    const win = deps.window || root.window;
    const doc = deps.document || root.document;
    const extension = deps.chrome || root.chrome;
    const currentLocation = deps.location || root.location;
    const Observer = deps.MutationObserver || root.MutationObserver;
    const classifyUrl = deps.classifyUrl || (() => "other");
    const isSearchUrl = deps.isSearchUrl || (() => false);
    const onNavigate = deps.onNavigate || (() => {});
    const onMutate = deps.onMutate || (() => {});
    const onInvalidate = deps.onInvalidate || (() => {});

    let currentUrl = currentLocation.href;
    let urlTimer = null;
    let observer = null;
    let popstateListener = null;
    let locationListener = null;
    let suppressionDepth = 0;
    let mutationFirstSeenAt = 0;
    let started = false;
    let invalidated = false;

    function isContextValid() {
      try {
        return Boolean(extension?.runtime && extension.runtime.id !== null);
      } catch {
        return false;
      }
    }

    function stop() {
      if (urlTimer !== null) {
        clearInterval(urlTimer);
        urlTimer = null;
      }
      observer?.disconnect();
      observer = null;
      if (popstateListener) {
        win.removeEventListener("popstate", popstateListener);
      }
      if (locationListener) {
        win.removeEventListener("paw-locationchange", locationListener);
      }
      popstateListener = null;
      locationListener = null;
      mutationFirstSeenAt = 0;
      suppressionDepth = 0;
      started = false;
    }

    function invalidate(reason = "extension-context") {
      if (invalidated) return;
      invalidated = true;
      stop();
      onInvalidate({ reason });
    }

    function handleError(error, operation) {
      if (error?.message?.includes("Extension context invalidated")) {
        invalidate();
        return;
      }
      console.warn(`pawcheck: unexpected error in ${operation}`, error);
    }

    function storageCall(method, positionalArgs, callback) {
      if (!isContextValid()) {
        invalidate();
        return;
      }
      const wrappedCallback = (...callbackArgs) => {
        if (!isContextValid()) {
          invalidate();
          return;
        }
        const lastError = extension.runtime?.lastError;
        if (lastError) {
          handleError(new Error(lastError.message || String(lastError)), `storage.${method}`);
        }
        callback?.(...callbackArgs);
      };
      try {
        extension.storage?.local?.[method]?.(...positionalArgs, wrappedCallback);
      } catch (error) {
        handleError(error, `storage.${method}`);
      }
    }

    const storage = {
      get(keys, callback) {
        storageCall("get", [keys], callback);
      },
      set(values, callback) {
        storageCall("set", [values], callback);
      },
      remove(keys, callback) {
        storageCall("remove", [keys], callback);
      },
    };

    function checkUrl() {
      if (!isContextValid()) {
        invalidate();
        return;
      }
      if (currentLocation.href === currentUrl) return;
      const previousUrl = currentUrl;
      currentUrl = currentLocation.href;
      mutationFirstSeenAt = 0;
      onNavigate({ previousUrl, url: currentUrl, pageKind: classifyUrl(currentUrl) });
    }

    function isInternalMutation(mutation) {
      const target = mutation?.target;
      if (target?.closest?.(INTERNAL_SELECTOR)) return true;
      const added = mutation?.addedNodes;
      if (!added?.length) return false;
      for (const node of added) {
        if (!node?.closest?.(INTERNAL_SELECTOR)) return false;
      }
      return true;
    }

    function handleMutations(mutations) {
      if (suppressionDepth > 0) return;
      if (mutations?.length && mutations.every(isInternalMutation)) return;
      const now = Date.now();
      if (!mutationFirstSeenAt) mutationFirstSeenAt = now;
      const firstSeenAt = mutationFirstSeenAt;
      const elapsedMs = now - firstSeenAt;
      if (elapsedMs > 4000) mutationFirstSeenAt = 0;
      onMutate({
        url: currentLocation.href,
        isSearchPage: isSearchUrl(currentLocation.href),
        firstSeenAt,
        elapsedMs,
      });
    }

    function setMutationSuppressed(isSuppressed) {
      suppressionDepth = Math.max(0, suppressionDepth + (isSuppressed ? 1 : -1));
    }

    function start() {
      if (started || invalidated) return;
      if (!isContextValid()) {
        invalidate();
        return;
      }
      started = true;
      currentUrl = currentLocation.href;
      popstateListener = () => win.dispatchEvent(new Event("paw-locationchange"));
      locationListener = checkUrl;
      win.addEventListener("popstate", popstateListener);
      win.addEventListener("paw-locationchange", locationListener);
      urlTimer = setInterval(checkUrl, 1000);
      observer = new Observer(handleMutations);
      observer.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
      onNavigate({ previousUrl: null, url: currentUrl, pageKind: classifyUrl(currentUrl) });
    }

    return {
      start,
      stop,
      setMutationSuppressed,
      storage,
      isContextValid,
      __test: {
        checkUrl,
        handleMutations,
        isInternalMutation,
        invalidate,
        getObserver: () => observer,
        getSuppressionDepth: () => suppressionDepth,
        isStarted: () => started,
      },
    };
  }

  return { createLifecycle };
});
