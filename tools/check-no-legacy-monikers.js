#!/usr/bin/env node
// tools/check-no-legacy-monikers.js
// Regression guard: fails if the retired "vrbow"/"vdp" internal monikers
// (the pre-PawCheck product name and its CSS/DOM/storage-key prefix)
// reappear anywhere in tracked source. Run via
// `node tools/check-no-legacy-monikers.js`.
//
// Two known, deliberate exceptions — not regressions to chase down:
//   - CHANGELOG.md: dated historical entries accurately describe what was
//     true at each past release and are never retconned to match later
//     naming. Exempted for the whole file, not line-by-line — simpler,
//     and matches the changelog already being human-reviewed on every
//     edit rather than needing an automated guard of its own. The
//     tradeoff: a *new* CHANGELOG entry that regresses to "vrbow" text
//     outside a dated historical section would not be caught here.
//   - The literal substring "github.com/curdriceaurora/vrbow": the GitHub
//     repository itself has not been renamed. This check guards the
//     internal product/code monikers, not the repo's own name or URL —
//     that's a separate, larger decision (see PR discussion). Only the
//     matched URL substring is stripped before checking, not the whole
//     line — a line pairing the permitted URL with unrelated banned text
//     (e.g. "Vrbow source: https://github.com/curdriceaurora/vrbow")
//     still fails on the leftover "Vrbow".
//
// Uses `git grep`, which only searches tracked files and skips binary
// files automatically, rather than hand-rolling file discovery.

const { execFileSync } = require("node:child_process");

function gitGrep(pattern) {
  try {
    const out = execFileSync("git", ["grep", "-In", "-i", "-e", pattern], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch (err) {
    // git grep exits 1 when there are zero matches — not an error here.
    if (err.status === 1) return [];
    throw err;
  }
}

function main() {
  const EXEMPT_FILE_PREFIX = "CHANGELOG.md:";
  const SELF_PREFIX = "tools/check-no-legacy-monikers.js:";
  const EXEMPT_URL = /github\.com\/curdriceaurora\/vrbow/gi;
  const BANNED = /vrbow|vdp/i;

  const hits = [...gitGrep("vrbow"), ...gitGrep("vdp")].filter((line) => {
    if (line.startsWith(EXEMPT_FILE_PREFIX)) return false;
    if (line.startsWith(SELF_PREFIX)) return false;
    // Strip only the permitted URL substring, then re-check what's left —
    // exempting the URL must not also exempt unrelated banned text that
    // happens to share its line.
    return BANNED.test(line.replace(EXEMPT_URL, ""));
  });

  const unique = Array.from(new Set(hits)).sort();

  if (unique.length > 0) {
    console.error(`❌ Found ${unique.length} legacy vrbow/vdp reference(s) in tracked files:\n`);
    for (const line of unique) console.error(`  ${line}`);
    console.error("\nIf this is a deliberate, new exception (not a regression), update the EXEMPT rules in this script.");
    process.exit(1);
  }

  console.log("✅ No legacy vrbow/vdp monikers found in tracked source.");
}

main();
