// search-cache.js
// Persistent + in-memory cache for search-result pet policies: LRU memory cache,
// chrome.storage-backed persistence with TTL and schema/version gating, terminal-state
// cooldowns, property-ID alias tracking, and the policy-quality precedence rules that
// decide whether a new result is allowed to overwrite a cached one.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PawSearchCache = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CACHE_PREFIX = "paw_cache_";
  const ALIAS_PREFIX = "paw_alias_";
  const LEGACY_PREFIXES = ["vrbow_cache_", "vrbow_alias_"];
  const LEGACY_KEYS = new Set([
    "vrbow_enable_search_badging",
    "vdpLastPolicy",
    "vdpLastUrl",
  ]);
  const CACHE_RECORD_VERSION = 1;
  const POLICY_SCHEMA_VERSION = 1;
  const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const DEFAULT_COOLDOWN_MS = 30000; // 30s cooldown for terminal states
  const DEFAULT_MAX_MEMORY_ENTRIES = 250; // Cap on in-memory LRU cache entries
  const DEFAULT_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

  /**
   * Calculate a numeric completeness score for a policy based on concrete fields.
   */
  function calculatePolicyCompleteness(policy) {
    if (!policy) return 0;
    let score = 0;
    if (policy.petsAllowed !== null && policy.petsAllowed !== undefined) score += 2;
    if (policy.maxDogs !== null && policy.maxDogs !== undefined) score += 2;
    if (policy.weightLimit && policy.weightLimit.value !== null) score += 2;
    if (policy.fee && policy.fee.amount !== null) score += 2;
    if (policy.deposit && policy.deposit.amount !== null) score += 1;
    if (policy.approvalRequired !== null && policy.approvalRequired !== undefined) score += 1;
    if (policy.restrictionsFound) score += 1;
    return score;
  }

  /**
   * Enforces data quality precedence:
   * valid detailed cache > detailed listing > detailed Apollo > shallow Apollo > unknown.
   */
  function canPolicyUpgrade(existingPolicy, newPolicy, newSource) {
    if (!existingPolicy) return true;
    if (!newPolicy) return false;

    const existingScore = calculatePolicyCompleteness(existingPolicy);
    const newScore = calculatePolicyCompleteness(newPolicy);

    // If new is strictly more complete, allow upgrade
    if (newScore > existingScore) return true;
    // If existing is strictly more complete, prevent downgrade
    if (existingScore > newScore) return false;

    // If scores are equal, prefer direct listing fetch over search Apollo state
    const sourcePriority = { "listing-page": 3, "search-response": 2, "search-page-state": 1 };
    const existingPri = sourcePriority[existingPolicy.source] || 0;
    const newPri = sourcePriority[newSource || newPolicy.source] || 0;

    return newPri >= existingPri;
  }

  /**
   * Identifies whether a cached policy is merely a preliminary search-level
   * boolean flag without specific secondary numbers/rules.
   */
  function isShallowPreliminaryPolicy(policy) {
    if (!policy || typeof policy !== "object") return false;
    // Definitive negative policy never needs upgrading
    if (policy.petsAllowed === false) return false;
    // Rich policy with secondary constraints does not need upgrading
    if (policy.maxDogs !== null && policy.maxDogs !== undefined) return false;
    if (policy.weightLimit && policy.weightLimit.value !== null) return false;
    if (policy.fee && policy.fee.amount !== null) return false;
    if (policy.deposit && policy.deposit.amount !== null) return false;
    if (policy.approvalRequired !== null && policy.approvalRequired !== undefined) return false;
    if ((policy.restrictionNoteCount && policy.restrictionNoteCount > 0) || (policy._raw?.otherNotes && policy._raw.otherNotes.length > 0)) return false;

    // Shallow boolean flag from search results state
    return policy.source === "search-page-state" || policy._source === "search-page-state";
  }

  /**
   * Strict persistence serializer that allowlists canonical schema fields
   * and strips unneeded _raw objects, snippets, and DOM text from storage.
   */
  function serializeSearchPolicyForCache(policy) {
    if (!policy || typeof policy !== "object") return null;
    return {
      schemaVersion: POLICY_SCHEMA_VERSION,
      propertyId: policy.propertyId || null,
      source: policy.source || "search-response",
      extractedAt: policy.extractedAt || new Date().toISOString(),
      petsAllowed: policy.petsAllowed !== undefined ? policy.petsAllowed : null,
      maxDogs: policy.maxDogs !== undefined ? policy.maxDogs : null,
      weightLimit: policy.weightLimit ? {
        value: policy.weightLimit.value,
        unit: policy.weightLimit.unit,
        ...(policy.weightLimit.pounds !== undefined ? { pounds: policy.weightLimit.pounds } : {}),
      } : null,
      fee: policy.fee ? {
        amount: policy.fee.amount,
        currency: policy.fee.currency,
        period: policy.fee.period,
        ...(policy.fee.text !== undefined ? { text: policy.fee.text } : {}),
        ...(policy.fee.perPet ? { perPet: true } : {}),
        ...(policy.fee.tiered ? { tiered: true } : {}),
      } : null,
      deposit: policy.deposit ? {
        amount: policy.deposit.amount,
        currency: policy.deposit.currency,
        ...(policy.deposit.text !== undefined ? { text: policy.deposit.text } : {}),
      } : null,
      approvalRequired: policy.approvalRequired !== undefined ? policy.approvalRequired : null,
      restrictionsFound: Boolean(policy.restrictionsFound),
      contradictions: policy.contradictions && typeof policy.contradictions === "object" ? {
        maxDogs: Boolean(policy.contradictions.maxDogs),
        weightLimit: Boolean(policy.contradictions.weightLimit),
        fee: Boolean(policy.contradictions.fee),
      } : { maxDogs: false, weightLimit: false, fee: false },
      restrictionNoteCount: typeof policy.restrictionNoteCount === "number" ? policy.restrictionNoteCount : 0,
      confidence: policy.confidence || "low",
    };
  }

  function resolveCacheKey(propId, urlHint) {
    if (!propId) return "";
    try {
      const siteRegistry = (typeof globalThis !== "undefined" && globalThis.PawSiteRegistry) ||
        (typeof require === "function" ? require("./site-registry.js") : null);
      if (siteRegistry && typeof siteRegistry.getCacheKey === "function") {
        return siteRegistry.getCacheKey(urlHint || propId, propId);
      }
    } catch {}
    return CACHE_PREFIX + propId;
  }

  /**
   * 8.2.7 Bounded Storage Maintenance:
   * Remove stale or incompatible PawCheck records and pre-PawCheck storage keys.
   * Records no analytics.
   */
  async function performStorageMaintenance(storage, options = {}) {
    if (!storage || typeof storage.get !== "function") {
      return { inspected: 0, removed: 0, removedKeys: [] };
    }
    const now = typeof options.now === "number" ? options.now : Date.now();

    return new Promise((resolve) => {
      try {
        storage.get(null, (allItems) => {
          if (!allItems || typeof allItems !== "object") {
            resolve({ inspected: 0, removed: 0, removedKeys: [] });
            return;
          }

          const keysToRemove = [];
          let inspected = 0;

          for (const [key, entry] of Object.entries(allItems)) {
            if (LEGACY_KEYS.has(key) || LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
              inspected++;
              keysToRemove.push(key);
              continue;
            }

            if (!key.startsWith(CACHE_PREFIX)) {
              continue;
            }

            inspected++;

            // Check if record is corrupt, incompatible, or expired
            const isCorrupt = !entry || typeof entry !== "object";
            const isIncompatible = !isCorrupt && (
              entry.cacheVersion !== CACHE_RECORD_VERSION ||
              !entry.data ||
              typeof entry.data !== "object" ||
              !entry.data.policy ||
              entry.data.policy.schemaVersion !== POLICY_SCHEMA_VERSION
            );
            const isExpired = !isCorrupt && (
              !entry.expiresAt ||
              now >= entry.expiresAt
            );

            if (isCorrupt || isIncompatible || isExpired) {
              keysToRemove.push(key);
            }
          }

          const lastPolicyKeys = ["pawLastPolicy", "pawLastUrl", "pawLastPolicyExpiresAt"]
            .filter((key) => Object.prototype.hasOwnProperty.call(allItems, key));
          if (lastPolicyKeys.length) {
            inspected += lastPolicyKeys.length;
            const validLastPolicy = allItems.pawLastPolicy &&
              typeof allItems.pawLastPolicy === "object" &&
              typeof allItems.pawLastUrl === "string" &&
              typeof allItems.pawLastPolicyExpiresAt === "number" &&
              now < allItems.pawLastPolicyExpiresAt;
            if (!validLastPolicy) keysToRemove.push(...lastPolicyKeys);
          }

          if (keysToRemove.length > 0 && typeof storage.remove === "function") {
            try {
              storage.remove(keysToRemove, () => {
                resolve({ inspected, removed: keysToRemove.length, removedKeys: keysToRemove });
              });
            } catch {
              resolve({ inspected, removed: 0, removedKeys: [] });
            }
          } else {
            resolve({ inspected, removed: 0, removedKeys: [] });
          }
        });
      } catch {
        resolve({ inspected: 0, removed: 0, removedKeys: [] });
      }
    });
  }

  /**
   * Search Result Cache: LRU memory cache + chrome.storage persistence, terminal-state
   * cooldowns, and property-ID alias tracking.
   */
  function createSearchCache(options = {}) {
    const storage = options.storage || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null);
    const ttlMs = options.ttlMs !== undefined ? options.ttlMs : DEFAULT_TTL_MS;
    const cooldownMs = options.cooldownMs !== undefined ? options.cooldownMs : DEFAULT_COOLDOWN_MS;
    const maxMemoryEntries = typeof options.maxMemoryEntries === "number"
      ? options.maxMemoryEntries
      : DEFAULT_MAX_MEMORY_ENTRIES;
    const maintenanceIntervalMs = typeof options.maintenanceIntervalMs === "number"
      ? options.maintenanceIntervalMs
      : DEFAULT_MAINTENANCE_INTERVAL_MS;

    const memoryCache = new Map();
    const terminalCooldowns = new Map(); // propertyId -> { data, expiresAt, allowBypass }
    const aliasMap = new Map();
    let isDisposed = false;
    let maintenanceIntervalTimer = null;

    function setMemoryCache(key, value) {
      if (!key) return;
      memoryCache.delete(key);
      memoryCache.set(key, value);
      if (memoryCache.size > maxMemoryEntries) {
        const oldestKey = memoryCache.keys().next().value;
        if (oldestKey !== undefined) {
          memoryCache.delete(oldestKey);
        }
      }
    }

    /** Touching lookup: moves a fresh hit to the end of the LRU order; evicts stale entries. */
    function getMemoryCache(id) {
      if (!id || !memoryCache.has(id)) return null;
      const mem = memoryCache.get(id);
      if (Date.now() - mem.ts < ttlMs) {
        memoryCache.delete(id);
        memoryCache.set(id, mem);
        return mem;
      }
      memoryCache.delete(id);
      return null;
    }

    /** Non-touching raw peek used by the queue engine's pre-dispatch checks. */
    function peekMemory(propertyId) {
      const targetId = resolveAlias(propertyId);
      const mem = memoryCache.get(targetId) || memoryCache.get(propertyId);
      if (mem && Date.now() - mem.ts < ttlMs) {
        return { data: mem.data, ts: mem.ts, targetId };
      }
      return null;
    }

    function resolveAlias(propertyId) {
      return aliasMap.get(String(propertyId).toLowerCase()) || propertyId;
    }

    function setAlias(fromId, toId, { persist = false } = {}) {
      if (!fromId || !toId) return;
      aliasMap.set(String(fromId).toLowerCase(), toId);
      if (persist && storage && typeof storage.set === "function") {
        try {
          storage.set({ [`${ALIAS_PREFIX}${fromId}`]: toId }, () => {});
        } catch {}
      }
    }

    function recordTerminalState(propertyId, data, allowBypass = false) {
      if (!propertyId || isDisposed) return;
      terminalCooldowns.set(propertyId, {
        data,
        expiresAt: Date.now() + cooldownMs,
        allowBypass,
      });
    }

    /** Lazily expires and removes a stale entry on read, mirroring the original inline check. */
    function getTerminalState(propertyId) {
      const terminal = terminalCooldowns.get(propertyId);
      if (!terminal) return null;
      if (Date.now() < terminal.expiresAt) return terminal;
      terminalCooldowns.delete(propertyId);
      return null;
    }

    function clearTerminalState(propertyId) {
      terminalCooldowns.delete(propertyId);
    }

    function isInCooldown(propertyId) {
      const t = getTerminalState(propertyId);
      return Boolean(t && !t.allowBypass);
    }

    async function getCached(propertyId, targetUrl) {
      if (!propertyId || isDisposed) return null;
      const targetId = resolveAlias(propertyId);

      // Check in-memory LRU cache first (synchronous & zero-cost)
      const mem = getMemoryCache(targetId) || getMemoryCache(propertyId);
      if (mem) {
        return mem.data;
      }

      // Check terminal cooldowns (transient fast-path for non-ok terminal states)
      const terminal = getTerminalState(targetId) || getTerminalState(propertyId);
      if (terminal) {
        return terminal.data;
      }

      // Check persistent storage
      if (storage) {
        return new Promise((resolve) => {
          try {
            const targetKey = resolveCacheKey(targetId, targetUrl);
            const propKey = resolveCacheKey(propertyId, targetUrl);
            const defaultTargetKey = CACHE_PREFIX + targetId;
            const defaultPropKey = CACHE_PREFIX + propertyId;
            const keysToFetch = Array.from(new Set([
              targetKey,
              propKey,
              defaultTargetKey,
              defaultPropKey,
              ALIAS_PREFIX + propertyId,
            ]));

            storage.get(keysToFetch, (items) => {
              if (isDisposed) {
                resolve(null);
                return;
              }
              const alias = items ? items[ALIAS_PREFIX + propertyId] : null;
              if (alias && typeof alias === "string") {
                aliasMap.set(String(propertyId).toLowerCase(), alias);
              }
              const effectiveId = alias || targetId;
              const effectiveKey = resolveCacheKey(effectiveId, targetUrl);
              const defaultEffectiveKey = CACHE_PREFIX + effectiveId;

              if (alias && items &&
                  !Object.prototype.hasOwnProperty.call(items, effectiveKey) &&
                  !Object.prototype.hasOwnProperty.call(items, defaultEffectiveKey)) {
                storage.get(Array.from(new Set([effectiveKey, defaultEffectiveKey])), (canonicalItems) => {
                  if (isDisposed) {
                    resolve(null);
                    return;
                  }
                  processEntry({ ...items, ...(canonicalItems || {}) });
                });
                return;
              }

              processEntry(items);

              function processEntry(availableItems) {
                if (isDisposed) {
                  resolve(null);
                  return;
                }

                const entry = availableItems ? (
                  availableItems[effectiveKey] ||
                  availableItems[propKey] ||
                  availableItems[targetKey] ||
                  availableItems[defaultEffectiveKey] ||
                  availableItems[defaultPropKey] ||
                  availableItems[defaultTargetKey]
                ) : null;

                if (
                  entry &&
                  entry.cacheVersion === CACHE_RECORD_VERSION &&
                  entry.expiresAt &&
                  Date.now() < entry.expiresAt &&
                  entry.data?.policy?.schemaVersion === POLICY_SCHEMA_VERSION
                ) {
                  setMemoryCache(effectiveId, { data: entry.data, ts: entry.storedAt || Date.now() });
                  if (propertyId !== effectiveId) {
                    setMemoryCache(propertyId, { data: entry.data, ts: entry.storedAt || Date.now() });
                  }
                  resolve(entry.data);
                } else {
                  if (entry) {
                    // Incompatible or expired: prune asynchronously
                    try {
                      storage.remove([
                        effectiveKey,
                        propKey,
                        targetKey,
                        defaultEffectiveKey,
                        defaultPropKey,
                        defaultTargetKey,
                      ], () => {});
                    } catch {}
                  }
                  resolve(null);
                }
              }
            });
          } catch {
            resolve(null);
          }
        });
      }
      return null;
    }

    async function setCached(propertyId, data, opts) {
      if (!propertyId || isDisposed || !data) return { accepted: false, data: null, policy: null };
      const persist = !opts || opts.persist !== false;

      // Check precedence against existing cache to prevent downgrading richer data
      const existing = await getCached(propertyId, opts?.targetUrl || data?.targetUrl);
      if (isDisposed) return { accepted: false, data: null, policy: null };

      if (existing && existing.policy && data.policy) {
        if (!canPolicyUpgrade(existing.policy, data.policy, data.source || data.policy.source)) {
          return {
            accepted: false,
            data: existing,
            policy: existing.policy,
          };
        }
      }

      // Serialize policy with field allowlist (strips _raw, snippets, etc.)
      const persistentPolicy = serializeSearchPolicyForCache(data.policy);
      const persistentData = {
        ...data,
        policy: persistentPolicy || data.policy,
      };

      const storedAt = Date.now();
      const expiresAt = storedAt + ttlMs;
      const entry = {
        cacheVersion: CACHE_RECORD_VERSION,
        propertyId,
        storedAt,
        expiresAt,
        data: persistentData,
      };
      setMemoryCache(propertyId, { data: persistentData, ts: storedAt });

      if (storage && persist) {
        try {
          const targetUrl = opts?.targetUrl || data?.targetUrl;
          const cacheKey = resolveCacheKey(propertyId, targetUrl);
          storage.set({ [cacheKey]: entry }, () => {});
        } catch (e) {
          console.warn("PawCheck failed to write cache:", e);
        }
      }

      return { accepted: true, data: persistentData, policy: persistentData.policy };
    }

    function clearCooldowns() {
      terminalCooldowns.clear();
    }

    if (storage && options.autoMaintenance !== false) {
      performStorageMaintenance(storage).catch(() => {});
      if (maintenanceIntervalMs > 0) {
        maintenanceIntervalTimer = setInterval(() => {
          if (!isDisposed && storage) {
            performStorageMaintenance(storage).catch(() => {});
          }
        }, maintenanceIntervalMs);
      }
    }

    function dispose() {
      isDisposed = true;
      if (maintenanceIntervalTimer) {
        clearInterval(maintenanceIntervalTimer);
        maintenanceIntervalTimer = null;
      }
      memoryCache.clear();
      terminalCooldowns.clear();
    }

    return {
      getCached,
      setCached,
      peekMemory,
      isShallowPreliminaryPolicy,
      resolveAlias,
      setAlias,
      recordTerminalState,
      getTerminalState,
      clearTerminalState,
      isInCooldown,
      clearCooldowns,
      dispose,
      getSize: () => memoryCache.size,
    };
  }

  return {
    CACHE_PREFIX,
    ALIAS_PREFIX,
    calculatePolicyCompleteness,
    canPolicyUpgrade,
    serializeSearchPolicyForCache,
    performStorageMaintenance,
    createSearchCache,
  };
});
