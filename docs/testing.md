# Testing Guide

This document describes the automated and live validation paths for the extension.

Install the development dependencies once:

```bash
npm install
npx playwright install chromium
```

---

## 1. Complete Automated Validation

Run this command in your terminal:

```bash
npm run test:all
```

This command:

- Checks JavaScript syntax for the shared registry, adapters, extractors, formatters, content modules, page bridge, and popup.
- Runs the complete Node unit and integration suite with coverage enabled.
- Enforces at least 90% line, 75% branch, and 85% function coverage for `lifecycle.js`, `pdp-panel.js`, `search-badges.js`, the shared extraction and search modules, the site registry, and both site adapters.
- Runs the complete Playwright browser suite with at most two workers and blocks unexpected external network traffic.
- Verifies extraction, formatting, URL and extension lifecycle behavior, Chrome storage failures, request pacing, card recycling, async stale-result guards, focus handling, theme behavior, and browser-path JavaScript coverage.

To run only the Node tests without coverage gates:

```bash
npm test
```

To run the Node coverage gates without Playwright:

```bash
npm run test:coverage
```

## 2. Playwright Browser and Theme Tests

Run the complete light and dark browser matrix:

```bash
npm run test:theme
```

The Playwright suite includes the light and dark theme matrix, listing and search flows, Airbnb and Expedia adapter scenarios, and production JavaScript coverage. It verifies every policy tone, shared-token loading, host-page isolation, keyboard focus indicators, viewport containment, and WCAG AA text and non-text contrast in both color schemes. A Chromium CSS coverage gate fails if any production rule in `tokens.css`, `content.css`, or `popup.css` is not exercised; required theme-rule coverage is 100%.

---

## 3. Live Browser Test Harness

Run this command to test live Vrbo listings in Chrome:

```bash
node tools/live-check.js
```

### Options
- Test a specific listing: `node tools/live-check.js 2688106`
- Test multiple listings: `node tools/live-check.js --sample 5`
- Test all listings: `node tools/live-check.js --all`

### Verification Criteria
A listing passes only when:
1. The extension renders the summary card.
2. `page-bridge.js` extracts structured Apollo data from the page world.
3. Isolated-world script variables remain separate from the page world.

### Exit Codes
| Exit Code | Meaning | Description |
|---|---|---|
| `0` | Pass | All listings passed verification. |
| `1` | Failure | The extension or manifest failed to execute. |
| `2` | Inconclusive | The page showed a bot challenge or served no data. |

---

## Rate Limiting

Vrbo can show bot verification pages after many rapid requests.
The harness waits 4000 ms between listings by default.
To change the delay:

```bash
node tools/live-check.js --sample 5 --delay 5000
```
