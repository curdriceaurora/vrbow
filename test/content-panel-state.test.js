// test/content-panel-state.test.js
// Unit tests for pdp-panel.js's sparseStateMessage() — the fully-sparse
// panel state decision (see #12's "Allowed, no additional restrictions
// listed" state), split out as a pure, DOM-free function specifically so
// it's testable without mocking document.createElement and the rest of
// renderPanel's DOM construction. The full render is covered end-to-end
// against the real extension in e2e/airbnb-listing.spec.js; this file
// covers just the wording/tone decision in isolation, fast and without a
// browser.
//
// pdp-panel.js references document/window/chrome through its default instance even
// though sparseStateMessage itself touches none of them, so a minimal
// stub environment is required just to require() the file — mirrors the
// (larger) setup in test/search-ui.test.js, trimmed to what's actually
// needed to load the module without hanging (setInterval in particular:
// content.js calls setInterval(onUrlMaybeChanged, 1000) at module scope,
// which would keep a real timer alive and the test process running
// forever if not stubbed).

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { MockCustomEvent, MockEvent, installIntervalGuard, installPawGlobals } = require("./helpers/content-env-stub.js");

let panelTest;
let sparseStateMessage;

before(() => {
  globalThis.window = globalThis;
  globalThis.document = {
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    documentElement: { appendChild() {} },
    body: {},
    createTreeWalker() { return { nextNode() { return null; } }; },
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.dispatchEvent = () => {};
  globalThis.location = { href: "https://example.com/" };
  globalThis.chrome = {
    storage: { local: { get(_k, cb) { cb({}); }, set() {} }, onChanged: { addListener() {} } },
    runtime: { id: "mock-extension-id", onMessage: { addListener() {} } },
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.CustomEvent = MockCustomEvent;
  globalThis.Event = MockEvent;
  // Prevents the module-scope setInterval(onUrlMaybeChanged, 1000) call
  // from keeping a real timer alive — this test process would otherwise
  // never exit.
  installIntervalGuard();
  installPawGlobals();

  panelTest = require("../src/content/pdp-panel.js").createPdpPanel({
    siteRegistry: globalThis.PawSiteRegistry,
    getListingIdFromUrl: () => null,
    isListingUrl: () => false,
    looksLikeListingPage: () => false,
  }).__test;
  ({ sparseStateMessage } = panelTest);
});

describe("pdp-panel.js: policy markup", () => {
  test("renders prohibited and absent-policy states", () => {
    const prohibited = panelTest.buildPanelMarkup({
      petsAllowed: false,
      restrictionsFound: true,
      _raw: {
        found: true,
        petsAllowedSnippet: "No pets",
        petsAllowedSource: "House rules",
        entries: [{ priority: 2 }],
      },
    });
    assert.match(prohibited, /No pets allowed/);
    assert.match(prohibited, /listing data/);

    const absent = panelTest.buildPanelMarkup({
      petsAllowed: null,
      restrictionsFound: false,
      found: false,
    });
    assert.match(absent, /didn't mention pets\/dogs/);
  });

  test("renders sparse allowed policy with source attribution", () => {
    const html = panelTest.buildPanelMarkup({
      petsAllowed: true,
      maxDogs: null,
      weightLimit: null,
      fee: null,
      deposit: null,
      approvalRequired: false,
      restrictionsFound: true,
      _raw: {
        found: true,
        entries: [{ priority: 1 }],
        petsAllowedSource: "Guest review",
        otherNotes: [],
        fee: null,
        deposit: null,
        preReg: false,
        weightPerDog: null,
      },
    });
    assert.match(html, /Allowed, no additional restrictions listed/);
    assert.match(html, /Source: review/);
  });

  test("renders detailed limits, costs, conflicts, and grouped notes", () => {
    const html = panelTest.buildPanelMarkup({
      petsAllowed: true,
      maxDogs: 2,
      weightLimit: { value: 40, unit: "lb" },
      fee: { amount: 25, currency: "USD", period: "night", perPet: true },
      deposit: { amount: 100, currency: "USD" },
      approvalRequired: true,
      restrictionsFound: true,
      _raw: {
        found: true,
        entries: [{ priority: 2 }],
        petsAllowedSource: "House rules",
        maxDogsSnippet: "Maximum 2 dogs",
        maxDogsSource: "House rules",
        maxDogsAlternates: [{ value: "3", source: "Review" }],
        weightSnippet: "40 lbs",
        weightSource: "House rules",
        weightAlternates: [],
        feeSnippet: "$25",
        feeSource: "Fees",
        feeAlternates: [],
        depositSnippet: "$100 refundable",
        depositSource: "Fees",
        preRegSnippet: "Approval required",
        preRegSource: "House rules",
        otherNotes: [
          { text: "Keep dogs leashed", source: "House rules" },
          { text: "Do not leave pets alone", source: "House rules" },
          { text: "Breed limits apply", source: "Policies" },
        ],
      },
    });
    assert.match(html, /Max dogs/);
    assert.match(html, /40 lbs/);
    assert.match(html, /\$25 per pet per night/);
    assert.match(html, /Refundable deposit/);
    assert.match(html, /Other pet notes \(3\)/);
    assert.match(html, /Listing also states elsewhere/);
  });

  test("renders tiered and freeform fee alternatives", () => {
    const base = {
      petsAllowed: true,
      maxDogs: 1,
      weightLimit: null,
      deposit: null,
      approvalRequired: false,
      restrictionsFound: true,
      _raw: { found: true, otherNotes: [], fee: "Fee applies", weightPerDog: null, preReg: false },
    };
    assert.match(panelTest.buildPanelMarkup({ ...base, fee: { tiered: true } }), /1st dog free/);
    assert.match(panelTest.buildPanelMarkup({ ...base, fee: { tiered: true, text: "$0 first dog, then $20" } }), /then \$20/);
    assert.match(panelTest.buildPanelMarkup({ ...base, fee: null }), /Fee applies/);
  });
});

describe("pdp-panel.js: sparseStateMessage (fully-sparse panel state)", () => {
  test("petsAllowed === true: affirmative 'Allowed, no additional restrictions listed' wording with the good tone", () => {
    const { text, toneClass } = sparseStateMessage(true);
    assert.match(text, /^Allowed, no additional restrictions listed\./);
    assert.match(text, /Max dogs, weight limit, fee, and pre-registration weren't stated anywhere on this listing\.$/);
    assert.equal(toneClass, " vdp-tone-good");
  });

  test("petsAllowed === false: neutral 'weren't stated' wording, no tone class", () => {
    const { text, toneClass } = sparseStateMessage(false);
    assert.equal(text, "Max dogs, weight limit, fee, and pre-registration weren't stated anywhere on this listing.");
    assert.doesNotMatch(text, /^Allowed/);
    assert.equal(toneClass, "");
  });

  test("petsAllowed === null (genuinely unconfirmed): same neutral wording as false, not the affirmative one", () => {
    const { text, toneClass } = sparseStateMessage(null);
    assert.equal(text, "Max dogs, weight limit, fee, and pre-registration weren't stated anywhere on this listing.");
    assert.equal(toneClass, "");
  });

  test("petsAllowed === undefined: same neutral wording (only a strict === true is treated as confirmed-allowed)", () => {
    const { text, toneClass } = sparseStateMessage(undefined);
    assert.equal(text, "Max dogs, weight limit, fee, and pre-registration weren't stated anywhere on this listing.");
    assert.equal(toneClass, "");
  });

  test("the affirmative and neutral messages are genuinely distinct strings, not the same text with a class swapped in", () => {
    const allowed = sparseStateMessage(true);
    const unknown = sparseStateMessage(null);
    assert.notEqual(allowed.text, unknown.text);
  });
});
