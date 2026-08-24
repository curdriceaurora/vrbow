// search-response-parser.js
// Turns a fetched listing response (HTML or a search-page Apollo record) into a
// normalized pet policy, plus the URL helpers used to identify and validate listing
// pages. No queueing, pacing, or caching concerns live here.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./extract.js"));
  } else {
    root.PawSearchResponseParser = factory(root.PawExtract);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (extract) {
  "use strict";

  /**
   * Walk Apollo graph with full __ref pointer resolution and support for header.text and value/text leaves.
   * Delegates to shared pure extractor in extract.js.
   */
  function walkApolloNode(state, node, headerCtx, sectionCtx, out, visited, depth, isExplicitPetContext) {
    if (extract && typeof extract.walkApolloNode === "function") {
      return extract.walkApolloNode(state, node, headerCtx, sectionCtx, out, visited, depth, isExplicitPetContext);
    }
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("[pawcheck] extract.walkApolloNode is unavailable; check script load order");
    }
  }

  /**
   * Parse raw listing HTML into an extract.js-compatible corpus.
   * Resolves Apollo state JSON with __ref references or extracts from HTML sections.
   */
  function parseListingHtml(html, propertyId, canonicalId) {
    if (!html || typeof html !== "string") return null;

    // Check for bot challenges or error pages
    if (/challenge-running|bot or not|cf-browser-verification|captcha/i.test(html)) {
      return { isChallenge: true };
    }

    const items = [];
    let detectedAliases = [];

    // 1. Check for embedded Apollo state in <script> tags
    let state = null;

    // Pattern A: window.__APOLLO_STATE__ = JSON.parse("...");
    const idx = html.indexOf("window.__APOLLO_STATE__");
    if (idx !== -1) {
      const endScriptIdx = html.indexOf("</script>", idx);
      const slice = endScriptIdx !== -1 ? html.slice(idx, endScriptIdx) : html.slice(idx, idx + 5000000);

      // Issue #31: `slice` is already bounded to this one <script> block (or a
      // 5MB cap), and in practice a listing page emits exactly one
      // `window.__APOLLO_STATE__ = JSON.parse("...")` assignment per block.
      // Using a GREEDY capture (rather than lazy `+?`) means the regex engine
      // consumes to the end of the slice and backtracks to the LAST
      // occurrence of the closing-quote/`);` boundary, not the first — this
      // is the far more likely real terminator if the escaped JSON payload
      // itself happens to contain a literal `");`-like sequence. It is not a
      // bulletproof JSON-aware scan (a pathological payload could still fool
      // it), so the JSON.parse calls below stay try/catch-guarded: a
      // truncated/garbled capture simply fails to parse and `state` stays
      // null, falling through to the direct-object and <script id=...>
      // patterns below instead of throwing.
      const jsonParseMatch = /window\.__APOLLO_STATE__\s*=\s*JSON\.parse\((["'])([\s\S]+)\1\s*\);/.exec(slice);
      if (jsonParseMatch) {
        const rawQuoted = jsonParseMatch[0].slice(jsonParseMatch[0].indexOf("(") + 1, jsonParseMatch[0].lastIndexOf(")"));
        try {
          const jsonStr = JSON.parse(rawQuoted);
          state = JSON.parse(jsonStr);
        } catch {}
      }

      if (!state) {
        const directObjMatch = /window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]+?\});\s*(?:<\/script>|\n|$)/.exec(slice);
        if (directObjMatch) {
          try {
            state = JSON.parse(directObjMatch[1]);
          } catch {}
        }
      }
    }

    // Pattern B: <script id="__APOLLO_STATE__">...</script>
    if (!state) {
      const tagMatch = /<script[^>]*id="__APOLLO_STATE__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
      if (tagMatch) {
        try {
          state = JSON.parse(tagMatch[1]);
        } catch {}
      }
    }

    if (state && typeof state === "object") {
      try {
        let targetKey = null;
        const candidateIds = [propertyId, canonicalId].filter(Boolean).map((id) => String(id).toLowerCase());

        for (const cid of candidateIds) {
          targetKey = Object.keys(state).find(
            (k) => k.toLowerCase() === `propertyinfo:${cid}` || k.toLowerCase() === `property:${cid}`
          );
          if (targetKey) break;
        }

        if (!targetKey && candidateIds.length > 0) {
          for (const k of Object.keys(state)) {
            if (!k.startsWith("PropertyInfo:") && !k.startsWith("Property:")) continue;
            const node = state[k];
            if (!node || typeof node !== "object") continue;
            const nodeIds = [node.propertyId, node.vrboPropertyId, node.expediaPropertyId, node.id]
              .filter(Boolean)
              .map((id) => String(id).toLowerCase());
            if (candidateIds.some((cid) => nodeIds.includes(cid))) {
              targetKey = k;
              break;
            }
          }
        }

        if (!targetKey && candidateIds.length === 0) {
          targetKey = Object.keys(state).find((k) => k.startsWith("PropertyInfo:")) ||
                      Object.keys(state).find((k) => k.startsWith("Property:"));
        }

        const root = targetKey ? state[targetKey] : null;
        if (root) {
          if (root.expediaPropertyId) detectedAliases.push(String(root.expediaPropertyId));
          if (root.propertyId) detectedAliases.push(String(root.propertyId));
          if (root.id) detectedAliases.push(String(root.id));

          walkApolloNode(state, root, null, null, items);
        }
      } catch {}
    }

    // 2. Extract visible text sentences from raw HTML (description, house rules, amenities)
    const domSentences = [];
    const cleanHtml = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|td|th|dd|dt|blockquote)>/gi, "\n");

    const rawText = cleanHtml.replace(/<[^>]+>/g, " ");
    const sentences = typeof extract.getSentences === "function"
      ? extract.getSentences(rawText)
      : [];
    const seenSentences = new Set();
    for (const s of sentences) {
      if (typeof extract.isPetRelated === "function" && extract.isPetRelated(s) && !seenSentences.has(s)) {
        seenSentences.add(s);
        domSentences.push({ text: s, source: "About this property" });
      }
    }

    if (items.length === 0 && domSentences.length === 0) return null;

    // Build corpus combining Apollo items and visible HTML sentences
    const corpus = extract.buildCorpus({ items }, domSentences);
    if (!corpus || corpus.length === 0) return null;
    const rawPolicy = extract.extractPolicy(corpus);
    if (!rawPolicy || !rawPolicy.found) return null;
    const effectivePropId = canonicalId || propertyId;
    const policy = typeof extract.normalizePolicy === "function"
      ? extract.normalizePolicy(rawPolicy, effectivePropId, "search-response")
      : rawPolicy;
    return {
      ok: true,
      propertyId: effectivePropId,
      requestedId: propertyId,
      canonicalId,
      aliases: Array.from(new Set(detectedAliases)),
      policy,
      rawItemsCount: items.length + domSentences.length,
    };
  }

  /**
   * A "concrete" canonical policy is one a badge can actually show — not a
   * null policy and not one whose every field is "not specified".
   */
  function hasConcretePolicy(policy) {
    return Boolean(policy && (
      policy.petsAllowed !== null ||
      policy.maxDogs !== null ||
      policy.weightLimit !== null ||
      policy.fee !== null ||
      policy.deposit !== null ||
      policy.approvalRequired !== null ||
      (policy.restrictionNoteCount && policy.restrictionNoteCount > 0) ||
      (policy._raw?.otherNotes && policy._raw.otherNotes.length > 0)
    ));
  }

  /**
   * Build a concrete canonical policy from a search-page Apollo record
   * (a bridge result of { propertyId, items }). Returns null when the
   * record is empty or yields nothing concrete — callers then fall
   * through to a normal listing fetch.
   */
  function resolveSearchApolloRecord(record, propertyId, source = "search-page-state") {
    if (!record || !Array.isArray(record.items) || record.items.length === 0) return null;
    const corpus = extract.buildCorpus({ items: record.items }, []);
    if (!corpus || corpus.length === 0) return null;
    const rawPolicy = extract.extractPolicy(corpus);
    if (!rawPolicy || !rawPolicy.found) return null;
    const policy = typeof extract.normalizePolicy === "function"
      ? extract.normalizePolicy(rawPolicy, propertyId, source)
      : rawPolicy;
    return hasConcretePolicy(policy) ? policy : null;
  }

  /**
   * Extract numeric/alphanumeric property ID from a Vrbo listing URL or path.
   * Delegates to shared pure extractor in extract.js.
   */
  function extractPropertyIdFromUrl(urlStr, baseUrl = "https://www.vrbo.com") {
    if (extract && typeof extract.extractPropertyId === "function") {
      return extract.extractPropertyId(urlStr, baseUrl);
    }
    if (!urlStr || typeof urlStr !== "string") return null;
    try {
      const u = new URL(urlStr, baseUrl);
      const m = /(?:\/pdp(?:\/lo)?\/|\/vacation-rentals?(?:\/p)?\/p?|\/)(p?\d+[a-z0-9]*)(?:\/|\?|$)/i.exec(u.pathname);
      if (!m) return null;
      let propId = m[1];
      if (/^p\d+/i.test(propId)) propId = propId.slice(1);
      return propId || null;
    } catch {
      return null;
    }
  }

  /**
   * Validate and separate a Vrbo listing URL into a clean canonical fetch URL
   * (HTTPS, www.vrbo.com or vrbo.com, pathname only, no query or fragment)
   * and the original navigation URL.
   */
  function validateListingUrl(urlStr, baseUrl = "https://www.vrbo.com") {
    if (!urlStr || typeof urlStr !== "string") return null;
    try {
      const u = new URL(urlStr, baseUrl);
      if (u.protocol !== "https:") return null;

      const siteRegistry = (typeof globalThis !== "undefined" && globalThis.PawSiteRegistry) ||
        (typeof require === "function" ? require("./site-registry.js") : null);
      if (!siteRegistry) return null;

      if (!siteRegistry.isListingUrl(u.href)) return null;
      const propId = siteRegistry.getPropertyId(u.href);
      if (!propId) return null;

      const fetchUrl = siteRegistry.getCanonicalFetchUrl(u.href);

      return {
        propertyId: propId,
        navigationUrl: u.href,
        fetchUrl,
      };
    } catch {
      return null;
    }
  }

  return {
    walkApolloNode,
    parseListingHtml,
    hasConcretePolicy,
    resolveSearchApolloRecord,
    extractPropertyIdFromUrl,
    validateListingUrl,
  };
});
