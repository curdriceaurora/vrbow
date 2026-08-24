// Direct regression coverage for search-response-parser.js: the Apollo/HTML
// response parsing and URL-validation helpers extracted out of search-fetcher.js.
// Most call paths are already exercised indirectly through search-fetcher.js's own
// tests (which import the same function objects); this file targets the fallback
// and edge branches those integration-style tests don't happen to reach.
const test = require("node:test");
const assert = require("node:assert/strict");

const parser = require("../src/shared/search-response-parser.js");
const extract = require("../src/shared/extract.js");

test("search-response-parser: hasConcretePolicy", async (t) => {
  await t.test("returns false for a null or empty policy", () => {
    assert.equal(parser.hasConcretePolicy(null), false);
    assert.equal(parser.hasConcretePolicy(undefined), false);
  });

  await t.test("is concrete when only otherNotes carries content", () => {
    const policy = {
      petsAllowed: null,
      maxDogs: null,
      weightLimit: null,
      fee: null,
      deposit: null,
      approvalRequired: null,
      restrictionNoteCount: 0,
      _raw: { otherNotes: ["Breed restrictions apply."] },
    };
    assert.equal(parser.hasConcretePolicy(policy), true);
  });

  await t.test("is not concrete when every field is unset and there are no notes", () => {
    const policy = {
      petsAllowed: null,
      maxDogs: null,
      weightLimit: null,
      fee: null,
      deposit: null,
      approvalRequired: null,
      restrictionNoteCount: 0,
      _raw: { otherNotes: [] },
    };
    assert.equal(parser.hasConcretePolicy(policy), false);
  });
});

test("search-response-parser: walkApolloNode", async (t) => {
  await t.test("delegates to extract.walkApolloNode when available", () => {
    const out = [];
    const state = { "Rules:1": { header: { text: "House Rules" }, text: "Dogs allowed." } };
    parser.walkApolloNode(state, state["Rules:1"], null, null, out, new Set(), 0, false);
    assert.ok(Array.isArray(out));
  });

  await t.test("warns and no-ops when extract.walkApolloNode is unavailable", (t) => {
    const original = extract.walkApolloNode;
    delete extract.walkApolloNode;
    t.after(() => { extract.walkApolloNode = original; });

    let warned = false;
    const originalWarn = console.warn;
    console.warn = () => { warned = true; };
    t.after(() => { console.warn = originalWarn; });

    const result = parser.walkApolloNode({}, {}, null, null, [], new Set(), 0, false);
    assert.equal(result, undefined);
    assert.equal(warned, true);
  });
});

test("search-response-parser: parseListingHtml without a requested or canonical property ID", () => {
  // candidateIds is empty in this case, which routes targetKey resolution through
  // the "any PropertyInfo/Property node" fallback search instead of ID matching.
  const apolloState = {
    "PropertyInfo:999": {
      rules: { __ref: "RulesBlock:1" },
    },
    "RulesBlock:1": {
      ruleList: [{ __ref: "RuleItem:1" }],
    },
    "RuleItem:1": {
      header: { text: "Pets" },
      value: "Dogs are welcome, up to 2 pets allowed.",
    },
  };
  const html = `<html><script>window.__APOLLO_STATE__ = ${JSON.stringify(apolloState)};</script></html>`;
  const result = parser.parseListingHtml(html, null, null);
  assert.ok(result);
  assert.equal(result.ok, true);
});

test("search-response-parser: extractPropertyIdFromUrl", async (t) => {
  await t.test("delegates to extract.extractPropertyId when available", () => {
    assert.equal(parser.extractPropertyIdFromUrl("https://www.vrbo.com/123456"), "123456");
  });

  await t.test("falls back to the built-in regex extractor when extract.extractPropertyId is unavailable", (t) => {
    const original = extract.extractPropertyId;
    delete extract.extractPropertyId;
    t.after(() => { extract.extractPropertyId = original; });

    assert.equal(parser.extractPropertyIdFromUrl("https://www.vrbo.com/123456"), "123456");
    assert.equal(parser.extractPropertyIdFromUrl("https://www.vrbo.com/about-us"), null);
    assert.equal(parser.extractPropertyIdFromUrl(null), null);
    assert.equal(parser.extractPropertyIdFromUrl("not a url", "also not a base"), null);
  });
});

test("search-response-parser: validateListingUrl returns null on a malformed URL/base pair", () => {
  assert.equal(parser.validateListingUrl("foo", "not a valid base"), null);
});
