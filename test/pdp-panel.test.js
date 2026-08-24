const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");

const extract = require("../src/shared/extract.js");
const formatters = require("../src/shared/formatters.js");

function installDom(url = "https://www.vrbo.com/3000003") {
  const { window, document } = parseHTML(`<!doctype html><html><body><main>
    <section aria-label="House rules"><h2>House rules</h2><p>Dogs are welcome. Maximum 2 dogs.</p></section>
  </main></body></html>`);
  window.innerWidth = 1920;
  window.innerHeight = 1080;
  window.scrollX = 0;
  window.scrollY = 0;
  window.scrollTo = () => {};
  window.getComputedStyle = () => ({ position: "static" });
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = { href: url };
  globalThis.NodeFilter = window.NodeFilter || { SHOW_TEXT: 4 };
  globalThis.KeyboardEvent = class extends window.Event {
    constructor(type, init = {}) {
      super(type, init);
      Object.assign(this, init);
    }
  };
  globalThis.PawExtract = extract;
  globalThis.PawFormatters = formatters;
  globalThis.PawSiteRegistry = {
    getPropertyId: () => "3000003",
    isListingUrl: () => true,
    getPdpContentColumnSelector: () => "main",
    getPdpSectionConfig: () => null,
    getPdpStructuredPayload: () => ({ items: [
      { text: "Dogs allowed. Maximum 2 dogs. Pet fee is $25 per stay.", section: "House rules", header: "Pets" },
    ] }),
  };
  return { window, document };
}

function createPanel(options = {}) {
  installDom(options.url);
  delete require.cache[require.resolve("../src/content/pdp-panel.js")];
  const { createPdpPanel } = require("../src/content/pdp-panel.js");
  const storageWrites = [];
  const scheduled = [];
  const suppression = [];
  const policies = [];
  const panel = createPdpPanel({
    siteRegistry: globalThis.PawSiteRegistry,
    getListingIdFromUrl: () => "3000003",
    isListingUrl: () => options.isListing !== false,
    looksLikeListingPage: () => options.isListing !== false,
    safeStorageSet: (data) => storageWrites.push(data),
    scheduleRescan: (delay) => scheduled.push(delay),
    withMutationsSuppressed: async (work) => {
      suppression.push(true);
      try {
        return await work();
      } finally {
        suppression.push(false);
      }
    },
    onPolicy: (result) => policies.push(result),
  });
  return { panel, storageWrites, scheduled, suppression, policies };
}

function detailedPolicy() {
  return {
    petsAllowed: true,
    maxDogs: 2,
    weightLimit: { value: 40, unit: "lb" },
    fee: { amount: 25, currency: "USD", period: "stay" },
    deposit: { amount: 100, currency: "USD" },
    approvalRequired: true,
    restrictionsFound: true,
    _raw: {
      found: true,
      entries: [{ priority: 2 }],
      maxDogsSnippet: "Maximum 2 dogs",
      maxDogsSource: "House rules",
      weightSnippet: "40 lbs",
      weightSource: "House rules",
      feeSnippet: "$25 per stay",
      feeSource: "Fees",
      depositSnippet: "$100 deposit",
      depositSource: "Fees",
      preRegSnippet: "Approval required",
      preRegSource: "House rules",
      otherNotes: [{ text: "Keep dogs leashed", source: "House rules" }],
    },
  };
}

test("pdp panel renders, responds, repositions, and removes owned DOM", () => {
  const { panel } = createPanel();
  panel.render(detailedPolicy());

  const root = document.getElementById("vdp-panel");
  assert.ok(root);
  assert.match(root.textContent, /Max dogs/);
  root.querySelector(".vdp-other-toggle").click();
  assert.ok(root.querySelector(".vdp-other-list").classList.contains("vdp-visible"));
  root.querySelector(".vdp-jump").click();

  const header = root.querySelector(".vdp-header");
  header.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(header.getAttribute("aria-expanded"), "false");
  const keyEvent = new window.Event("keydown", { bubbles: true });
  keyEvent.key = "Enter";
  header.dispatchEvent(keyEvent);
  window.dispatchEvent(new window.Event("resize"));

  window.innerWidth = 300;
  panel.render(detailedPolicy());
  assert.ok(document.getElementById("vdp-panel").classList.contains("vdp-collapsed"));

  root.querySelector(".vdp-close").click();
  assert.equal(document.getElementById("vdp-panel"), null);
  panel.remove(true);
});

