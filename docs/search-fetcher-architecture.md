# Search fetcher architecture

Status: current runtime architecture as of the `shared/search-fetcher.js` decomposition.

`search-fetcher.js` composes three focused modules instead of owning pacing, caching,
and response parsing directly:

```text
search-fetcher.js (queue engine: dispatch order, concurrency, scroll gating, session budget)
  ├── backoff-ladder.js      — adaptive pacing: delay ladder, dispatch-wait math, pressure/recovery signals
  ├── search-cache.js        — memory LRU + chrome.storage cache, terminal-state cooldowns, alias tracking
  └── search-response-parser.js — Apollo/HTML response parsing, hasConcretePolicy, listing-URL validation
```

There are no imports between `backoff-ladder.js`, `search-cache.js`, and
`search-response-parser.js`. Only `search-fetcher.js` depends on all three, and only it
knows how they compose.

## Common rules

- Each file exposes a `create*` factory (`createBackoffLadder`, `createSearchCache`) or a
  set of pure functions (`search-response-parser.js`) in Node, and a matching
  `globalThis.Vdp*` object in the extension. Creating an instance has no browser side
  effects beyond what its own options ask for (e.g. `search-cache.js`'s optional storage
  maintenance interval).
- `search-fetcher.js` re-exports every public name the original monolithic file exported
  (`CACHE_PREFIX`, `ALIAS_PREFIX`, `walkApolloNode`, `parseListingHtml`,
  `hasConcretePolicy`, `resolveSearchApolloRecord`, `createSearchFetchQueue`,
  `extractPropertyIdFromUrl`, `validateListingUrl`, `performStorageMaintenance`,
  `calculatePolicyCompleteness`, `canPolicyUpgrade`, `serializeSearchPolicyForCache`) and
  `createSearchFetchQueue(options)` accepts the exact same flat options object it always
  did. Callers (`search-badges.js`, tests, tools) do not need to know the split exists.

## `backoff-ladder.js`

Factory: `createBackoffLadder({ baseDelayMs, highPriorityFloorMs, errorClusterThreshold,
errorClusterWindowMs, cleanWindowMs, pauseOnChallengeMs, randomFn })`

Methods: `noteHardBlock()`, `noteSoftFailure()`, `noteSuccess()`,
`computeDispatchWait(isHighPriority, now)`, `recordDispatch(isHighPriority,
dispatchedAt)`, `applyJitter(waitMs)`, `effectiveMinDelayMs()`, `hpMinDelayMs()`,
`isPaused(now?)`, `getPausedUntil()`, `getLadderStep()`.

Pure timing state: the delay ladder step, the hard-pause deadline, and the two dispatch
trackers (`lastDispatchAt`, `lastBgStart`). No fetch, cache, or DOM dependency. See the
inline comments for why recovery is success-driven rather than timer-driven, and why the
global/class dispatch-wait split needs two trackers, not three.

## `search-cache.js`

Factory: `createSearchCache({ storage, ttlMs, cooldownMs, maxMemoryEntries,
maintenanceIntervalMs, autoMaintenance })`

Methods: `getCached(propertyId, targetUrl)`, `setCached(propertyId, data, options)`,
`peekMemory(propertyId)` (non-touching, alias-resolved memory read used by the queue
engine's pre-dispatch checks), `isShallowPreliminaryPolicy(policy)`,
`resolveAlias(propertyId)`, `setAlias(fromId, toId, { persist })`,
`recordTerminalState(propertyId, data, allowBypass)`, `getTerminalState(propertyId)`,
`clearTerminalState(propertyId)`, `isInCooldown(propertyId)`, `clearCooldowns()`,
`dispose()`, `getSize()`.

Owns the in-memory LRU cache, the `chrome.storage`-backed persistent cache (with
schema/version gating and bounded storage maintenance), terminal-state cooldowns, and
property-ID alias tracking. Also exports the policy-quality precedence functions as
module-level pure functions: `calculatePolicyCompleteness`, `canPolicyUpgrade`,
`serializeSearchPolicyForCache`, `performStorageMaintenance`.

## `search-response-parser.js`

Pure functions, no factory: `walkApolloNode`, `parseListingHtml`, `hasConcretePolicy`,
`resolveSearchApolloRecord`, `extractPropertyIdFromUrl`, `validateListingUrl`.

Turns a fetched HTML response or a search-page Apollo record into a normalized policy,
and validates/decomposes listing URLs via `site-registry.js`. No queueing, pacing, or
caching concerns.

## `search-fetcher.js` (queue engine)

`createSearchFetchQueue(options)` owns dispatch ordering (priority queue, per-property
dedup), concurrency (`maxConcurrent`), scroll gating, and the session request budget
(`sessionCap`). It builds one `backoffLadder` and one `searchCache` instance per queue,
and calls into `search-response-parser.js`'s pure functions directly. Its own methods
(`enqueue`, `remove`, `clearQueue`, `dispose`, `subscribe`, `setScrollPaused`, and the
`get*`/`is*` inspection getters) are unchanged from before the split.

## Verification and raw-file consumers

Changes to the search-fetcher stack must keep these raw-file consumers aligned:

- `src/manifest.json` — script load order (`site-registry.js`, `extract.js` before
  `backoff-ladder.js`, `search-cache.js`, `search-response-parser.js`, before
  `search-fetcher.js`)
- `package.json` (`test:all` syntax checks)
- `tools/check-coverage.js` — Node coverage gate target list
- `e2e/js-coverage.spec.js` — routes, HTML script tags, and `TARGET_SCRIPTS`
- `tools/live-check.js` and `tools/live-search-check.js` — `SCRIPT_PATHS` and load order
- `test/search-fetcher.test.js`, `test/search-response-parser.test.js`

`npm run test:all` runs syntax checks, Node coverage gates, and Playwright.
