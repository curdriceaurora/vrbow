# Content module contracts

Status: implemented migration boundary for the `content.js` split.

These contracts describe ownership and call direction. They do not change runtime
behavior. During extraction, `content.js` remains the only module allowed to call
more than one content module.

```text
lifecycle ──events──> content.js <──results── pdp-panel
                           │
                           └────commands────> search-badges
```

There are no imports or calls between `lifecycle.js`, `pdp-panel.js`, and
`search-badges.js`. Shared parsing, site selection, fetching, and formatting stay in
the existing shared modules.

## Common rules

- Each file exposes one `create*` factory in Node and one matching `globalThis`
  factory in the extension. Creating a module has no browser side effects.
- Browser globals, shared modules, clocks, and callbacks enter through the factory
  dependency object. Tests replace them without loading `content.js`.
- `start()` is idempotent. `stop()` is idempotent and clears every listener,
  observer, interval, timeout, subscription, and owned DOM node.
- Async work captures its URL and target identity before awaiting. It discards its
  result when either identity changes.
- Expected lifecycle conditions are results, not thrown errors. Invalid dependency
  objects and broken invariants may throw.

## `lifecycle.js`

Factory:

```js
createLifecycle({
  window,
  document,
  chrome,
  location,
  MutationObserver,
  onNavigate,
  onMutate,
  onInvalidate,
})
```

Methods:

```js
start()
stop()
setMutationSuppressed(isSuppressed)
storage.get(keys, callback)
storage.set(values, callback)
storage.remove(keys, callback)
```

`start()` installs URL polling, `popstate`, `vdp-locationchange`, the body mutation
observer, and the extension-context checks. It emits one initial navigation event.
It does not scan pages or mutate feature UI.

`stop()` removes all installed resources and prevents later callbacks. Context
invalidation calls `stop()` before emitting `onInvalidate` exactly once.

`setMutationSuppressed()` changes observer state synchronously. Suppression is
nested: the observer resumes only after the matching number of `false` calls. This
lets the controller safely compose nested panel operations.

Callbacks:

```js
onNavigate({ previousUrl, url, pageKind })
onMutate({ url, pageKind, firstSeenAt, elapsedMs })
onInvalidate({ reason })
```

`pageKind` is `"listing"`, `"search"`, or `"other"`. Internal Vrbow mutations are
filtered before `onMutate`. The lifecycle module does not choose debounce delays;
the controller owns scheduling policy.

The storage wrapper preserves Chrome's callback API. Calls made after invalidation
are ignored. An `Extension context invalidated` error triggers the same one-time
invalidation path; unrelated errors are reported with `console.warn`.

Current ownership moved here: `isContextValid`, `cleanupOrphanedScript`, the safe
storage helpers, `onUrlMaybeChanged`, URL listeners/polling, `startObserver`,
`suppressObserver`, and their timers/listeners.

## `pdp-panel.js`

Factory:

```js
createPdpPanel({
  window,
  document,
  location,
  extract,
  formatters,
  siteRegistry,
  storage,
  withMutationsSuppressed,
  onPolicy,
})
```

Methods:

```js
scan({ force, url, apolloPayload })
render(policy)
remove({ resetSession })
reset()
```

`scan()` returns `Promise<{ status, policy? }>` where `status` is `"rendered"`,
`"empty"`, `"stale"`, or `"busy"`. It captures `url`; after every await it verifies
that the URL still matches before rendering or persisting. Concurrent scans preserve
the current coalescing behavior.

DOM expansion runs only through:

```js
withMutationsSuppressed(async () => {
  // Click relevant expanders, harvest owned dialogs, then close them.
})
```

The controller implements that function with `try/finally` around lifecycle's
suppression setter. The panel never imports or receives the lifecycle module.

`render()` replaces the owned panel and returns its root element. `remove()` removes
owned DOM and listeners; `resetSession` also clears user-collapse state. `reset()`
clears all URL-scoped harvested text, payload state, and scan state, then removes the
panel with session reset.

`onPolicy({ policy, url })` fires only after a current scan renders and persists its
policy. The controller mirrors that policy to `window.__vdpLastPolicy` for popup
compatibility.

Current ownership moved here: dialog harvesting/closing, collapsed-section
expansion, DOM sentence collection, snippet navigation, panel positioning and
rendering, structured PDP payload access, and `scan`.

## `search-badges.js`

Factory:

```js
createSearchBadges({
  window,
  document,
  location,
  searchFetcher,
  extract,
  formatters,
  siteRegistry,
  storage,
  requestApolloData,
})
```

Methods:

```js
start({ apolloPayload })
scan()
prune()
stop()
```

`start()` is idempotent. It creates the fetch queue, observers, page listeners, and
tooltip once, then scans. `scan()` discovers and binds current cards without resetting
the session request budget. `prune()` drops disconnected or recycled card bindings
and returns the number removed. `stop()` disposes the queue and removes every owned
listener, timer, observer, badge, slot, tooltip, and card attribute.

The module owns all card and property-ID maps. A recycled card is reset to a neutral
loading state before any request for its new property ID. Async queue notifications
must match both the bound card identity and property ID before changing UI.

`requestApolloData()` synchronously returns the latest search payload supplied by the
controller. The module does not listen for bridge events itself.

Current ownership moved here: scroll throttling, search statistics, Apollo fast path,
queue setup, card discovery/binding/pruning, badge rendering, tooltip behavior, and
search cleanup.

## `content.js` controller

`content.js` owns page mode, current URL, latest bridge payloads, scan timers, popup
message routing, and settings-change routing. It creates the three modules, then maps
lifecycle events to commands:

| Event | Controller action |
| --- | --- |
| Initial or changed search URL | Reset PDP state; start or prune/scan search badges when enabled |
| Initial or changed listing URL | Stop search badges; reset PDP state; request bridge data; schedule PDP scans |
| Initial or changed other URL | Stop search badges; reset PDP state |
| Search mutation | Request a throttled search scan |
| Listing mutation | Schedule the existing trailing/hard-cap PDP scan |
| Context invalidation | Cancel controller timers; stop all three modules |

The controller composes suppression as follows:

```js
async function withMutationsSuppressed(work) {
  lifecycle.setMutationSuppressed(true);
  try {
    return await work();
  } finally {
    lifecycle.setMutationSuppressed(false);
  }
}
```

The existing `module.exports.__test` facade stays during extraction only. Search tests
move to `search-badges.js` in the immediately following migration commit; the facade
then loses those exports. Each extracted module enters the Node coverage gate when its
direct tests land.

## Extraction acceptance checks

Every extraction commit must update all raw-file consumers in the same commit:

- `src/manifest.json`
- `package.json` (`test:all` syntax checks)
- `e2e/js-coverage.spec.js` routes, HTML script tags, and targets
- `tools/live-check.js`
- `tools/live-search-check.js`
- `test/search-ui.test.js`
- `test/content-panel-state.test.js`
- `test/helpers/content-env-stub.js`
- `test/theme-contract.test.js` source-file lists

`node --test`, `npm run test:coverage`, and `npx playwright test` must pass after each
phase. No compatibility facade may satisfy a browser-path or raw-file consumer.