test("pdp panel scans structured and DOM policy data", async () => {
  const { panel, storageWrites, policies } = createPanel();
  await panel.scan(false);
  assert.ok(document.getElementById("vdp-panel"));
  assert.equal(storageWrites.length, 1);
  assert.equal(storageWrites[0].pawLastPolicy.maxDogs, 2);
  assert.equal(policies[0].policy.maxDogs, 2);
  assert.equal(policies[0].url, location.href);
  assert.equal(window.__pawLastPolicy, undefined);

  panel.reset();
  assert.equal(document.getElementById("vdp-panel"), null);
});

test("pdp panel ignores non-listing scans and collects visible pet text", async () => {
  const { panel } = createPanel({ isListing: false });
  assert.ok(panel.__test.collectDomPetSentences().length > 0);
  await panel.scan(false);
  assert.equal(document.getElementById("vdp-panel"), null);
});

test("pdp scan coalesces a request received while expansion is active", async () => {
  const { panel, scheduled } = createPanel();
  globalThis.PawSiteRegistry.getPdpStructuredPayload = () => [];
  const first = panel.scan(true);
  await panel.scan(true);
  await first;
  assert.deepEqual(scheduled, [300]);
});

test("pdp DOM helpers resolve sources, navigation targets, and dialogs", async () => {
  const { panel } = createPanel();
  const helpers = panel.__test;
  const paragraph = document.querySelector("p");
  assert.equal(helpers.findSectionHeadingForElement(paragraph), "House rules");
  assert.equal(helpers.findNodeForSnippet("Dogs are welcome"), paragraph);
  assert.ok(helpers.findHeadingFor("House rules"));
  helpers.jumpToSnippet("Dogs are welcome", "House rules");
  helpers.jumpToSnippet("missing text", "Amenities");
  assert.equal(helpers.shortSourceLabel("Policies > House rules"), "House rules");
  assert.match(helpers.row("Fee", "$25", "warn", "fee", "Fees", []), /vdp-jump/);
  assert.ok(helpers.getStructuredPdpPayload().items.length);

  panel.render(detailedPolicy());
  helpers.updatePanelPosition(document.getElementById("vdp-panel"), false);
  assert.equal(helpers.getPdpContentColumnSelector(), "main");

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.getClientRects = () => [{}];
  const close = document.createElement("button");
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", () => { dialog.getClientRects = () => []; });
  dialog.appendChild(close);
  document.body.appendChild(dialog);
  assert.equal(helpers.visibleDialogs().length, 1);
  assert.equal(helpers.closeDialog(dialog), true);

  const fallback = document.createElement("div");
  fallback.setAttribute("role", "dialog");
  fallback.getClientRects = () => [{}];
  fallback.addEventListener("keyup", () => { fallback.getClientRects = () => []; });
  document.body.appendChild(fallback);
  assert.equal(helpers.closeDialog(fallback), true);

  const foreign = document.createElement("div");
  foreign.setAttribute("role", "dialog");
  foreign.getClientRects = () => [{}];
  document.body.appendChild(foreign);
  const blocked = document.createElement("div");
  blocked.setAttribute("role", "dialog");
  blocked.getClientRects = () => [{}];
  const brokenClose = document.createElement("button");
  brokenClose.setAttribute("title", "Close");
  brokenClose.click = () => { throw new Error("blocked"); };
  blocked.appendChild(brokenClose);
  document.body.appendChild(blocked);
  assert.equal(helpers.closeDialog(blocked), false);

  await new Promise((resolve) => setTimeout(resolve, 1));
  panel.reset();
});

test("pdp factory accepts shared globals explicitly", async () => {
  installDom();
  globalThis.chrome = {
    storage: { local: { set(_values, callback) { callback?.(); } } },
  };
  delete require.cache[require.resolve("../src/content/pdp-panel.js")];
  const moduleApi = require("../src/content/pdp-panel.js");
  const panel = moduleApi.createPdpPanel({
    siteRegistry: globalThis.PawSiteRegistry,
    getListingIdFromUrl: () => "3000003",
    isListingUrl: () => true,
    looksLikeListingPage: () => true,
    safeStorageSet: () => {},
  });
  panel.setApolloData(globalThis.PawSiteRegistry.getPdpStructuredPayload());
  await panel.scan(false);
  assert.ok(document.getElementById("vdp-panel"));
  panel.reset();
});
