// Unit tests for the shared, pure formatting helpers.
//   node --test
//
// formatters.js is otherwise only exercised indirectly, as a global stub
// loaded ahead of content.js in test/helpers/content-env-stub.js. These
// tests cover escapeHtml and formatMoney directly.

const test = require("node:test");
const assert = require("node:assert");
const { escapeHtml, formatMoney, CURRENCY_SYMBOLS } = require("../src/shared/formatters.js");

test("escapeHtml", async (t) => {
  await t.test("escapes each reserved HTML character", () => {
    assert.strictEqual(escapeHtml("&"), "&amp;");
    assert.strictEqual(escapeHtml("<"), "&lt;");
    assert.strictEqual(escapeHtml(">"), "&gt;");
    assert.strictEqual(escapeHtml('"'), "&quot;");
    assert.strictEqual(escapeHtml("'"), "&#39;");
  });

  await t.test("escapes multiple occurrences in one string", () => {
    assert.strictEqual(escapeHtml(`<script>alert("x" & 'y')</script>`), "&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;");
  });

  await t.test("leaves non-reserved characters untouched", () => {
    assert.strictEqual(escapeHtml("Dogs up to 25 lbs, no fee."), "Dogs up to 25 lbs, no fee.");
  });

  await t.test("coerces non-string input via String()", () => {
    assert.strictEqual(escapeHtml(42), "42");
    assert.strictEqual(escapeHtml(null), "null");
    assert.strictEqual(escapeHtml(undefined), "undefined");
  });
});

test("formatMoney", async (t) => {
  await t.test("formats a known currency with its symbol, defaulting to USD", () => {
    assert.strictEqual(formatMoney(100), "$100");
    assert.strictEqual(formatMoney(50, "EUR"), "€50");
    assert.strictEqual(formatMoney(0, "GBP"), "£0");
  });

  await t.test("covers every declared currency symbol", () => {
    for (const [code, sym] of Object.entries(CURRENCY_SYMBOLS)) {
      assert.strictEqual(formatMoney(1, code), `${sym}1`);
    }
  });

  await t.test("normalizes currency code casing and whitespace", () => {
    assert.strictEqual(formatMoney(75, "eur"), "€75");
    assert.strictEqual(formatMoney(75, "  cad  "), "CA$75");
  });

  await t.test("falls back to 'CODE ' prefix for an unrecognized currency", () => {
    assert.strictEqual(formatMoney(30, "XYZ"), "XYZ 30");
  });

  await t.test("falls back to USD when currency is missing or falsy", () => {
    assert.strictEqual(formatMoney(20, ""), "$20");
    assert.strictEqual(formatMoney(20, null), "$20");
    assert.strictEqual(formatMoney(20, undefined), "$20");
  });

  await t.test("returns an empty string for non-numeric amounts", () => {
    assert.strictEqual(formatMoney("100"), "");
    assert.strictEqual(formatMoney(null), "");
    assert.strictEqual(formatMoney(undefined), "");
  });

  await t.test("treats NaN as the number it is, not as non-numeric", () => {
    // typeof NaN === "number", so the non-numeric guard doesn't catch it.
    assert.strictEqual(formatMoney(NaN), "$NaN");
  });
});
