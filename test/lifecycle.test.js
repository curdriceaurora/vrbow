const test = require("node:test");
const assert = require("node:assert/strict");
const { createLifecycle } = require("../src/content/lifecycle.js");

function createHarness() {
  const listeners = new Map();
  const events = [];
  const location = { href: "https://www.vrbo.com/100" };
  const window = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) || []) fn(event);
    },
  };
  const observerState = { callback: null, observed: false, disconnected: false };
  class Observer {
    constructor(callback) { observerState.callback = callback; }
    observe() { observerState.observed = true; }
    disconnect() { observerState.disconnected = true; }
  }
  const stored = {};
  const chrome = {
    runtime: { id: "test-extension" },
    storage: {
      local: {
        get(keys, callback) { callback({ enabled: true }); },
        set(values, callback) { Object.assign(stored, values); callback?.(); },
        remove(keys, callback) { delete stored[keys]; callback?.(); },
      },
    },
  };
  const lifecycle = createLifecycle({
    window,
    document: { body: {}, documentElement: {} },
    chrome,
    location,
    MutationObserver: Observer,
    classifyUrl: (url) => url.includes("search") ? "search" : "listing",
    isSearchUrl: (url) => url.includes("search"),
    onNavigate: (event) => events.push(["navigate", event]),
    onMutate: (event) => events.push(["mutate", event]),
    onInvalidate: (event) => events.push(["invalidate", event]),
  });
  return { lifecycle, listeners, events, location, observerState, chrome, stored };
}

test("lifecycle owns navigation, mutation, storage, and teardown", () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = () => 42;
  globalThis.clearInterval = () => {};
  try {
    const harness = createHarness();
    const { lifecycle, events, location, observerState, stored } = harness;
    lifecycle.start();
    lifecycle.start();
    assert.equal(lifecycle.__test.isStarted(), true);
    assert.equal(observerState.observed, true);
    assert.equal(events[0][0], "navigate");
    assert.equal(events[0][1].previousUrl, null);

    location.href = "https://www.vrbo.com/search";
    lifecycle.__test.checkUrl();
    lifecycle.__test.checkUrl();
    assert.equal(events.filter(([type]) => type === "navigate").length, 2);

    const internal = { closest: () => ({}) };
    lifecycle.__test.handleMutations([{ target: internal, addedNodes: [] }]);
    assert.equal(events.filter(([type]) => type === "mutate").length, 0);
    lifecycle.__test.handleMutations([{ target: {}, addedNodes: [{ closest: () => ({}) }] }]);
    assert.equal(events.filter(([type]) => type === "mutate").length, 0);
    lifecycle.__test.handleMutations([{ target: {}, addedNodes: [{ closest: () => null }] }]);
    assert.equal(events.filter(([type]) => type === "mutate").length, 1);
    assert.equal(events.find(([type]) => type === "mutate")[1].isSearchPage, true);

    lifecycle.setMutationSuppressed(true);
    lifecycle.setMutationSuppressed(true);
    lifecycle.__test.handleMutations([]);
    lifecycle.setMutationSuppressed(false);
    lifecycle.setMutationSuppressed(false);
    lifecycle.setMutationSuppressed(false);
    assert.equal(lifecycle.__test.getSuppressionDepth(), 0);
    lifecycle.__test.handleMutations([]);
    assert.equal(events.filter(([type]) => type === "mutate").length, 2);

    let read;
    lifecycle.storage.get(["enabled"], (result) => { read = result; });
    lifecycle.storage.set({ saved: true });
    assert.deepEqual(read, { enabled: true });
    assert.equal(stored.saved, true);
    lifecycle.storage.remove("saved");
    assert.equal(stored.saved, undefined);

    lifecycle.stop();
    lifecycle.stop();
    assert.equal(observerState.disconnected, true);
    assert.equal(lifecycle.__test.isStarted(), false);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("lifecycle restarts the mutation burst window after the hard cap", () => {
  const harness = createHarness();
  const originalNow = Date.now;
  const times = [1000, 5001, 5002];
  Date.now = () => times.shift();
  try {
    harness.lifecycle.__test.handleMutations([]);
    harness.lifecycle.__test.handleMutations([]);
    harness.lifecycle.__test.handleMutations([]);
  } finally {
    Date.now = originalNow;
  }
  const mutations = harness.events.filter(([type]) => type === "mutate").map(([, event]) => event);
  assert.deepEqual(mutations.map(({ elapsedMs }) => elapsedMs), [0, 4001, 0]);
});

test("lifecycle invalidates once when the extension context disappears", () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = () => 7;
  globalThis.clearInterval = () => {};
  try {
    const harness = createHarness();
    harness.lifecycle.start();
    Object.defineProperty(harness.chrome.runtime, "id", {
      configurable: true,
      get() { throw new Error("Extension context invalidated"); },
    });
    harness.lifecycle.storage.get("x", () => assert.fail("stale callback"));
    harness.lifecycle.__test.checkUrl();
    harness.lifecycle.__test.invalidate("again");
    assert.equal(harness.events.filter(([type]) => type === "invalidate").length, 1);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("lifecycle reports ordinary storage errors without invalidating", () => {
  const harness = createHarness();
  harness.chrome.storage.local.set = () => { throw new Error("disk failure"); };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    harness.lifecycle.storage.set({ value: 1 });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.equal(harness.events.filter(([type]) => type === "invalidate").length, 0);
});

test("lifecycle reports async storage errors and preserves callbacks", () => {
  const harness = createHarness();
  const warnings = [];
  let callbackCount = 0;
  const originalWarn = console.warn;
  harness.chrome.runtime.lastError = { message: "quota exceeded" };
  harness.chrome.storage.local.set = (_values, callback) => {
    assert.equal(typeof callback, "function");
    callback();
  };
  console.warn = (...args) => warnings.push(args);
  try {
    harness.lifecycle.storage.set({ first: true });
    harness.lifecycle.storage.set({ second: true }, () => { callbackCount++; });
  } finally {
    console.warn = originalWarn;
    delete harness.chrome.runtime.lastError;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0][0], /storage\.set/);
  assert.equal(callbackCount, 1);
});

test("lifecycle covers default callbacks and storage invalidation edges", () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = () => 9;
  globalThis.clearInterval = () => {};
  try {
    const harness = createHarness();
    const silent = createLifecycle({
      window: harness.lifecycle ? {
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {},
      } : null,
      document: { body: {} },
      chrome: harness.chrome,
      location: harness.location,
      MutationObserver: class { observe() {} disconnect() {} },
    });
    silent.start();
    silent.__test.handleMutations([]);
    silent.__test.invalidate();

    const storageHarness = createHarness();
    storageHarness.chrome.storage.local.set = () => {
      throw new Error("Extension context invalidated");
    };
    storageHarness.lifecycle.storage.set({ value: 1 });
    assert.equal(storageHarness.events.filter(([type]) => type === "invalidate").length, 1);

    const callbackHarness = createHarness();
    callbackHarness.chrome.storage.local.get = (_keys, callback) => {
      Object.defineProperty(callbackHarness.chrome.runtime, "id", {
        configurable: true,
        get() { throw new Error("gone"); },
      });
      callback({ value: 1 });
    };
    callbackHarness.lifecycle.storage.get("value", () => assert.fail("stale callback"));
    assert.equal(callbackHarness.events.filter(([type]) => type === "invalidate").length, 1);

    const invalidHarness = createHarness();
    invalidHarness.chrome.runtime = null;
    invalidHarness.lifecycle.start();
    assert.equal(invalidHarness.events.filter(([type]) => type === "invalidate").length, 1);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});
