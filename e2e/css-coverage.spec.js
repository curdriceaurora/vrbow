const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { expect, test } = require("@playwright/test");
const { installNetworkGuard } = require("./guardrail");

const FIXTURES = path.join(__dirname, "..", "test", "fixtures");
const TARGET_STYLESHEETS = new Set(["tokens.css", "content.css", "popup.css"]);

function mergeRanges(ranges) {
  const sorted = ranges.map(({ start, end }) => [start, end]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const current of sorted) {
    const previous = merged.at(-1);
    if (!previous || current[0] > previous[1]) merged.push(current);
    else previous[1] = Math.max(previous[1], current[1]);
  }
  return merged;
}

function uncoveredSource(text, ranges) {
  const gaps = [];
  let cursor = 0;
  for (const [start, end] of mergeRanges(ranges)) {
    if (start > cursor) gaps.push(text.slice(cursor, start));
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) gaps.push(text.slice(cursor));

  return gaps.join("")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media[^\{]+/g, "")
    .replace(/[\s{}]/g, "");
}

test("exercises 100% of production theme rules across color schemes and forced colors", async ({ browser }) => {
  const aggregate = new Map();

  for (const contextConfig of [{ colorScheme: "light" }, { colorScheme: "dark" }, { forcedColors: "active" }]) {
    for (const fixture of ["panel-theme.html", "popup-theme.html"]) {
      const context = await browser.newContext(contextConfig);
      const page = await context.newPage();
      const guard = await installNetworkGuard(context, page);
      await page.coverage.startCSSCoverage({ resetOnNavigation: false });
      await page.goto(pathToFileURL(path.join(FIXTURES, fixture)).href);

      if (fixture.startsWith("panel")) {
        const button = page.locator("#paw-panel button").first();
        await button.hover();
        await button.focus();

        const jumpLink = page.locator("#paw-panel .paw-jump").first();
        await jumpLink.hover();
        await jumpLink.focus();

        const searchBadge = page.locator(".paw-search-badge").first();
        await searchBadge.hover();
        await searchBadge.focus();

        const tooltipClose = page.locator(".paw-tooltip-close");
        await tooltipClose.hover();
        await tooltipClose.focus();

        const tooltipLink = page.locator(".paw-tooltip-footer a");
        await tooltipLink.hover();
        await tooltipLink.focus();

        await page.locator("#paw-panel").evaluate((panel) => {
          panel.classList.add("paw-beside");
          getComputedStyle(panel).width;
          for (const row of panel.querySelectorAll(".paw-row")) {
            getComputedStyle(row).gridTemplateColumns;
          }
          panel.classList.remove("paw-beside");
          panel.classList.add("paw-collapsed");
          const header = panel.querySelector(".paw-header");
          header.className = "paw-header paw-tone-bad";
          getComputedStyle(header).backgroundColor;
          header.className = "paw-header paw-tone-unknown";
          getComputedStyle(header).backgroundColor;
          header.className = "paw-header paw-tone-loading";
          getComputedStyle(header).backgroundColor;
          header.className = "paw-header paw-tone-capped";
          getComputedStyle(header).backgroundColor;
          // .paw-row + .paw-row (the inter-row hairline) is exercised
          // naturally by any two adjacent rows in the fixture below.
        });

        await page.evaluate(() => {
          for (const badge of document.querySelectorAll(".paw-search-badge")) {
            getComputedStyle(badge).backgroundColor;
            getComputedStyle(badge).color;
          }
          const warnBadge = document.createElement("span");
          warnBadge.className = "paw-search-badge paw-badge-warn";
          document.body.appendChild(warnBadge);
          getComputedStyle(warnBadge).backgroundColor;

          for (const row of document.querySelectorAll(".paw-tooltip-row")) {
            getComputedStyle(row).borderTopStyle;
          }
          for (const line of document.querySelectorAll(".paw-tooltip-val-line")) {
            getComputedStyle(line).display;
            getComputedStyle(line).marginTop;
          }
        });
      } else {
        const button = page.locator("#rescan");
        await button.hover();
        await button.focus();
        await page.evaluate(() => {
          const finalRow = document.createElement("div");
          finalRow.className = "row";
          document.body.appendChild(finalRow);
          getComputedStyle(finalRow).borderBottomStyle;

          const settings = document.createElement("div");
          settings.className = "settings";
          const label = document.createElement("label");
          label.className = "toggle-label";
          const input = document.createElement("input");
          input.type = "checkbox";
          label.appendChild(input);
          settings.appendChild(label);
          document.body.appendChild(settings);
          getComputedStyle(settings).borderTopStyle;
          getComputedStyle(label).display;
          getComputedStyle(input).cursor;
        });
      }

      for (const entry of await page.coverage.stopCSSCoverage()) {
        const filename = path.basename(new URL(entry.url).pathname);
        if (!TARGET_STYLESHEETS.has(filename)) continue;
        const current = aggregate.get(filename) || { text: entry.text, ranges: [] };
        current.ranges.push(...entry.ranges);
        aggregate.set(filename, current);
      }
      await guard.assertNoLeakedRequests(page);
      await context.close();
    }
  }

  expect(new Set(aggregate.keys())).toEqual(TARGET_STYLESHEETS);
  for (const [filename, coverage] of aggregate) {
    expect(uncoveredSource(coverage.text, coverage.ranges), `${filename} contains an unexercised theme rule`).toBe("");
  }
});
