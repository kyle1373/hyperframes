/**
 * Internal helper for scoping the player's media MutationObserver to the
 * composition tree inside the iframe.
 *
 * Not part of the package's public API — kept in its own module so the
 * decision logic can be exercised by unit tests without exposing it through
 * the player entry point.
 */

/**
 * Pick the elements inside `doc` that the media MutationObserver should
 * attach to.
 *
 * Compositions mount inside `[data-composition-id]` host elements — the
 * runtime root and any sub-composition hosts that `compositionLoader` writes
 * into them. Watching only those hosts (with `subtree: true`) catches every
 * late-arriving timed media element from sub-composition activation, while
 * filtering out churn from analytics tags, runtime telemetry markers, and
 * other out-of-host nodes that the runtime appends straight to `<body>`
 * during bootstrap.
 *
 * Nested hosts are filtered out — they're already covered by their nearest
 * host ancestor's subtree observation, so observing them too would deliver
 * each callback twice and double-count adoption work.
 *
 * Falls back to `[doc.body]` when no composition hosts are present, which
 * preserves the previous behavior for documents that aren't yet (or never
 * will be) composition-structured. Returns an empty array when neither a
 * host nor a body is available — the caller should treat that as "nothing
 * to observe".
 */
export function selectMediaObserverTargets(doc: Document): Element[] {
  const all = Array.from(doc.querySelectorAll<Element>("[data-composition-id]"));
  if (all.length === 0) {
    return doc.body ? [doc.body] : [];
  }

  const topLevel: Element[] = [];
  for (const el of all) {
    if (!hasCompositionAncestor(el)) {
      topLevel.push(el);
    }
  }
  return topLevel;
}

function hasCompositionAncestor(el: Element): boolean {
  let cursor = el.parentElement;
  while (cursor) {
    if (cursor.hasAttribute("data-composition-id")) return true;
    cursor = cursor.parentElement;
  }
  return false;
}
