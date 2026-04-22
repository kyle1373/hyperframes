// Source-of-truth HTML mutations for direct manipulation editing.
//
// The Studio preview iframe serves a *compiled* version of the composition,
// but edits must persist to the project's raw `index.html` on disk. Every
// mutation here is expressed as a small declarative patch keyed by element
// `id` so it round-trips through the file API and survives the compile step.

export type SourceMutation =
  | { type: "style"; id: string; updates: Record<string, string> }
  | { type: "text"; id: string; value: string }
  | { type: "delete"; id: string }
  | { type: "duplicate"; id: string; newId?: string }
  | { type: "raiseToTop"; id: string }
  | { type: "lowerToBottom"; id: string }
  | { type: "dataAttr"; id: string; attrs: Record<string, string | null> };

interface FileResponse {
  content?: string;
}

export async function fetchSource(projectId: string, filePath = "index.html"): Promise<string> {
  const res = await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(filePath)}`);
  if (!res.ok) throw new Error(`Failed to read ${filePath}: ${res.status}`);
  const data = (await res.json()) as FileResponse;
  return unwrapAccidentalJsonEnvelope(data.content ?? "");
}

/**
 * Earlier versions of this module accidentally wrote
 *   `{"content":"<!doctype html>…"}`
 * to disk because the save path was sending JSON while the file API writes
 * the raw body. If we ever see that envelope on read, silently peel it off
 * so the file self-heals on the next commit instead of compounding the damage.
 */
function unwrapAccidentalJsonEnvelope(html: string): string {
  const trimmed = html.trimStart();
  if (!trimmed.startsWith('{"content":"')) return html;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && "content" in parsed) {
      const inner = (parsed as { content?: unknown }).content;
      if (typeof inner === "string") return inner;
    }
  } catch {
    /* fall through — return original */
  }
  return html;
}

export async function saveSource(
  projectId: string,
  html: string,
  filePath = "index.html",
): Promise<void> {
  // IMPORTANT: the Studio file API writes the raw request body to disk with
  // no JSON unwrapping — matching how App.tsx saves SourceEditor edits. We
  // must NOT wrap the HTML in `{ content: … }`; doing so writes the JSON
  // envelope to the file and silently corrupts the composition.
  const res = await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: html,
  });
  if (!res.ok) throw new Error(`Failed to save ${filePath}: ${res.status}`);
}

// ─── Reload suppression ───────────────────────────────────────────────────────
//
// Every overlay-initiated save (drag, resize, text edit, delete, AI turn)
// writes the file to disk. Vite's watcher picks that up and fires the
// `hf:file-change` WS event, which normally debounces a full iframe remount
// in App.tsx. That remount is catastrophic for perceived quality:
//
//   • GSAP reinitialises from frame 0, so an element the user just dragged
//     appears to "snap back" for the split-second before the seek catches up.
//   • Every drag-release triggers a remount, every resize too, so rapid
//     editing feels like the page is constantly refreshing.
//
// The overlay has ALREADY updated the iframe DOM in place by the time we
// save. The file write is just for durability, not for re-rendering. So we
// mark a timestamp on every studio save, and the App's file-change handler
// ignores events within a short window after. When the user stops editing
// (or exits edit mode), the window closes and normal reload behaviour
// resumes.
let _lastStudioSaveAt = 0;

export function markStudioSave(): void {
  _lastStudioSaveAt = Date.now();
}

export function wasStudioSaveWithin(ms: number): boolean {
  return Date.now() - _lastStudioSaveAt < ms;
}

/**
 * Apply a single mutation to an HTML source string.
 *
 * Uses DOMParser (same-origin, runs in the browser) so we can operate on
 * the real element by id without regex fragility. Returns the original
 * string unchanged if the target id is not found.
 */
export function applyMutation(html: string, mutation: SourceMutation): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const el = doc.getElementById(mutation.id);
  if (!el) return html;

  applyMutationToDoc(doc, mutation, el);
  return serializeDocument(doc);
}

/**
 * Apply many mutations in a single parse/serialize round trip. Preferred
 * when we might touch several elements at once (e.g. future multi-select).
 */
export function applyMutations(html: string, mutations: SourceMutation[]): string {
  if (mutations.length === 0) return html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  let dirty = false;
  for (const mutation of mutations) {
    const el = doc.getElementById(mutation.id);
    if (!el) continue;
    applyMutationToDoc(doc, mutation, el);
    dirty = true;
  }
  return dirty ? serializeDocument(doc) : html;
}

function applyMutationToDoc(doc: Document, mutation: SourceMutation, el: Element): void {
  switch (mutation.type) {
    case "style":
      for (const [prop, value] of Object.entries(mutation.updates)) {
        if (value === "" || value == null) (el as HTMLElement).style.removeProperty(prop);
        else (el as HTMLElement).style.setProperty(prop, value);
      }
      return;
    case "text":
      // Preserve <br> spacing in simple text elements by keeping line breaks
      // the user typed in contenteditable. Break model is "\n" → <br>.
      setEditableText(el, mutation.value);
      return;
    case "delete":
      el.remove();
      return;
    case "duplicate": {
      // Clone the element, give it a fresh unique id, insert it right
      // after the original so it stacks visually on top (later in DOM
      // order = later painted). Nested ids are stripped to avoid
      // collisions — users rarely want a deep duplicate keyed by id.
      const clone = el.cloneNode(true) as Element;
      const newId = mutation.newId ?? allocateId(doc, el.id);
      clone.setAttribute("id", newId);
      // Strip ids from descendants to avoid duplicate-id conflicts.
      clone.querySelectorAll("[id]").forEach((child) => child.removeAttribute("id"));
      el.parentNode?.insertBefore(clone, el.nextSibling);
      return;
    }
    case "raiseToTop": {
      const parent = el.parentElement;
      if (!parent) return;
      parent.appendChild(el);
      return;
    }
    case "lowerToBottom": {
      const parent = el.parentElement;
      if (!parent || !parent.firstChild) return;
      if (parent.firstChild !== el) parent.insertBefore(el, parent.firstChild);
      return;
    }
    case "dataAttr": {
      // Write arbitrary attributes (typically data-start / data-duration
      // from timeline clip drag/trim). Pass null to delete an attribute.
      for (const [name, value] of Object.entries(mutation.attrs)) {
        if (value === null) el.removeAttribute(name);
        else el.setAttribute(name, value);
      }
      return;
    }
  }
}

function allocateId(doc: Document, baseId: string): string {
  // Try `baseId-2`, `-3`, ... until we find a free slot. Starts at 2 so
  // the first duplicate reads naturally.
  const stripTail = baseId.replace(/-\d+$/, "");
  let n = 2;
  while (doc.getElementById(`${stripTail}-${n}`)) n++;
  return `${stripTail}-${n}`;
}

export async function commitMutation(
  projectId: string,
  mutation: SourceMutation,
  filePath = "index.html",
): Promise<void> {
  const current = await fetchSource(projectId, filePath);
  const updated = applyMutation(current, mutation);
  if (updated === current) return;
  await saveSource(projectId, updated, filePath);

  // Reload suppression, but ONLY for mutations where the overlay has
  // already applied the change to the iframe DOM in place:
  //
  //   • "style"  — drag/resize/rotate set el.style.{translate|width|…}
  //                on the iframe element during pointermove, so the
  //                visible DOM already reflects what we just saved.
  //   • "text"   — contenteditable edits the iframe element's text
  //                directly while the user types.
  //
  // For every OTHER mutation (delete, duplicate, raise/lower, dataAttr)
  // the iframe DOM is still stale after the save — only the source file
  // has the new state. We MUST let HMR reload so the change appears:
  //
  //   • delete / duplicate / raise / lower — iframe element still there
  //   • dataAttr — clip-timing data-start/duration changes must be
  //     re-read by the runtime to take effect; the overlay never touches
  //     the iframe's data-* attributes.
  if (mutation.type === "style" || mutation.type === "text") {
    markStudioSave();
  }
}

// Tags we never want to auto-id — they're either script/style plumbing or
// SVG filter internals that the user has no reason to select individually.
const AUTO_ID_SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "META",
  "LINK",
  "TITLE",
  "BR",
  "HR",
  "HEAD",
  // SVG plumbing — defs/filters/gradients/masks — selecting these makes no
  // visual sense and clutters the source with ids nobody will ever use.
  "DEFS",
  "USE",
  "STOP",
  "DESC",
  "METADATA",
  "CLIPPATH",
  "MASK",
  "PATTERN",
  "LINEARGRADIENT",
  "RADIALGRADIENT",
  "FILTER",
  "FETURBULENCE",
  "FEDISPLACEMENTMAP",
  "FECOLORMATRIX",
  "FEGAUSSIANBLUR",
  "FEMERGE",
  "FEMERGENODE",
  "FECOMPONENTTRANSFER",
  "FEFUNCA",
  "FEFUNCR",
  "FEFUNCG",
  "FEFUNCB",
  "FEBLEND",
  "FEOFFSET",
  "FECOMPOSITE",
]);

/**
 * Walk the body of an HTML source and assign an `id` to every visually
 * selectable element that doesn't already have one. Idempotent — existing
 * ids are preserved, and re-running only touches elements that still lack
 * an id (e.g. ones the user added through the Code editor).
 *
 * Returns the patched HTML plus a `changed` flag so the caller can skip the
 * network round trip when nothing needed updating.
 */
export function autoAssignIds(
  html: string,
  prefix = "el",
): { html: string; changed: boolean; assigned: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  if (!doc.body) return { html, changed: false, assigned: 0 };

  const existing = new Set<string>();
  doc.querySelectorAll("[id]").forEach((el) => {
    const id = (el as HTMLElement).id;
    if (id) existing.add(id);
  });

  let counter = 1;
  let changed = false;
  let assigned = 0;
  const MAX = 5000;

  const walk = (el: Element) => {
    const tag = el.tagName.toUpperCase();
    if (AUTO_ID_SKIP_TAGS.has(tag)) return;

    const current = (el as HTMLElement).id;
    if (!current) {
      if (counter > MAX) return;
      let candidate = `${prefix}-${counter}`;
      while (existing.has(candidate)) {
        counter++;
        candidate = `${prefix}-${counter}`;
      }
      existing.add(candidate);
      el.setAttribute("id", candidate);
      counter++;
      assigned++;
      changed = true;
    }
    for (const child of Array.from(el.children)) {
      walk(child);
    }
  };

  for (const child of Array.from(doc.body.children)) {
    walk(child);
  }

  return {
    html: changed ? serializeDocument(doc) : html,
    changed,
    assigned,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function setEditableText(el: Element, value: string): void {
  // Safe path: if the element only holds text (+ optional <br>s), replace its
  // content with the new string, mapping "\n" back to <br> so layout is
  // preserved. If the element has real child elements (spans, svgs, etc),
  // we refuse to overwrite it — that job belongs to a dedicated inner target.
  if (hasOnlyTextAndBr(el)) {
    while (el.firstChild) el.removeChild(el.firstChild);
    const parts = value.split("\n");
    parts.forEach((part, i) => {
      el.appendChild(el.ownerDocument!.createTextNode(part));
      if (i < parts.length - 1) {
        el.appendChild(el.ownerDocument!.createElement("br"));
      }
    });
    return;
  }
  // Fallback: only replace first text node, keep siblings intact.
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 /* text */) {
      child.textContent = value;
      return;
    }
  }
  // If no text node exists at all, append one — keeps element alive.
  el.appendChild(el.ownerDocument!.createTextNode(value));
}

function hasOnlyTextAndBr(el: Element): boolean {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) continue;
    if (child.nodeType === 1 && (child as Element).tagName === "BR") continue;
    return false;
  }
  return true;
}

function serializeDocument(doc: Document): string {
  const doctype = doc.doctype
    ? `<!DOCTYPE ${doc.doctype.name}${
        doc.doctype.publicId ? ` PUBLIC "${doc.doctype.publicId}"` : ""
      }${doc.doctype.systemId ? ` "${doc.doctype.systemId}"` : ""}>\n`
    : "";
  return doctype + doc.documentElement.outerHTML + "\n";
}
