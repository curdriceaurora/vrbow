// Listing-page policy discovery and summary panel.
(function initPdpPanel(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PawPdpPanel = api;
  }
})(globalThis, (root) => {
  function createPdpPanel(deps = {}) {
    const PANEL_ID = "paw-panel";
    const { getSentences, isPetRelated, buildCorpus, extractPolicy } = root.PawExtract;
    const { escapeHtml } = root.PawFormatters;
    const siteRegistry = deps.siteRegistry;
    const getListingIdFromUrl = deps.getListingIdFromUrl;
    const isListingUrl = deps.isListingUrl;
    const looksLikeListingPage = deps.looksLikeListingPage;
    const safeStorageSet = deps.safeStorageSet;
    const scheduleRescan = deps.scheduleRescan || (() => {});
    const withMutationsSuppressed = deps.withMutationsSuppressed || ((work) => work());
    const onPolicy = deps.onPolicy || (() => {});
    const { serializeSearchPolicyForCache } = root.PawSearchCache;
    const LAST_POLICY_TTL_MS = 24 * 60 * 60 * 1000;

    let latestApolloPayload = null;
    let isScanning = false;
    let pendingRescan = false;

  // Click anything that looks like a "show more / read more / expand"
  // toggle inside likely-relevant sections, and briefly scroll any
  // still-empty lazyload placeholders into view so they mount, then
  // restore scroll position. Best-effort; safe to no-op if nothing found.
  // The MutationObserver is suppressed while this runs so our own DOM
  // pokes don't trigger a feedback loop of rescans.
  // Text harvested from dialogs this pass opened, since closing them again
  // takes the content back out of the DOM.
  //
  // Tagged with the URL it came from, and ignored the moment that stops
  // matching. Harvested text is the one piece of listing content that
  // outlives the DOM it came from, so on an SPA hop to another listing it
  // would otherwise be presented as the new property's pet policy — and
  // because it also satisfies the "do we have pet data yet" gate, the new
  // listing's own dialog would never be opened. Someone could book on it.
  // The URL tag holds even if the navigation detector misses the change.
  let harvestedDialogText = [];
  let harvestedForUrl = null;

  function visibleDialogs() {
    return Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => d.getClientRects().length > 0);
  }

  // Dialogs this extension caused to open, remembered across passes.
  //
  // Without this, a dialog we opened but failed to handle in time gets
  // treated as pre-existing by the NEXT pass — grandfathered as the
  // user's own — so it is never harvested and never closed, and a second
  // click adds another one beside it. Our leftovers must stay ours.
  const ownedDialogs = new WeakSet();

  // Watched for the FULL budget, with no early exit. An earlier version
  // stopped once two polls were quiet, which is the same "it will have
  // mounted by now" guess as the original fixed 400ms wait — just with a
  // bigger number, and it missed a dialog mounting at 1.7s exactly as the
  // 400ms version missed one at 700ms. Any threshold is wrong for some
  // page, and the early exit was optimising a cost that is not paid on
  // normal listings anyway: this whole pass only runs when we have no pet
  // data, or when the user explicitly asked for a rescan.
  const DIALOG_WATCH_MS = 4000;
  const DIALOG_POLL_MS = 250;

  // Clicking a control and waiting a fixed 400ms assumed the dialog mounts
  // within it. Vrbo's did; a slower one (measured at 700ms) was missed
  // entirely. Watch for a while instead, handling each dialog as it
  // appears, for the whole budget — see DIALOG_WATCH_MS above for why
  // there is deliberately no early exit.
  async function harvestAndCloseDialogs(preexisting) {
    const deadline = Date.now() + DIALOG_WATCH_MS;
    const handledThisPass = new Set();

    while (Date.now() < deadline) {
      for (const dialog of visibleDialogs()) {
        const isOurs = ownedDialogs.has(dialog) || !preexisting.has(dialog);
        if (!isOurs) continue;
        if (!handledThisPass.has(dialog)) {
          handledThisPass.add(dialog);
          ownedDialogs.add(dialog);
          // Harvest every pass it is still open: collectDomPetSentences
          // skips [role="dialog"] subtrees, so this is the only way the
          // text reaches the corpus.
          const text = dialog.innerText || "";
          if (text.trim()) harvestedDialogText.push({ text, source: "Property amenities" });
        }
        // Retried on later polls if the close didn't take.
        closeDialog(dialog);
      }
      await new Promise((r) => setTimeout(r, DIALOG_POLL_MS));
    }
    return handledThisPass.size;
  }

  function closeDialog(dialog) {
    const closer = dialog.querySelector('[aria-label*="close" i], button[title*="close" i]');
    if (closer) {
      try {
        closer.click();
        if (!dialog.getClientRects().length) return true;
      } catch (e) {
        /* fall through to Escape */
      }
    }
    // Escape as a fallback, for a dialog whose close control we don't
    // recognise. It bubbles from the dialog up to document by design —
    // that is how it reaches the site's handler — but that same handler
    // is usually global and closes whatever dialog IT considers topmost,
    // which can be one the user opened themselves. There is no way to
    // reach the site's handler without that risk, so only take it when no
    // foreign dialog is open. Leaving ours up is the lesser harm; closing
    // the user's is us breaking their page.
    // No Escape of any kind while someone else's dialog is open.
    //
    // A previous version tried a non-bubbling Escape first, on the theory
    // that it could only reach a handler attached to our own dialog. That
    // is wrong: a non-bubbling event still travels the CAPTURE phase from
    // window down to the target, so a site listening with
    // addEventListener("keydown", h, true) receives it either way and
    // closes whatever dialog it considers topmost — the user's. There is
    // no dispatch that reaches the site's handler for our dialog alone, so
    // the only safe answer is not to dispatch at all. Ours stays on screen;
    // the policy is still harvested and reported.
    const foreignOpen = visibleDialogs().some((d) => d !== dialog && !ownedDialogs.has(d));
    if (foreignOpen) return false;

    for (const bubbles of [false, true]) {
      for (const type of ["keydown", "keyup"]) {
        dialog.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles, cancelable: true }));
      }
      if (!dialog.getClientRects().length) return true;
    }
    return false;
  }

  async function expandCollapsedSections() {
    return withMutationsSuppressed(async () => {
    harvestedDialogText = [];
    harvestedForUrl = location.href;
    // Some of what we click opens a dialog rather than expanding in place —
    // Vrbo's "See all" is a plain button with no aria-haspopup to filter on,
    // and it puts a full-screen amenities dialog over the listing. Note
    // which dialogs were already open so we only touch our own.
    const dialogsBefore = new Set(visibleDialogs());
      const TOGGLE_TEXT_RE = /^(show more|show all|see more|see all|view more|view all|read more|expand|more( details| rules| info)?)$/i;
      // Sections whose collapsed content is plausibly pet-relevant.
      const SECTION_CTX_RE = /house rules|polic|amenit|about this (property|space|listing)|important information|\bpets?\b|\bdogs?\b/i;
      // aria-expanded="false" is used by plenty of chrome that has nothing
      // to do with the listing — account menus, date pickers, currency
      // switchers, filter drawers. Clicking those opened UI at random, so
      // a collapsed element now also has to sit in a relevant section and
      // outside the page's navigation/dialog furniture.
      const OFF_LIMITS = 'nav, header, footer, [role="navigation"], [role="dialog"], [role="menu"], [role="tablist"]';

      // Climb looking for a section heading, bounded by how much text the
      // ancestor holds rather than by a fixed depth. Depth alone is the
      // wrong axis in both directions: Vrbo nests buttons several wrapper
      // divs deep, so a shallow cap misses real toggles, while climbing
      // to a section/[id] container (or far enough to reach one) lands on
      // something big enough that "house rules" appears SOMEWHERE in it on
      // every listing — at which point this returns true for everything
      // and we're back to clicking the whole page.
      const MAX_SECTION_CHARS = 3000;

      function inRelevantSection(el) {
        let node = el.parentElement;
        for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
          const text = node.textContent || "";
          if (text.length > MAX_SECTION_CHARS) break;
          if (SECTION_CTX_RE.test(text)) return true;
        }
        return false;
      }

      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, [aria-expanded]')).filter((el) => {
        if (el.closest(OFF_LIMITS)) return false;
        const label = (el.textContent || el.getAttribute("aria-label") || "").trim();
        const isToggle = TOGGLE_TEXT_RE.test(label);
        const isAriaFalse = el.getAttribute("aria-expanded") === "false";
        if (!isToggle && !isAriaFalse) return false;
        if (!isToggle && isAriaFalse && !inRelevantSection(el)) return false;
        if (!(el.offsetParent !== null || el.getClientRects().length > 0)) return false;
        return true;
      });

      for (const el of candidates.slice(0, 25)) {
        try {
          el.click();
        } catch (e) {
          /* ignore */
        }
      }
      if (candidates.length) {
        await new Promise((r) => setTimeout(r, 400));
      }

      // Take the text out of anything we opened, then put the page back the
      // way we found it. The dialog is worth reading — Vrbo's amenities
      // dialog carries ~1.4KB of exactly the content the fallback wants —
      // but leaving it up covers the listing the user was reading.
      await harvestAndCloseDialogs(dialogsBefore);

      // Nudge any empty lazyload placeholders (Vrbo mounts content on
      // intersection) into view momentarily, then restore scroll.
      const placeholders = Array.from(document.querySelectorAll(".lazyload-wrapper, [id]"))
        .filter((el) => {
          if (el.id && !/polic|rule|amenit/i.test(el.id)) return false;
          return el.textContent.trim().length < 5;
        })
        .slice(0, 5);

      if (placeholders.length) {
        const prevX = window.scrollX;
        const prevY = window.scrollY;
        for (const el of placeholders) {
          el.scrollIntoView({ block: "center" });
          await new Promise((r) => setTimeout(r, 350));
        }
        window.scrollTo(prevX, prevY);
      }
    });
  }

  // Vrbo's search widget sits INSIDE <main>, and its pet-filter checkbox
  // ("I am traveling with pets", "If checked, only properties that allow
  // pets will be shown") is pet-related by every keyword test — it was
  // landing in the panel's notes as though the host had written it about
  // this property. Scoping to <main> isn't enough; what separates it from
  // listing prose is that it lives in form controls, which listing prose
  // never does. So walk text nodes and skip those subtrees.
  const DOM_EXCLUDE = 'label, form, button, select, textarea, input, nav, header, footer, script, style, [role="dialog"], [role="navigation"], [role="menu"], #paw-panel';

  // The site-specific categories live in site-registry.js's
  // getPdpSectionConfig (getSearchCardSelector above follows the same
  // registry-first pattern) so a second site's differently-shaped PDP can
  // supply its own selectors instead of content.js being Vrbo-only.
  //
  // No local copy of Vrbo's ~20-entry category tables here: manifest.json
  // loads shared/site-registry.js before content/content.js in the same
  // content-script bundle, so siteRegistry is always populated by the
  // time this runs — reg?.getPdpSectionConfig(...) never actually falls
  // through in production. If it somehow did (registry failed to load
  // entirely — a state severe enough that search-card detection above is
  // already broken too), degrading to "Listing details" for every section
  // is a reasonable floor, not a second source of truth to keep in sync.
  //
  // Resolved once and cached: the site adapter is determined by hostname,
  // which cannot change over one content-script instance's lifetime (an
  // in-page SPA navigation changes the URL path, never the domain), so
  // there's nothing to invalidate the cache on.
  let cachedPdpSectionConfig = null;
  function getPdpSectionConfig() {
    if (!cachedPdpSectionConfig) {
      const reg = siteRegistry;
      cachedPdpSectionConfig = reg?.getPdpSectionConfig(location.href) || {
        closeMatchers: [],
        headingCategories: [],
        labelCategories: [],
        fallbackLabel: "Listing details",
        fallbackShortLabel: "Listing",
      };
    }
    return cachedPdpSectionConfig;
  }

  function findSectionHeadingForElement(element) {
    const { closeMatchers, headingCategories, labelCategories, fallbackLabel } = getPdpSectionConfig();
    if (!element) return fallbackLabel;

    for (const { selector, label } of closeMatchers) {
      if (element.closest(selector)) return label;
    }

    let curr = element;
    for (let i = 0; i < 8 && curr && curr !== document.body; i++, curr = curr.parentElement) {
      const heading = curr.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], [class*="heading" i], [class*="title" i]');
      if (heading && heading !== element && !heading.contains(element)) {
        const text = heading.textContent?.trim();
        if (text && text.length > 2 && text.length < 50) {
          for (const { pattern, label } of headingCategories) {
            if (pattern.test(text)) return label;
          }
          return text;
        }
      }
      const attrLabel = curr.getAttribute("aria-label") || curr.getAttribute("data-stid") || curr.id;
      if (attrLabel) {
        for (const { pattern, label } of labelCategories) {
          if (pattern.test(attrLabel)) return label;
        }
      }
    }

    return fallbackLabel;
  }

  const QUICK_PET_CHECK = /\b(pets?|dogs?|canines?)\b/i;

  function collectDomPetSentences() {
    const root = document.querySelector("main") || document.body;
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const results = [];
    let node;
    while ((node = walker.nextNode())) {
      const rawText = node.textContent && node.textContent.trim();
      if (!rawText || !QUICK_PET_CHECK.test(rawText)) continue;
      const parent = node.parentElement;
      if (parent && parent.closest(DOM_EXCLUDE)) continue;

      let section = null;
      for (const sentence of getSentences(rawText)) {
        if (isPetRelated(sentence)) {
          if (!section) {
            section = findSectionHeadingForElement(parent);
          }
          results.push({ text: sentence, source: section });
        }
      }
    }
    // Dialogs we opened and closed again are no longer walkable, so their
    // text comes from the harvest instead — but only while we are still on
    // the listing it was taken from.
    if (harvestedForUrl === location.href) {
      for (const item of harvestedDialogText) {
        const text = typeof item === "string" ? item : item?.text;
        const source = (typeof item === "object" && item?.source) ? item.source : "Property amenities";
        for (const sentence of getSentences(text)) {
          if (isPetRelated(sentence)) {
            results.push({ text: sentence, source });
          }
        }
      }
    }
    return results;
  }

  // ---------- DOM helpers (jump-to-source) ----------

  function findNodeForSnippet(snippet) {
    if (!snippet) return null;
    const short = snippet.slice(0, 40);
    const root = document.querySelector("main") || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent && node.textContent.includes(short)) {
        return node.parentElement;
      }
    }
    return null;
  }

  function findHeadingFor(sourceLabel) {
    if (!sourceLabel) return null;
    let re = /house rules|polic/i;
    if (/about this property|about this space|description/i.test(sourceLabel)) re = /about this property|about this space|description/i;
    else if (/review|rating|feedback/i.test(sourceLabel)) re = /reviews|ratings/i;
    else if (/amenit/i.test(sourceLabel)) re = /amenit/i;
    else if (/host/i.test(sourceLabel)) re = /about the host|host/i;
    const candidates = document.querySelectorAll('h1,h2,h3,h4,[role="heading"],a[href^="#"],section,[data-stid]');
    for (const el of candidates) {
      if (re.test(el.textContent || "") || re.test(el.getAttribute("data-stid") || "")) return el;
    }
    return null;
  }

  function jumpToSnippet(snippet, source) {
    let el = findNodeForSnippet(snippet);
    if (!el) el = findHeadingFor(source);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("paw-highlight");
      setTimeout(() => el.classList.remove("paw-highlight"), 2200);
    }
  }

  // ---------- rendering ----------

  let panelResizeListener = null;
  let lastPanelMode = null; // 'beside' | 'constrained' | null
  let lastUserCollapsed = null; // boolean | null

  const DEFAULT_PDP_CONTENT_COLUMN_SELECTOR = '[data-stid="lodging-infosite-template-api-renderer"]';

  // Resolved once and cached, same reasoning as getPdpSectionConfig above —
  // this runs on every unthrottled window resize tick via updatePanelPosition,
  // and the site adapter can't change within one content-script instance.
  let cachedPdpContentColumnSelector = null;
  function getPdpContentColumnSelector() {
    if (!cachedPdpContentColumnSelector) {
      const reg = siteRegistry;
      cachedPdpContentColumnSelector = reg?.getPdpContentColumnSelector(location.href) || DEFAULT_PDP_CONTENT_COLUMN_SELECTOR;
    }
    return cachedPdpContentColumnSelector;
  }

  function updatePanelPosition(panel, isInitial) {
    if (!panel || !panel.isConnected) return;
    const renderer = document.querySelector(getPdpContentColumnSelector());
    const BESIDE_WIDTH = 340;
    // Hysteresis deadband: require >=350px margin to enter beside mode,
    // but only drop back to constrained mode if margin falls below 340px (panel width).
    const BESIDE_ENTER_MARGIN = 350;
    const BESIDE_EXIT_MARGIN = 340;

    let isBeside = false;
    let gap = 16;
    if (renderer) {
      const rect = renderer.getBoundingClientRect();
      const freeSpaceRight = window.innerWidth - rect.right;
      const threshold = lastPanelMode === "beside" ? BESIDE_EXIT_MARGIN : BESIDE_ENTER_MARGIN;

      if (freeSpaceRight >= threshold) {
        isBeside = true;
        gap = Math.max(10, Math.min(16, Math.floor((freeSpaceRight - BESIDE_WIDTH) / 2)));
        panel.style.left = `${Math.round(rect.right + gap)}px`;
        panel.style.right = "auto";
        panel.classList.add("paw-beside");
      }
    }

    if (!isBeside) {
      panel.style.left = "auto";
      panel.style.right = "16px";
      panel.classList.remove("paw-beside");
    }

    const currentMode = isBeside ? "beside" : "constrained";
    const modeChanged = lastPanelMode !== currentMode;
    lastPanelMode = currentMode;

    const header = panel.querySelector(".paw-header");

    if (modeChanged) {
      if (isBeside) {
        panel.classList.remove("paw-collapsed");
        if (header) header.setAttribute("aria-expanded", "true");
        lastUserCollapsed = false;
      } else {
        panel.classList.add("paw-collapsed");
        if (header) header.setAttribute("aria-expanded", "false");
        lastUserCollapsed = true;
      }
    } else if (isInitial && lastUserCollapsed !== null) {
      if (lastUserCollapsed) {
        panel.classList.add("paw-collapsed");
        if (header) header.setAttribute("aria-expanded", "false");
      } else {
        panel.classList.remove("paw-collapsed");
        if (header) header.setAttribute("aria-expanded", "true");
      }
    }
  }

  function removePanel(resetSession) {
    if (panelResizeListener) {
      window.removeEventListener("resize", panelResizeListener);
      panelResizeListener = null;
    }
    if (resetSession) {
      lastPanelMode = null;
      lastUserCollapsed = null;
    }
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
  }

  // Real source strings can be a combined "Section > Header" (see
  // formatSourceLabel in extract.js) — for the compact per-row jump link
  // we only want the lowest-level, linkable label (the header the
  // snippet actually lives under), not the full hierarchy.
  //
  // Several sources never get a distinct header at all: the DOM
  // text-scan fallback (findSectionHeadingForElement) only ever returns
  // one of a handful of coarse section names, so there's no ">" to split
  // on and the full name ("House Rules / Policies", 23 chars) would blow
  // right past the jump-link's column budget. Those coarse names carry
  // their own shortLabel right alongside label in the registry's PDP
  // section config (see getPdpSectionConfig) — build the lookup from
  // there instead of a second hardcoded table that could drift out of
  // sync with it, and that a second site's differently-named sections
  // wouldn't be covered by anyway.
  // Resolved once and cached, same reasoning as getPdpSectionConfig above —
  // this runs once per row rendered (every "Max dogs"/"Weight limit"/etc.
  // jump link), and its source config is itself invariant per page.
  let cachedShortSectionLabelLookup = null;
  function shortSectionLabelLookup() {
    if (!cachedShortSectionLabelLookup) {
      const { closeMatchers, headingCategories, labelCategories, fallbackLabel, fallbackShortLabel } =
        getPdpSectionConfig();
      const lookup = {
        // Not a PDP section name — extract.js's buildCorpus() falls back to
        // this literal string when a DOM-scanned sentence carries no source
        // at all, regardless of which site's page it came from.
        "visible page text": "Page text",
        [fallbackLabel.toLowerCase()]: fallbackShortLabel,
      };
      for (const { label, shortLabel } of [...closeMatchers, ...headingCategories, ...labelCategories]) {
        lookup[label.toLowerCase()] = shortLabel;
      }
      cachedShortSectionLabelLookup = lookup;
    }
    return cachedShortSectionLabelLookup;
  }
  function shortSourceLabel(source) {
    if (!source) return "";
    const parts = source.split(">").map((p) => p.trim()).filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : source.trim();
    return shortSectionLabelLookup()[last.toLowerCase()] || last;
  }

  // `value` is always escaped. Today every caller passes a literal or a
  // digits-only regex capture, so nothing can break out — but escaping
  // here means a future pattern that captures freeform listing text
  // can't turn into an injection point.
  //
  // `valueLines`, when passed, renders a genuinely compound value (e.g.
  // two fee conditions, two weight-limit clauses) as separate stacked
  // lines instead of one comma-joined sentence — the row grows taller,
  // the column never grows wider. Left unset for anything not already
  // structured as distinct pieces; we don't attempt to split arbitrary
  // freeform extracted text on commas, since a comma there isn't
  // reliably a clause boundary.
  function row(label, value, tone, snippet, source, alternates, valueLines) {
    const toneClass = tone ? `paw-tone-${tone}` : "";
    const jumpAttr = snippet ? `data-snippet="${encodeURIComponent(snippet)}" data-source="${encodeURIComponent(source || "")}"` : "";
    const jumpBtn = snippet
      ? `<button type="button" class="paw-jump" ${jumpAttr} title="Jump to where this was found in ${escapeHtml(source || "the listing")}">${escapeHtml(shortSourceLabel(source))} <span class="paw-jump-arrow">↗</span></button>`
      : "";
    const altHtml =
      alternates && alternates.length
        ? `<div class="paw-alt">⚠ Listing also states elsewhere: ${alternates
            .map((a) => `<strong>${escapeHtml(a.value)}</strong> (${escapeHtml(a.source || "")})`)
            .join("; ")}</div>`
        : "";
    const valueHtml =
      valueLines && valueLines.length > 1
        ? valueLines.map((line) => `<span class="paw-value-line">${escapeHtml(line)}</span>`).join("")
        : escapeHtml(value);
    return `<div class="paw-row">
      <span class="paw-label">${label}</span>
      <span class="paw-value ${toneClass}">${valueHtml}${altHtml}</span>
      ${jumpBtn}
    </div>`;
  }

  // Pure, DOM-free decision for the fully-sparse panel state (renderPanel
  // below), split out so it's directly unit-testable without mocking
  // document.createElement — the fully-sparse branch has real user-facing
  // wording bugs to guard against (this is the exact split that fixed
  // Airbnb's majority "allowed, no other detail" case reading as
  // "unknown"), so its logic deserves a test that doesn't also depend on
  // panel DOM construction.
  function sparseStateMessage(petsAllowed) {
    if (petsAllowed === true) {
      // We DO have an answer (pets are allowed) — just no fine print.
      // Showing the plain "weren't stated" wording here (as if nothing
      // at all were known) would read as broken on a listing that
      // affirmatively said yes. paw-tone-good is the same global tone
      // utility used elsewhere (badges, header) — no new CSS needed.
      return {
        text: "Allowed, no additional restrictions listed. Max dogs, weight limit, fee, and pre-registration weren't stated anywhere on this listing.",
        toneClass: " paw-tone-good",
      };
    }
    // petsAllowed itself isn't confirmed true — genuinely no answer, not
    // just no fine print. Neutral wording, no tone class.
    return {
      text: "Max dogs, weight limit, fee, and pre-registration weren't stated anywhere on this listing.",
      toneClass: "",
    };
  }

  function buildPanelMarkup(policy) {
    let rowsHtml = "";
    let headline = "";
    let headlineTone = "neutral";
    let isFullySparse = false;
    const raw = policy._raw || policy;

    // Computed up front (not just for the footer) because the sparse
    // branch below folds this same text into its one summary line
    // instead of also rendering a separate footer.
    const entries = raw.entries || policy.entries;
    const found = raw.found ?? policy.found ?? policy.restrictionsFound;
    const usedApollo = entries && entries.some((e) => e.priority > 1);

    const calloutSources = [
      raw.petsAllowedSource,
      raw.maxDogsSource,
      raw.weightSource,
      raw.preRegSource,
      raw.feeSource,
      raw.depositSource,
    ].filter(Boolean);

    const hasReviewCallout = calloutSources.some((s) => /review|rating/i.test(s));
    const hasNonReviewCallout = calloutSources.some((s) => !/review|rating/i.test(s));

    let sourceBadge = "";
    if (found) {
      if (hasReviewCallout && (usedApollo || hasNonReviewCallout)) {
        sourceBadge = usedApollo
          ? "Source: listing data + review"
          : "Source: visible page text + review";
      } else if (hasReviewCallout) {
        sourceBadge = "Source: review";
      } else if (usedApollo) {
        sourceBadge = "Source: listing data (incl. collapsed/lazy sections)";
      } else {
        sourceBadge = "Source: visible page text only";
      }
    }

    // Title stays a static "Dog policy" across every state — matching the
    // search tooltip's header, which never changes text either — so the
    // panel and tooltip read as the same widget. Status is conveyed by
    // headlineTone (the header's background color) and the row/body
    // content below, not by swapping the title itself.
    headline = "Dog policy";
    if (policy.petsAllowed === false) {
      headlineTone = "bad";
      rowsHtml = row("Policy", "No pets allowed", "bad", raw.petsAllowedSnippet, raw.petsAllowedSource);
    } else if (!raw.found && !policy.restrictionsFound) {
      headlineTone = "unknown";
      rowsHtml = `<div class="paw-empty">This page didn't mention pets/dogs in its listing data or visible text. Try Rescan after the page fully loads, or check House Rules manually.</div>`;
    } else {
      headlineTone = policy.petsAllowed === true ? "good" : "unknown";

      const notes = raw.otherNotes || [];
      const hasWeight = Boolean(policy.weightLimit || raw.weightPerDog);
      const hasPreReg = Boolean(policy.approvalRequired || raw.preReg);
      const hasFeeAmount = Boolean(policy.fee && policy.fee.amount !== null);
      const hasFeeText = Boolean(raw.fee);

      isFullySparse =
        policy.maxDogs === null &&
        !hasWeight &&
        !hasPreReg &&
        !hasFeeAmount &&
        !hasFeeText &&
        !policy.deposit &&
        !raw.deposit &&
        !notes.length;

      if (isFullySparse) {
        const { text, toneClass } = sparseStateMessage(policy.petsAllowed);
        rowsHtml = `<div class="paw-unconfirmed">
          <p class="paw-unconfirmed-text${toneClass}">${text}</p>
          ${sourceBadge ? `<span class="paw-unconfirmed-src">${escapeHtml(sourceBadge)}</span>` : ""}
        </div>`;
      } else {
        rowsHtml += `<div class="paw-group-hd">Dog limits</div>`;
        rowsHtml += row(
          "Max dogs",
          policy.maxDogs !== null ? `${policy.maxDogs}` : "Not specified",
          policy.maxDogs !== null ? "good" : "unknown",
          raw.maxDogsSnippet,
          raw.maxDogsSource,
          raw.maxDogsAlternates
        );
        rowsHtml += row(
          "Weight limit",
          policy.weightLimit ? `${policy.weightLimit.value} ${policy.weightLimit.unit === "lb" ? "lbs" : policy.weightLimit.unit}` : (raw.weightPerDog || "Not specified"),
          hasWeight ? "good" : "unknown",
          raw.weightSnippet,
          raw.weightSource,
          raw.weightAlternates
        );
        rowsHtml += `<div class="paw-group-hd">Cost &amp; approval</div>`;
        let feePerStr = "";
        if (policy.fee) {
          if (policy.fee.perPet && policy.fee.period && policy.fee.period !== "unknown" && policy.fee.period !== "pet") {
            feePerStr = ` per pet per ${policy.fee.period}`;
          } else if (policy.fee.period && policy.fee.period !== "unknown") {
            feePerStr = ` per ${policy.fee.period}`;
          }
        }
        const isTieredFee = policy.fee?.tiered || (policy.fee?.text && /\$0\s+(?:1st|first)/i.test(policy.fee.text));
        let feeDisplay;
        let feeValueLines = null;
        if (isTieredFee) {
          if (policy.fee.text) {
            // Extracted freeform text — its shape isn't guaranteed to be
            // two clean clauses, so it's shown as a single value rather
            // than guessed-split on a comma that might not be a clause
            // boundary.
            feeDisplay = policy.fee.text;
          } else {
            // feeDisplay stays unset here — row() renders feeValueLines
            // instead and never reads the plain-string value once it has
            // more than one line.
            feeValueLines = ["1st dog free", "subsequent fee applies"];
          }
        } else if (hasFeeAmount) {
          feeDisplay = typeof PawExtract?.formatCurrencyDisplay === "function"
            ? `${PawExtract.formatCurrencyDisplay(policy.fee.amount, policy.fee.currency)}${feePerStr}`
            : `$${policy.fee.amount}${feePerStr}`;
        } else {
          feeDisplay = raw.fee || "Not specified";
        }

        rowsHtml += row(
          "Fee",
          feeDisplay,
          policy.fee && policy.fee.amount > 0 ? "warn" : policy.fee && policy.fee.amount === 0 ? "good" : (raw.fee && raw.fee !== "No fee mentioned" ? "warn" : "unknown"),
          raw.feeSnippet,
          raw.feeSource,
          raw.feeAlternates,
          feeValueLines
        );
        if (policy.deposit || raw.deposit) {
          const depDisplay = policy.deposit && policy.deposit.amount !== null
            ? (typeof PawExtract?.formatCurrencyDisplay === "function" ? PawExtract.formatCurrencyDisplay(policy.deposit.amount, policy.deposit.currency) : `$${policy.deposit.amount}`)
            : raw.deposit;
          rowsHtml += row("Refundable deposit", depDisplay, "warn", raw.depositSnippet, raw.depositSource);
        }
        rowsHtml += row(
          "Pre-registration",
          hasPreReg ? "Required" : "Not mentioned",
          hasPreReg ? "warn" : "unknown",
          raw.preRegSnippet,
          raw.preRegSource
        );

        if (notes.length) {
          // Repeated attribution reads as noise, not signal: two snippets
          // from the same source get one card (one shared source line)
          // instead of two near-identical cards. Grouped by first
          // appearance, not sorted — but the "(N)" count still reflects
          // total snippets found, since that's "how many facts", separate
          // from how they're packaged into cards.
          const groups = [];
          const bySource = new Map();
          for (const n of notes) {
            const key = n.source || "";
            let group = bySource.get(key);
            if (!group) {
              group = { source: n.source, quotes: [] };
              bySource.set(key, group);
              groups.push(group);
            }
            group.quotes.push(n.text);
          }
          rowsHtml += `<div class="paw-other-toggle">Other pet notes (${notes.length}) ▾</div>
            <div class="paw-other-list">
              ${groups
                .map(
                  (g) =>
                    `<div class="paw-other-item">${g.quotes
                      .map((q) => `<span class="paw-other-quote">"${escapeHtml(q)}"</span>`)
                      .join("")}<span class="paw-other-source">— ${escapeHtml(g.source)}</span></div>`
                )
                .join("")}
            </div>`;
        }
      }
    }

    return `
      <div class="paw-header paw-tone-${headlineTone}" tabindex="0" role="button" aria-expanded="true" aria-label="Toggle dog policy details">
        <span class="paw-title">${headline}</span>
        <div class="paw-header-btns">
          <button type="button" class="paw-rescan" title="Rescan page">↻</button>
          <button type="button" class="paw-close" title="Close">×</button>
        </div>
      </div>
      <div class="paw-body">
        ${rowsHtml}
        ${!isFullySparse && sourceBadge ? `<div class="paw-source-badge">${sourceBadge}</div>` : ""}
      </div>
    `;
  }

  function renderPanel(policy) {
    removePanel();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    panel.innerHTML = buildPanelMarkup(policy);

    document.documentElement.appendChild(panel);
    updatePanelPosition(panel, true);

    if (panelResizeListener) {
      window.removeEventListener("resize", panelResizeListener);
    }
    panelResizeListener = () => {
      updatePanelPosition(panel, false);
    };
    window.addEventListener("resize", panelResizeListener);

    panel.querySelector(".paw-close").addEventListener("click", () => removePanel());
    panel.querySelector(".paw-rescan").addEventListener("click", () => scan(true));
    panel.querySelectorAll(".paw-jump").forEach((btn) => {
      btn.addEventListener("click", () => {
        const snippet = decodeURIComponent(btn.getAttribute("data-snippet"));
        const source = decodeURIComponent(btn.getAttribute("data-source") || "");
        jumpToSnippet(snippet, source);
      });
    });
    const otherToggle = panel.querySelector(".paw-other-toggle");
    if (otherToggle) {
      otherToggle.addEventListener("click", () => {
        panel.querySelector(".paw-other-list").classList.toggle("paw-visible");
      });
    }

    const header = panel.querySelector(".paw-header");
    const toggleCollapse = (e) => {
      if (e.target.closest("button")) return;
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      if (e.type === "keydown") e.preventDefault();
      panel.classList.toggle("paw-collapsed");
      const isCollapsed = panel.classList.contains("paw-collapsed");
      lastUserCollapsed = isCollapsed;
      header.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    };
    header.addEventListener("click", toggleCollapse);
    header.addEventListener("keydown", toggleCollapse);
  }

  // ---------- scan orchestration ----------

  // Vrbo's structured PDP data arrives via the paw-apollo-data event from
  // page-bridge.js (a MAIN-world bridge, needed because window.__APOLLO_STATE__
  // isn't reachable from the isolated world). Airbnb's data is plain DOM
  // text content instead (#data-deferred-state-0), readable directly from
  // this world with no bridge — so its adapter exposes a synchronous
  // getPdpStructuredPayload() rather than needing an event listener.
  // Resolved fresh on every call, never cached: unlike the PDP DOM
  // selectors/section-config (invariant for one content-script instance's
  // lifetime), this is the actual page content and must reflect whatever
  // the current listing's page just rendered.
  // The `|| latestApolloPayload` fallback is the one place this doesn't
  // match every sibling getter's site?.X || DEFAULT_X shape (those
  // defaults live entirely inside site-registry.js; this one reaches into
  // a content.js-local variable). Considered moving it there — giving
  // vrboSite its own getPdpStructuredPayload — but vrboSite is defined in
  // site-registry.js's own module closure, with no access to
  // latestApolloPayload, which only content.js's page-bridge.js event
  // listener populates; closing over it from the other module isn't
  // possible without content.js reaching back in to mutate vrboSite after
  // the fact, which trades this one documented special case for a
  // cross-module mutation of another module's object — not clearly an
  // improvement. Left as-is.
  function getStructuredPdpPayload() {
    const reg = siteRegistry;
    const payload = reg?.getPdpStructuredPayload?.(location.href);
    return payload || latestApolloPayload;
  }

  async function scan(force) {
    // Don't drop a scan request that lands while one is in flight. The
    // expand pass can hold the lock for a couple of seconds, and the
    // rescan onUrlMaybeChanged schedules at 1200ms falls inside exactly
    // that window — so a dropped request meant a listing could keep the
    // previous one's panel until some unrelated mutation happened to
    // trigger another scan.
    if (isScanning) {
      pendingRescan = true;
      return;
    }
    if (!isListingUrl(location.href) || (!force && !looksLikeListingPage())) {
      removePanel();
      return;
    }
    isScanning = true;
    // Everything below describes THIS listing. scan() awaits, and an SPA
    // hop during an await leaves the rest of this function computing an
    // answer for a page that is no longer on screen — so bail rather than
    // render it. onUrlMaybeChanged has already cleared state and queued a
    // fresh scan for the new listing.
    const startUrl = location.href;
    try {
      // Decide whether to poke the DOM by asking whether we actually have
      // pet information yet — not merely whether the Apollo payload was
      // non-empty. A payload can be well populated with unrelated text
      // while the pet policy sits behind a "See all" control, and keying
      // on item count alone reported "No dog policy details detected" on
      // exactly those listings. A forced rescan always expands, since the
      // user asking for one is asking us to look harder.
      //
      // Computed once and reused across both buildCorpus calls below:
      // expandCollapsedSections() only reveals more visible DOM text for
      // collectDomPetSentences() — it can't change a site's structured
      // payload (Airbnb's #data-deferred-state-0 is embedded once at SSR
      // time; Vrbo's Apollo state is likewise fixed per navigation), so
      // re-deriving it on the second pass would just re-run the same
      // JSON.parse + tree walk for a byte-identical result. That's not
      // free for Airbnb specifically: its toggle-only case (no entries on
      // the first pass, hence the *common* trigger for this second pass)
      // means the redundant walk would fire on a majority of real scans,
      // not an edge case.
      const structuredPayload = getStructuredPdpPayload();
      let entries = buildCorpus(structuredPayload, collectDomPetSentences());
      if (!entries.length || force) {
        await expandCollapsedSections();
        if (location.href !== startUrl) return;
        entries = buildCorpus(structuredPayload, collectDomPetSentences());
      }
      if (location.href !== startUrl) return;
      const rawPolicy = extractPolicy(entries);
      const propId = getListingIdFromUrl(startUrl);
      const canonicalPolicy = typeof PawExtract?.normalizePolicy === "function"
        ? PawExtract.normalizePolicy(rawPolicy, propId, "listing-page")
        : rawPolicy;
      safeStorageSet({
        pawLastPolicy: serializeSearchPolicyForCache(canonicalPolicy),
        pawLastUrl: startUrl,
        pawLastPolicyExpiresAt: Date.now() + LAST_POLICY_TTL_MS,
      });
      renderPanel(canonicalPolicy);
      onPolicy({ policy: canonicalPolicy, url: startUrl });
    } finally {
      isScanning = false;
      if (pendingRescan) {
        pendingRescan = false;
        scheduleRescan(300);
      }
    }
  }


    function reset() {
      latestApolloPayload = null;
      harvestedDialogText = [];
      harvestedForUrl = null;
      removePanel(true);
    }

    return {
      scan,
      render: renderPanel,
      remove: removePanel,
      reset,
      setApolloData: (payload) => { latestApolloPayload = payload; },
      __test: {
        sparseStateMessage,
        expandCollapsedSections,
        collectDomPetSentences,
        visibleDialogs,
        closeDialog,
        findSectionHeadingForElement,
        findNodeForSnippet,
        findHeadingFor,
        jumpToSnippet,
        getPdpContentColumnSelector,
        updatePanelPosition,
        shortSourceLabel,
        row,
        getStructuredPdpPayload,
        renderPanel,
        buildPanelMarkup,
        removePanel,
        scan,
        getPanel: () => root.document?.getElementById(PANEL_ID) || null,
      },
    };
  }

  return { createPdpPanel };
});
