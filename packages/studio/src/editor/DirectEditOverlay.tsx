import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { autoAssignIds, commitMutation, fetchSource, saveSource } from "./htmlMutation";
import { useDirectEditStore } from "./directEditStore";
import { useCopilotStore } from "./copilotStore";
import { usePlayerStore } from "../player/store/playerStore";

interface DirectEditOverlayProps {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  projectId: string;
  filePath?: string;
}

interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type ResizeHandle = "nw" | "n" | "ne" | "w" | "e" | "sw" | "s" | "se";
type DragMode = "move" | "resize" | "rotate";

interface DragState {
  id: string;
  mode: DragMode;
  handle?: ResizeHandle;

  startPointerX: number;
  startPointerY: number;

  /**
   * Starting `left`/`top` in LOGICAL pixels (stage coords).
   *
   * We used to persist drag deltas in the CSS `translate` property, which
   * GSAP 3.12+ can overwrite when animating `x`/`y` (it sometimes uses the
   * individual transform properties instead of `transform: translate(…)`).
   * That caused drags to "revert on refresh" because `gsap.set(el, {x, y})`
   * in the composition's init script clobbered the user's saved translate.
   *
   * `left`/`top` are pure layout properties and GSAP never touches them,
   * so drags persist correctly. The element's animated `transform` from
   * GSAP stacks on top of the new box position.
   */
  startLeft: number;
  startTop: number;

  /** Starting inline width/height, logical px. Used by resize. */
  startW: number;
  startH: number;

  /** Element center in screen coords (logical px * scale + offset). Used by rotate. */
  centerScreenX: number;
  centerScreenY: number;

  /** Starting rotation in degrees (CSS `rotate` property). Used by rotate. */
  startRotation: number;
  /** Initial angle from centre to pointer (deg). Used by rotate. */
  startAngle: number;

  scaleX: number;
  scaleY: number;
}

// Max depth we walk up looking for an element with an id when the user clicks.
const PICK_MAX_DEPTH = 24;

// Ancestors/tags we never want to select directly.
const PICK_SKIP_TAGS = new Set(["HTML", "BODY"]);

// We append this attribute to elements we've forced into editable mode so we
// can clean them up reliably if the overlay unmounts mid-edit.
const EDIT_ATTR = "data-hf-edit-active";

// An element whose effective opacity is below this is treated as invisible
// at the current timeline frame and ignored by hit-testing. Without this
// filter, clicks at t=0 would catch scene wrappers (opacity: 0 until they
// fade in) and select the "wrong" element from the user's perspective.
const VISIBLE_OPACITY_THRESHOLD = 0.05;

// ═══════════════════════════════════════════════════════════════════════════
// Root overlay
// ═══════════════════════════════════════════════════════════════════════════

export function DirectEditOverlay({
  iframeRef,
  projectId,
  filePath = "index.html",
}: DirectEditOverlayProps) {
  const enabled = useDirectEditStore((s) => s.enabled);
  const selectedId = useDirectEditStore((s) => s.selectedId);
  const hoveredId = useDirectEditStore((s) => s.hoveredId);
  const editingTextId = useDirectEditStore((s) => s.editingTextId);
  const setSelected = useDirectEditStore((s) => s.setSelected);
  const setHovered = useDirectEditStore((s) => s.setHovered);
  const setEditingText = useDirectEditStore((s) => s.setEditingText);

  // Per-element AI-edit busy set — the overlay paints a blurred loader
  // box over each element that has a live agent turn running on it.
  const busyElementIds = useCopilotStore((s) => s.busyElementIds);
  const startElementWork = useCopilotStore((s) => s.startElementWork);
  const endElementWork = useCopilotStore((s) => s.endElementWork);
  const copilotApiKey = useCopilotStore((s) => s.apiKey);

  // Right-click "Ask AI" floating prompt: a textbox tethered to the
  // target element, submitting kicks off a scoped agent turn that shows
  // the busy loader on just that element.
  const [inlinePrompt, setInlinePrompt] = useState<{
    targetId: string;
  } | null>(null);

  // Right-click menu state: screen position + target element id. Kept
  // around as the secondary flow (duplicate / delete / z-order) behind
  // the ⌥ modifier or the small "⋯" chip on the selection box. The
  // primary right-click action is now the inline AI prompt.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targetId: string;
  } | null>(null);

  // Tick bumps trigger a recompute of the selection/hover rectangles from the
  // live iframe DOM without subscribing to every possible mutation source.
  //
  // Throttled to requestAnimationFrame — without this, every `pointermove`
  // during a drag/resize queued a React re-render, each of which read the
  // iframe's bounding rect, the selected element's rect, and computed
  // style. On a busy composition that turned into 100+ renders/sec and the
  // overlay felt like the page was constantly refreshing.
  const [tick, setTick] = useState(0);
  const tickRafRef = useRef(0);
  const bumpTick = () => {
    if (tickRafRef.current !== 0) return;
    tickRafRef.current = requestAnimationFrame(() => {
      tickRafRef.current = 0;
      setTick((t) => (t + 1) % 1_000_000);
    });
  };
  // Ensure we cancel any pending RAF on unmount so we don't set state on
  // an unmounted component during fast tab switches.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    return () => {
      if (tickRafRef.current !== 0) {
        cancelAnimationFrame(tickRafRef.current);
        tickRafRef.current = 0;
      }
    };
  }, []);

  const dragRef = useRef<DragState | null>(null);
  const [, forceRender] = useState(0);

  // ── Source-wide auto-ID pass ──────────────────────────────────────────────
  // Every visually-editable element needs an `id` for the overlay to target
  // it from a mutation. On edit-mode entry we fetch the source, ensure every
  // non-technical element has an id (existing ids preserved), and save if
  // anything changed. The iframe then HMR-reloads with every element now
  // selectable — hover/click/drag/text/delete works on all of them.
  //
  // Idempotent: re-entering edit mode on an already-prepared file is a no-op.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const run = async () => {
      try {
        const html = await fetchSource(projectId, filePath);
        if (cancelled) return;
        const { html: patched, changed, assigned } = autoAssignIds(html);
        if (cancelled || !changed) return;
        await saveSource(projectId, patched, filePath);
        // Not an error — helpful breadcrumb in the console while authoring.
        console.info(`[direct-edit] auto-id pass assigned ${assigned} new ids to ${filePath}`);
      } catch (err) {
        console.warn("[direct-edit] auto-id pass failed", err);
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [enabled, projectId, filePath]);

  // ── Enable pointer events + rewind-and-pause on edit mode entry ──────────
  //
  // `<hyperframes-player>` sets `pointer-events: none` on its inner iframe so
  // click-to-play propagates to the host element. In edit mode we flip that
  // back on so our selection/drag listeners inside the iframe actually fire,
  // then restore on cleanup.
  //
  // We rewind to frame 0 and pause on entry. The rewind is what makes drag
  // WYSIWYG: `translate: X Y` on an element composes with whatever
  // `transform` GSAP has applied at the current frame. Editing at time T
  // pins the element in SCREEN space only at time T — on browser refresh
  // the composition restarts at t=0 with a different transform, and the
  // element appears somewhere else. Rewinding to 0 keeps the drag baseline
  // consistent with what the user will see on refresh.
  //
  // We deliberately do NOT install a sticky re-pause interval: that would
  // fight the user's explicit Play action and make the composition appear
  // to play for only a few frames before snapping back to paused. Pausing
  // during actual drag/resize/rotate is handled in beginMove / beginResize
  // / beginRotate.
  useEffect(() => {
    if (!enabled) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const prevPointerEvents = iframe.style.pointerEvents;
    iframe.style.pointerEvents = "auto";

    const pauseAtZero = () => {
      try {
        const win = iframe.contentWindow as
          | (Window & {
              __timelines?: Record<
                string,
                { pause?: (time?: number) => void; time?: (t?: number) => number }
              >;
            })
          | null;
        if (!win?.__timelines) return;
        for (const tl of Object.values(win.__timelines)) {
          // GSAP: `.pause(0)` seeks to 0 AND pauses in a single call.
          if (tl && typeof tl.pause === "function") tl.pause(0);
        }
        // Keep the Studio playhead slider in sync with the rewind.
        try {
          usePlayerStore.getState().setCurrentTime(0);
        } catch {
          /* store not ready */
        }
      } catch {
        /* cross-origin — bail silently */
      }
    };

    pauseAtZero();
    const onLoad = () => {
      iframe.style.pointerEvents = "auto";
      // After HMR reload the composition may auto-play its own GSAP
      // timeline from t=0. Re-pause-at-0 once it's had a moment to register.
      setTimeout(pauseAtZero, 50);
      bumpTick();
    };
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      iframe.style.pointerEvents = prevPointerEvents;
    };
  }, [enabled, iframeRef]);

  // ── Iframe event wiring: click / hover / dbl-click ────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    let activeDoc: Document | null = null;

    const onClick = (e: MouseEvent) => {
      if (!activeDoc) return;
      const target = pickVisibleAt(e.clientX, e.clientY, activeDoc);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      setSelected(target.id);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!activeDoc) return;
      const target = pickVisibleAt(e.clientX, e.clientY, activeDoc);
      setHovered(target?.id ?? null);
    };

    const onMouseLeave = () => setHovered(null);

    const onDblClick = (e: MouseEvent) => {
      if (!activeDoc) return;
      // Use "text" mode so double-clicking an SVG <text> element
      // (e.g. the "TV" label inside the TV logo) targets it directly
      // for content editing rather than bubbling up to the wrapper.
      const target = pickVisibleAt(e.clientX, e.clientY, activeDoc, "text");
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      setSelected(target.id);
      setEditingText(target.id);
    };

    const onContextMenu = (e: MouseEvent) => {
      if (!activeDoc) return;
      const target = pickVisibleAt(e.clientX, e.clientY, activeDoc);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();

      setSelected(target.id);

      // Primary right-click flow = inline AI prompt anchored to the
      // element. Hold ⌥ (Alt) to get the secondary menu instead (z-order,
      // duplicate, etc).
      if (e.altKey) {
        const iframeNow = iframeRef.current;
        if (!iframeNow) return;
        const iframeRectNow = iframeNow.getBoundingClientRect();
        const coordsNow = computeIframeScale(iframeNow);
        const sx = coordsNow ? iframeRectNow.left + e.clientX * coordsNow.scaleX : e.clientX;
        const sy = coordsNow ? iframeRectNow.top + e.clientY * coordsNow.scaleY : e.clientY;
        setContextMenu({ x: sx, y: sy, targetId: target.id });
        return;
      }

      setContextMenu(null);
      setInlinePrompt({ targetId: target.id });
    };

    const attach = (doc: Document) => {
      activeDoc = doc;
      doc.addEventListener("click", onClick, true);
      doc.addEventListener("mousemove", onMouseMove, true);
      doc.addEventListener("mouseleave", onMouseLeave, true);
      doc.addEventListener("dblclick", onDblClick, true);
      doc.addEventListener("contextmenu", onContextMenu, true);
      doc.documentElement.style.cursor = "default";
      doc.documentElement.setAttribute("data-hf-edit-mode", "1");
    };

    const detach = (doc: Document | null) => {
      if (!doc) return;
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("mousemove", onMouseMove, true);
      doc.removeEventListener("mouseleave", onMouseLeave, true);
      doc.removeEventListener("dblclick", onDblClick, true);
      doc.removeEventListener("contextmenu", onContextMenu, true);
      doc.documentElement.removeAttribute("data-hf-edit-mode");
    };

    const bind = () => {
      const doc = iframe.contentDocument;
      if (doc) attach(doc);
    };

    bind();
    const onLoad = () => {
      detach(activeDoc);
      activeDoc = null;
      bind();
    };
    iframe.addEventListener("load", onLoad);

    return () => {
      iframe.removeEventListener("load", onLoad);
      detach(activeDoc);
      activeDoc = null;
    };
  }, [enabled, iframeRef, setSelected, setHovered, setEditingText]);

  // ── Recompute overlay rects when layout changes ───────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const bump = () => bumpTick();
    const ro = new ResizeObserver(bump);
    ro.observe(iframe);

    window.addEventListener("resize", bump);
    window.addEventListener("scroll", bump, true);

    // Poll at a low rate. Cheap, and covers edge cases where the inner doc
    // layout changes (e.g. HMR reload, font load reflow).
    const interval = window.setInterval(bump, 300);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", bump);
      window.removeEventListener("scroll", bump, true);
      window.clearInterval(interval);
    };
  }, [enabled, iframeRef]);

  // ── Keyboard shortcuts: delete, escape, arrow-nudge ──────────────────────
  useEffect(() => {
    if (!enabled) return;

    // Nudge throttle: arrow-keys saved to disk on every keystroke would
    // flood the HMR pipeline. We apply to the live DOM immediately (for
    // feedback) but debounce the mutation commit by 300 ms.
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleNudgeCommit = (id: string) => {
      if (nudgeTimer) clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => {
        const iframeNow = iframeRef.current;
        const docNow = iframeNow?.contentDocument;
        if (!docNow) return;
        const el = docNow.getElementById(id) as HTMLElement | null;
        if (!el) return;
        const left = el.style.left;
        const top = el.style.top;
        if (!left && !top) return;
        void commitMutation(
          projectId,
          {
            type: "style",
            id,
            updates: { left, top, translate: "", transform: "" },
          },
          filePath,
        ).catch((err) => console.warn("[direct-edit] failed to save nudge", err));
      }, 300);
    };

    const onKey = (e: KeyboardEvent) => {
      // Never steal keys from an active text editor
      if (useDirectEditStore.getState().editingTextId) return;
      // Ignore when typing in Studio chrome inputs
      const t = e.target as HTMLElement | null;
      if (t && ["INPUT", "TEXTAREA"].includes(t.tagName)) return;
      const id = useDirectEditStore.getState().selectedId;
      if (!id) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void deleteElement(projectId, id, filePath).then(() => setSelected(null));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSelected(null);
        return;
      }
      // ⌘K / Ctrl+K opens the inline AI prompt on the current selection.
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setInlinePrompt({ targetId: id });
        return;
      }

      // Arrow nudge. Shift x10 for power users.
      const isArrow =
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown";
      if (!isArrow) return;
      e.preventDefault();

      const iframeNow = iframeRef.current;
      const docNow = iframeNow?.contentDocument;
      if (!docNow) return;
      const el = docNow.getElementById(id) as HTMLElement | null;
      if (!el) return;

      const step = e.shiftKey ? 10 : 1;
      ensurePositioned(el);
      const cur = readLeftTop(el);
      let left = cur.left;
      let top = cur.top;
      if (e.key === "ArrowLeft") left -= step;
      if (e.key === "ArrowRight") left += step;
      if (e.key === "ArrowUp") top -= step;
      if (e.key === "ArrowDown") top += step;
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      bumpTick();
      scheduleNudgeCommit(id);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (nudgeTimer) clearTimeout(nudgeTimer);
    };
  }, [enabled, iframeRef, projectId, filePath, setSelected]);

  // ── Inline text editing inside the iframe ─────────────────────────────────
  useEffect(() => {
    if (!enabled || !editingTextId) return;
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument ?? null;
    if (!doc) return;
    const el = doc.getElementById(editingTextId);
    if (!el) return;

    el.setAttribute("contenteditable", "true");
    el.setAttribute(EDIT_ATTR, "1");
    (el as HTMLElement).style.outline = "2px solid #38bdf8";
    (el as HTMLElement).style.outlineOffset = "2px";
    (el as HTMLElement).focus();

    // Select all text inside the element so the user can type to replace it.
    try {
      const range = doc.createRange();
      range.selectNodeContents(el);
      const sel = doc.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch {
      /* ignore — some nodes may not be selectable */
    }

    let committed = false;
    const finish = async (save: boolean) => {
      if (committed) return;
      committed = true;
      const nextText = readEditableText(el);
      el.removeAttribute("contenteditable");
      el.removeAttribute(EDIT_ATTR);
      (el as HTMLElement).style.outline = "";
      (el as HTMLElement).style.outlineOffset = "";
      if (save) {
        try {
          await commitMutation(
            projectId,
            { type: "text", id: editingTextId, value: nextText },
            filePath,
          );
        } catch (err) {
          console.warn("[direct-edit] failed to save text", err);
        }
      }
      setEditingText(null);
    };

    const onBlur = () => void finish(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void finish(false);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void finish(true);
      }
    };

    el.addEventListener("blur", onBlur);
    el.addEventListener("keydown", onKey);

    return () => {
      el.removeEventListener("blur", onBlur);
      el.removeEventListener("keydown", onKey);
      // If unmounted mid-edit, silently discard (don't corrupt the file)
      if (!committed) {
        el.removeAttribute("contenteditable");
        el.removeAttribute(EDIT_ATTR);
        (el as HTMLElement).style.outline = "";
        (el as HTMLElement).style.outlineOffset = "";
      }
    };
  }, [enabled, editingTextId, iframeRef, projectId, filePath, setEditingText]);

  // ── Compute rects each render ─────────────────────────────────────────────
  if (!enabled) return null;

  const iframe = iframeRef.current;
  if (!iframe) return null;

  const coords = computeIframeScale(iframe);
  if (!coords) return null;
  const { scaleX, scaleY, iframeRect } = coords;

  const doc = iframe.contentDocument;

  const getRect = (id: string): ScreenRect | null => {
    if (!doc) return null;
    const el = doc.getElementById(id);
    if (!el) return null;
    const r = (el as HTMLElement).getBoundingClientRect();
    return {
      left: iframeRect.left + r.left * scaleX,
      top: iframeRect.top + r.top * scaleY,
      width: Math.max(4, r.width * scaleX),
      height: Math.max(4, r.height * scaleY),
    };
  };

  const selectedEl = selectedId && doc ? doc.getElementById(selectedId) : null;
  const selectedRect = selectedId ? getRect(selectedId) : null;
  const hoverRect =
    hoveredId && hoveredId !== selectedId && hoveredId !== editingTextId
      ? getRect(hoveredId)
      : null;

  const selectedCanMove =
    selectedEl != null &&
    (() => {
      try {
        const cs = (selectedEl.ownerDocument!.defaultView ?? window).getComputedStyle(
          selectedEl as HTMLElement,
        );
        // `display: contents` and `none` have no box to move.
        return cs.display !== "contents" && cs.display !== "none";
      } catch {
        return false;
      }
    })();

  // ── Drag / resize / rotate handlers ───────────────────────────────────────
  //
  // One state machine handles three operations, keyed by `dragRef.current.
  // mode`:
  //
  //   • "move"   — the body of the selection box. Writes CSS `translate`
  //                which composes additively with any GSAP-animated
  //                `transform`. Works in every positioning mode.
  //
  //   • "resize" — one of eight corner/edge handles. Changes inline
  //                `width` / `height` and, when the anchored side is top
  //                or left, also adjusts `translate` so the opposite side
  //                stays pinned under the cursor. Writes both in one
  //                mutation so a scrub back to frame 0 shows the resized
  //                element, not a pre-resize intermediate state.
  //
  //   • "rotate" — handle above the top-center. Writes the standalone CSS
  //                `rotate` property so it composes with GSAP `rotation`.
  const readRotateProperty = (el: HTMLElement): number => {
    const raw = el.style.rotate || "";
    const m = /^(-?\d*\.?\d+)deg$/.exec(raw.trim());
    if (m) return parseFloat(m[1]);
    return 0;
  };

  // Pause the composition's GSAP timelines for the duration of an active
  // drag/resize/rotate. Without this the timeline could advance under the
  // user's cursor and fight the edit. We no longer maintain a sticky
  // 120ms re-pause interval (it was breaking playback), so this is the
  // only pause hook needed during an actual manipulation.
  const pauseTimelinesNow = () => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const win = iframe.contentWindow as
        | (Window & { __timelines?: Record<string, { pause?: () => void }> })
        | null;
      if (!win?.__timelines) return;
      for (const tl of Object.values(win.__timelines)) {
        if (tl && typeof tl.pause === "function") tl.pause();
      }
    } catch {
      /* cross-origin */
    }
  };

  const beginMove = (e: ReactPointerEvent) => {
    if (!selectedEl || !selectedCanMove) return;
    e.preventDefault();
    e.stopPropagation();
    pauseTimelinesNow();
    const el = selectedEl as HTMLElement;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const lt = readLeftTop(el);
    // Make sure the element isn't statically-positioned — setting left/top
    // on a static element silently does nothing, which would feel like the
    // save has been dropped.
    ensurePositioned(el);
    dragRef.current = {
      id: el.id,
      mode: "move",
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startLeft: lt.left,
      startTop: lt.top,
      startW: 0,
      startH: 0,
      centerScreenX: 0,
      centerScreenY: 0,
      startRotation: 0,
      startAngle: 0,
      scaleX,
      scaleY,
    };
    forceRender((v) => v + 1);
  };

  const beginResize = (handle: ResizeHandle, e: ReactPointerEvent) => {
    if (!selectedEl) return;
    e.preventDefault();
    e.stopPropagation();
    pauseTimelinesNow();
    const el = selectedEl as HTMLElement;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const lt = readLeftTop(el);
    ensurePositioned(el);
    // Use the element's rendered box for starting width/height; this
    // includes any CSS transform scale, which we treat as the effective
    // size the user sees. Same math as drag.
    const r = el.getBoundingClientRect();
    const startW = r.width / scaleX;
    const startH = r.height / scaleY;

    dragRef.current = {
      id: el.id,
      mode: "resize",
      handle,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startLeft: lt.left,
      startTop: lt.top,
      startW,
      startH,
      centerScreenX: 0,
      centerScreenY: 0,
      startRotation: 0,
      startAngle: 0,
      scaleX,
      scaleY,
    };
    forceRender((v) => v + 1);
  };

  const beginRotate = (e: ReactPointerEvent) => {
    if (!selectedEl || !selectedRect) return;
    e.preventDefault();
    e.stopPropagation();
    pauseTimelinesNow();
    const el = selectedEl as HTMLElement;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const cx = selectedRect.left + selectedRect.width / 2;
    const cy = selectedRect.top + selectedRect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const startAngle = (Math.atan2(dy, dx) * 180) / Math.PI;

    dragRef.current = {
      id: el.id,
      mode: "rotate",
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startLeft: 0,
      startTop: 0,
      startW: 0,
      startH: 0,
      centerScreenX: cx,
      centerScreenY: cy,
      startRotation: readRotateProperty(el),
      startAngle,
      scaleX,
      scaleY,
    };
    forceRender((v) => v + 1);
  };

  const moveDrag = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || !doc) return;
    const el = doc.getElementById(d.id) as HTMLElement | null;
    if (!el) return;

    if (d.mode === "move") {
      const dx = (e.clientX - d.startPointerX) / d.scaleX;
      const dy = (e.clientY - d.startPointerY) / d.scaleY;
      const left = Math.round(d.startLeft + dx);
      const top = Math.round(d.startTop + dy);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    } else if (d.mode === "resize" && d.handle) {
      const dx = (e.clientX - d.startPointerX) / d.scaleX;
      const dy = (e.clientY - d.startPointerY) / d.scaleY;
      const h2 = d.handle;
      const isCorner = h2.length === 2;

      // Aspect-ratio lock on corners by default. Shift unlocks for free
      // resize — mirrors the convention in Figma/After Effects where a
      // modifier toggles the default behaviour.
      const lockAspect = isCorner && d.startW > 0 && d.startH > 0 && !e.shiftKey;

      let w: number;
      let h: number;
      let left = d.startLeft;
      let top = d.startTop;

      if (lockAspect) {
        const growX = h2.includes("e") ? dx : h2.includes("w") ? -dx : 0;
        const growY = h2.includes("s") ? dy : h2.includes("n") ? -dy : 0;
        const sX = (d.startW + growX) / d.startW;
        const sY = (d.startH + growY) / d.startH;
        const scale = Math.max(0.02, Math.abs(sX - 1) >= Math.abs(sY - 1) ? sX : sY);
        w = Math.max(4, d.startW * scale);
        h = Math.max(4, d.startH * scale);
        // West/north anchors: shift left/top so the opposite edge stays
        // under the pinned corner.
        if (h2.includes("w")) left = d.startLeft + (d.startW - w);
        if (h2.includes("n")) top = d.startTop + (d.startH - h);
      } else {
        w = d.startW;
        h = d.startH;
        if (h2.includes("e")) w = d.startW + dx;
        if (h2.includes("w")) {
          w = d.startW - dx;
          left = d.startLeft + dx;
        }
        if (h2.includes("s")) h = d.startH + dy;
        if (h2.includes("n")) {
          h = d.startH - dy;
          top = d.startTop + dy;
        }
        w = Math.max(4, w);
        h = Math.max(4, h);
      }

      el.style.width = `${Math.round(w)}px`;
      el.style.height = `${Math.round(h)}px`;
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    } else if (d.mode === "rotate") {
      const dx = e.clientX - d.centerScreenX;
      const dy = e.clientY - d.centerScreenY;
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const next = d.startRotation + (angle - d.startAngle);
      el.style.rotate = `${Math.round(next * 10) / 10}deg`;
    }
    bumpTick();
  };

  const endDrag = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !doc) return;
    try {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    const el = doc.getElementById(d.id) as HTMLElement | null;
    if (!el) return;

    let updates: Record<string, string> = {};
    if (d.mode === "move") {
      updates = {
        left: el.style.left,
        top: el.style.top,
        // If `ensurePositioned` had to make the element absolute, persist
        // that — otherwise left/top are silently ignored on reload.
        position: el.style.position,
        // Wipe any legacy `translate` left over from pre-refactor files.
        // GSAP 3.12+ can write to the CSS `translate` property when
        // animating x/y, which would overwrite a stale saved value the
        // moment the composition's init script runs. Empty string →
        // removeProperty in the mutation handler, so it's actually
        // cleared from the serialised inline style.
        translate: "",
        transform: "",
      };
    } else if (d.mode === "resize") {
      updates = {
        left: el.style.left,
        top: el.style.top,
        position: el.style.position,
        width: el.style.width,
        height: el.style.height,
        translate: "",
        transform: "",
      };
    } else if (d.mode === "rotate") {
      if (el.style.rotate) updates = { rotate: el.style.rotate };
    }
    // Drop empty values — setting `left: ""` when there was nothing there
    // before is a no-op but we don't need the round-trip.
    for (const k of Object.keys(updates)) {
      if (updates[k] === undefined) delete updates[k];
    }
    if (Object.keys(updates).length === 0) return;

    console.info("[direct-edit] saving", d.mode, d.id, updates);
    void commitMutation(projectId, { type: "style", id: d.id, updates }, filePath)
      .then(() => console.info("[direct-edit] saved", d.mode, d.id))
      .catch((err) => console.error("[direct-edit] SAVE FAILED", d.mode, d.id, err));
    forceRender((v) => v + 1);
  };

  // Expose under the legacy names for the render block below.
  const beginDrag = beginMove;

  // ── Render ────────────────────────────────────────────────────────────────
  // Ensure the tick value is referenced so React recomputes on bump.
  void tick;

  return (
    <div
      data-hf-edit-overlay
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        pointerEvents: "none",
      }}
    >
      {/* Frame around the preview + top-left badge */}
      <PreviewFrame iframeRect={iframeRect} />

      {hoverRect && <HoverOutline rect={hoverRect} />}

      {selectedRect && !editingTextId && (
        <SelectionBox
          rect={selectedRect}
          id={selectedId!}
          canMove={Boolean(selectedCanMove)}
          onBodyDown={beginDrag}
          onHandleDown={beginResize}
          onRotateDown={beginRotate}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onDelete={() =>
            void deleteElement(projectId, selectedId!, filePath).then(() => setSelected(null))
          }
        />
      )}

      {editingTextId && selectedRect && <EditingHint rect={selectedRect} />}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          targetId={contextMenu.targetId}
          onClose={() => setContextMenu(null)}
          onAction={async (action) => {
            const id = contextMenu.targetId;
            setContextMenu(null);
            try {
              if (action === "duplicate") {
                await commitMutation(projectId, { type: "duplicate", id }, filePath);
              } else if (action === "delete") {
                await commitMutation(projectId, { type: "delete", id }, filePath);
                setSelected(null);
              } else if (action === "raise") {
                await commitMutation(projectId, { type: "raiseToTop", id }, filePath);
              } else if (action === "lower") {
                await commitMutation(projectId, { type: "lowerToBottom", id }, filePath);
              } else if (action === "edit-text") {
                setSelected(id);
                setEditingText(id);
              } else if (action === "ask-ai") {
                setInlinePrompt({ targetId: id });
              }
            } catch (err) {
              console.warn("[direct-edit] context action failed", action, err);
            }
          }}
        />
      )}

      {/* Per-element "AI is editing this" loader: scoped blur + spinner. */}
      {busyElementIds.map((id) => {
        const r = getRect(id);
        if (!r) return null;
        return <BusyElementOverlay key={`busy-${id}`} rect={r} />;
      })}

      {/* Inline Ask-AI prompt tethered to the element the user
          right-clicked on. Submits a scoped agent turn. */}
      {inlinePrompt &&
        (() => {
          const anchor = getRect(inlinePrompt.targetId);
          if (!anchor) return null;
          return (
            <InlineAskPrompt
              anchor={anchor}
              targetId={inlinePrompt.targetId}
              apiKey={copilotApiKey}
              projectId={projectId}
              onClose={() => setInlinePrompt(null)}
              onBegin={startElementWork}
              onEnd={endElementWork}
            />
          );
        })()}
    </div>
  );
}

// ── Busy element loader ─────────────────────────────────────────────────────

function BusyElementOverlay({ rect }: { rect: ScreenRect }) {
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: "auto",
        zIndex: 120,
        // Scoped blur over just this element. backdrop-filter blurs
        // whatever's painted *under* this div — the iframe content — so
        // the effect is an in-place fog around the specific element.
        backdropFilter: "blur(6px) saturate(0.6)",
        WebkitBackdropFilter: "blur(6px) saturate(0.6)",
        background:
          "radial-gradient(circle at center, rgba(14,165,233,0.22), rgba(2,8,14,0.55) 70%)",
        border: "1px solid rgba(56, 189, 248, 0.7)",
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 0 0 6px rgba(56, 189, 248, 0.12), 0 12px 40px rgba(0,0,0,0.5)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderRadius: 8,
          background: "rgba(4,18,28,0.75)",
          border: "1px solid rgba(56,189,248,0.35)",
          color: "#bae6fd",
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            border: "2px solid rgba(56,189,248,0.85)",
            borderTopColor: "transparent",
            animation: "hf-spin 0.9s linear infinite",
          }}
        />
        <div>Claude is editing</div>
      </div>
      <style>{`
        @keyframes hf-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// ── Inline Ask-AI prompt ────────────────────────────────────────────────────

interface InlineAskPromptProps {
  anchor: ScreenRect;
  targetId: string;
  apiKey: string | null;
  projectId: string;
  onClose: () => void;
  onBegin: (id: string) => void;
  onEnd: (id: string) => void;
}

function InlineAskPrompt({
  anchor,
  targetId,
  apiKey,
  projectId,
  onClose,
  onBegin,
  onEnd,
}: InlineAskPromptProps) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Autofocus on mount.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Dismiss on Escape / outside click.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    const onPointer = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("[data-hf-ask-prompt]")) return;
      if (!submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose, submitting]);

  // Anchor the prompt box below the element when there's room; otherwise
  // put it above. Clamp to the viewport so tall elements at the edge
  // don't push the box off-screen.
  const PROMPT_W = 420;
  const PROMPT_H_EST = 148;
  const gap = 8;
  const placeBelow = anchor.top + anchor.height + gap + PROMPT_H_EST < window.innerHeight;
  const boxTop = placeBelow
    ? anchor.top + anchor.height + gap
    : Math.max(gap, anchor.top - gap - PROMPT_H_EST);
  const boxLeft = Math.max(
    gap,
    Math.min(window.innerWidth - PROMPT_W - gap, anchor.left + anchor.width / 2 - PROMPT_W / 2),
  );

  const submit = async () => {
    const text = value.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setStatus("Starting…");
    onBegin(targetId);

    // Lazy-load the streaming client — it's a big dep we don't want in
    // the overlay's critical path.
    try {
      const { streamCopilot } = await import("./claudeClient");
      let lastStatus = "";
      await streamCopilot({
        projectId,
        prompt: `For element #${targetId} in the composition: ${text}`,
        selectedId: targetId,
        apiKey: apiKey ?? undefined,
        onEvent: (ev) => {
          if (ev.type === "status") {
            lastStatus = ev.message;
            setStatus(ev.message);
          } else if (ev.type === "tool_use") {
            lastStatus = `→ ${ev.name}`;
            setStatus(lastStatus);
          } else if (ev.type === "tool_result") {
            setStatus(`${ev.name}: ${ev.ok ? "ok" : "failed"} — ${ev.summary.slice(0, 60)}`);
          } else if (ev.type === "text_delta") {
            /* ignore text deltas for the compact inline UI */
          } else if (ev.type === "turn_complete") {
            setStatus("Applied ✓");
          } else if (ev.type === "error") {
            setStatus(`Error: ${ev.message}`);
          }
        },
      });
      // Small delay so the user can see the final status before the UI
      // disappears on HMR reload.
      setTimeout(() => {
        onEnd(targetId);
        onClose();
      }, 400);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Error: ${message}`);
      setSubmitting(false);
      // Leave the box open so the user can retry / see the error.
      onEnd(targetId);
    }
  };

  const onSubmitKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div
      data-hf-ask-prompt
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: boxLeft,
        top: boxTop,
        width: PROMPT_W,
        zIndex: 200,
        pointerEvents: "auto",
        background: "rgba(10, 15, 22, 0.97)",
        backdropFilter: "blur(20px)",
        border: "1px solid rgba(56, 189, 248, 0.35)",
        borderRadius: 10,
        boxShadow: "0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(56,189,248,0.15)",
        padding: 12,
        color: "#e2e8f0",
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial',
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "#7dd3fc",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: submitting ? "#f59e0b" : "#38bdf8",
            boxShadow: submitting
              ? "0 0 10px rgba(245,158,11,0.6)"
              : "0 0 10px rgba(56,189,248,0.6)",
          }}
        />
        Ask Claude to edit <code style={{ color: "#e2e8f0" }}>#{targetId}</code>
      </div>
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onSubmitKey}
        disabled={submitting}
        placeholder={
          submitting ? "Working…" : "e.g. make it red with a glowing shadow and slightly larger"
        }
        rows={3}
        style={{
          width: "100%",
          resize: "none",
          background: "rgba(2,6,12,0.7)",
          color: "#f1f5f9",
          border: "1px solid rgba(71, 85, 105, 0.6)",
          borderRadius: 6,
          padding: "8px 10px",
          fontSize: 13,
          lineHeight: 1.4,
          outline: "none",
          fontFamily: "inherit",
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 8,
          gap: 8,
          minHeight: 22,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: submitting ? "#fde68a" : "#94a3b8",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {status || "⏎ to submit · Esc to cancel · ⌥ right-click for menu"}
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || !value.trim()}
          style={{
            background: submitting
              ? "rgba(245, 158, 11, 0.18)"
              : value.trim()
                ? "linear-gradient(180deg, #38bdf8, #0ea5e9)"
                : "rgba(71,85,105,0.4)",
            color: submitting ? "#fde68a" : value.trim() ? "#030712" : "#94a3b8",
            border: "none",
            padding: "6px 14px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: submitting ? "progress" : value.trim() ? "pointer" : "not-allowed",
          }}
        >
          {submitting ? "Editing…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function ContextMenu({
  x,
  y,
  targetId,
  onClose,
  onAction,
}: {
  x: number;
  y: number;
  targetId: string;
  onClose: () => void;
  onAction: (action: "duplicate" | "delete" | "raise" | "lower" | "edit-text" | "ask-ai") => void;
}) {
  // Close on any click outside or Escape.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const onAway = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("[data-hf-ctxmenu]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onAway);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onAway);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const rows: Array<
    | { kind: "item"; label: string; hint?: string; action: Parameters<typeof onAction>[0] }
    | { kind: "divider" }
    | { kind: "header"; label: string }
  > = [
    { kind: "header", label: `#${targetId}` },
    { kind: "divider" },
    { kind: "item", label: "Ask AI to change…", hint: "⌘K", action: "ask-ai" },
    { kind: "divider" },
    { kind: "item", label: "Edit text", hint: "dbl-click", action: "edit-text" },
    { kind: "item", label: "Duplicate", hint: "⌘D", action: "duplicate" },
    { kind: "divider" },
    { kind: "item", label: "Bring to front", action: "raise" },
    { kind: "item", label: "Send to back", action: "lower" },
    { kind: "divider" },
    { kind: "item", label: "Delete", hint: "⌫", action: "delete" },
  ];

  return (
    <div
      data-hf-ctxmenu
      style={{
        position: "fixed",
        left: Math.min(x, window.innerWidth - 240),
        top: Math.min(y, window.innerHeight - 280),
        minWidth: 220,
        background: "rgba(17, 17, 20, 0.96)",
        backdropFilter: "blur(18px)",
        border: "1px solid rgba(63, 63, 70, 0.7)",
        borderRadius: 8,
        boxShadow: "0 16px 32px rgba(0,0,0,0.45)",
        padding: 4,
        font: "500 12px ui-sans-serif, system-ui, sans-serif",
        color: "#e5e5e5",
        pointerEvents: "auto",
        userSelect: "none",
        zIndex: 1000,
      }}
    >
      {rows.map((row, i) => {
        if (row.kind === "divider") {
          return (
            <div
              key={`d${i}`}
              style={{ height: 1, background: "rgba(63,63,70,0.6)", margin: "4px 2px" }}
            />
          );
        }
        if (row.kind === "header") {
          return (
            <div
              key={`h${i}`}
              style={{
                padding: "6px 8px",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                fontSize: 10,
                color: "#7dd3fc",
                letterSpacing: "0.05em",
              }}
            >
              {row.label}
            </div>
          );
        }
        const isDanger = row.action === "delete";
        return (
          <button
            key={row.label}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAction(row.action);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              padding: "6px 10px",
              background: "transparent",
              border: "none",
              borderRadius: 4,
              color: isDanger ? "#f87171" : "#e5e5e5",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 12,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = isDanger
                ? "rgba(239,68,68,0.15)"
                : "rgba(255,255,255,0.06)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <span>{row.label}</span>
            {row.hint && <span style={{ fontSize: 10, color: "#71717a" }}>{row.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

function PreviewFrame({ iframeRect }: { iframeRect: DOMRect }) {
  return (
    <>
      <div
        style={{
          position: "fixed",
          left: iframeRect.left,
          top: iframeRect.top,
          width: iframeRect.width,
          height: iframeRect.height,
          boxShadow: "inset 0 0 0 2px rgba(56, 189, 248, 0.6)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "fixed",
          left: iframeRect.left + 10,
          top: iframeRect.top + 10,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          background: "rgba(4, 18, 28, 0.88)",
          border: "1px solid rgba(56, 189, 248, 0.6)",
          borderRadius: 4,
          font: "600 11px ui-sans-serif, system-ui, sans-serif",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "#7dd3fc",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#38bdf8",
            boxShadow: "0 0 8px #38bdf8",
          }}
        />
        Edit mode
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Presentational sub-components
// ═══════════════════════════════════════════════════════════════════════════

function HoverOutline({ rect }: { rect: ScreenRect }) {
  return (
    <div
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        border: "1px dashed rgba(56, 189, 248, 0.55)",
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.35)",
        borderRadius: 2,
        pointerEvents: "none",
      }}
    />
  );
}

function SelectionBox({
  rect,
  id,
  canMove,
  onBodyDown,
  onHandleDown,
  onRotateDown,
  onPointerMove,
  onPointerUp,
  onDelete,
}: {
  rect: ScreenRect;
  id: string;
  canMove: boolean;
  onBodyDown: (e: ReactPointerEvent) => void;
  onHandleDown: (h: ResizeHandle, e: ReactPointerEvent) => void;
  onRotateDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onDelete: () => void;
}) {
  const HANDLE = 11;
  const HALF = HANDLE / 2;

  // Layout + cursor per resize handle.
  const handles: Array<{ h: ResizeHandle; left: number; top: number; cursor: string }> = [
    { h: "nw", left: -HALF, top: -HALF, cursor: "nwse-resize" },
    { h: "n", left: rect.width / 2 - HALF, top: -HALF, cursor: "ns-resize" },
    { h: "ne", left: rect.width - HALF, top: -HALF, cursor: "nesw-resize" },
    { h: "w", left: -HALF, top: rect.height / 2 - HALF, cursor: "ew-resize" },
    { h: "e", left: rect.width - HALF, top: rect.height / 2 - HALF, cursor: "ew-resize" },
    { h: "sw", left: -HALF, top: rect.height - HALF, cursor: "nesw-resize" },
    { h: "s", left: rect.width / 2 - HALF, top: rect.height - HALF, cursor: "ns-resize" },
    { h: "se", left: rect.width - HALF, top: rect.height - HALF, cursor: "nwse-resize" },
  ];

  return (
    <div
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        border: "2px solid #38bdf8",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
        borderRadius: 2,
        cursor: canMove ? "move" : "not-allowed",
        pointerEvents: "auto",
        touchAction: "none",
      }}
      onPointerDown={onBodyDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Label tag */}
      <div
        style={{
          position: "absolute",
          top: -24,
          left: -2,
          background: "#38bdf8",
          color: "#04121c",
          font: "600 11px ui-monospace, SFMono-Regular, monospace",
          padding: "2px 6px",
          borderRadius: 3,
          whiteSpace: "nowrap",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        #{id}
        {!canMove && <span style={{ marginLeft: 6, opacity: 0.75 }}>· no-box</span>}
      </div>

      {/* Delete button */}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        style={{
          position: "absolute",
          top: -24,
          right: -2,
          background: "#ef4444",
          color: "#fff",
          font: "600 11px ui-sans-serif, system-ui, sans-serif",
          padding: "2px 8px",
          border: "none",
          borderRadius: 3,
          cursor: "pointer",
          pointerEvents: "auto",
        }}
        title="Delete element (Delete/Backspace)"
      >
        Delete
      </button>

      {/* Rotation tether + handle (above top-center). */}
      <div
        style={{
          position: "absolute",
          left: rect.width / 2 - 1,
          top: -28,
          width: 2,
          height: 24,
          background: "#38bdf8",
          pointerEvents: "none",
        }}
      />
      <div
        role="button"
        aria-label="Rotate"
        title="Drag to rotate"
        onPointerDown={(e) => onRotateDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          position: "absolute",
          left: rect.width / 2 - 8,
          top: -44,
          width: 16,
          height: 16,
          background: "#38bdf8",
          border: "1px solid #04121c",
          borderRadius: "50%",
          cursor: "grab",
          pointerEvents: "auto",
          touchAction: "none",
        }}
      />

      {/* Interactive resize handles */}
      {handles.map(({ h, left, top, cursor }) => (
        <div
          key={h}
          onPointerDown={(e) => onHandleDown(h, e)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            position: "absolute",
            left,
            top,
            width: HANDLE,
            height: HANDLE,
            background: "#38bdf8",
            border: "1px solid #04121c",
            borderRadius: 2,
            cursor,
            pointerEvents: "auto",
            touchAction: "none",
          }}
        />
      ))}
    </div>
  );
}

function EditingHint({ rect }: { rect: ScreenRect }) {
  return (
    <div
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top + rect.height + 8,
        font: "600 11px ui-sans-serif, system-ui, sans-serif",
        color: "#38bdf8",
        background: "rgba(4, 18, 28, 0.85)",
        border: "1px solid rgba(56, 189, 248, 0.45)",
        padding: "3px 8px",
        borderRadius: 3,
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      Editing text · Enter to save · Esc to cancel
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find the nearest ancestor with an `id` — ANY kind of element, including
 * SVG sub-shapes. Used for text editing (dbl-click) so authors can click
 * directly on an `<svg><text>` node and edit its content.
 */
function findEditableAncestor(start: Node | null, doc: Document): HTMLElement | null {
  let node: Node | null = start;
  for (let depth = 0; node && depth < PICK_MAX_DEPTH; depth++) {
    if (node.nodeType === 1) {
      const el = node as HTMLElement;
      if (!PICK_SKIP_TAGS.has(el.tagName) && el !== doc.documentElement && el.id) {
        return el;
      }
    }
    node = node.parentNode;
  }
  return null;
}

/**
 * Find the nearest HTML-element ancestor with an `id`, skipping past any
 * SVG descendants. Used for selection + drag, because:
 *
 *   • The auto-id pass assigns ids to every SVG child (rect, line, text),
 *     but users almost always want to grab the whole HTML container
 *     (e.g. `#tv-logo`) not one of its sub-shapes.
 *   • SVG internals are positioned by their own geometry (`x`/`y`/`cx`
 *     attributes), so CSS `translate` on a `<rect>` doesn't give the
 *     expected behaviour. Drag targets need a CSS-boxed element.
 *
 * If you truly want to target a specific SVG shape for drag, use the
 * Code editor or edit the source directly.
 */
// Cross-realm note: iframe elements don't pass `instanceof HTMLElement`
// against the parent's constructor. Use `namespaceURI` instead — it's
// realm-independent.
const SVG_NS = "http://www.w3.org/2000/svg";

function findDragAncestor(start: Node | null, doc: Document): HTMLElement | null {
  let node: Node | null = start;
  for (let depth = 0; node && depth < PICK_MAX_DEPTH; depth++) {
    if (node.nodeType === 1) {
      const el = node as Element;
      const isSvg = el.namespaceURI === SVG_NS;
      if (
        !isSvg &&
        !PICK_SKIP_TAGS.has(el.tagName.toUpperCase()) &&
        el !== doc.documentElement &&
        el.id
      ) {
        return el as HTMLElement;
      }
    }
    node = node.parentNode;
  }
  return null;
}

/**
 * Walk up from `el`, multiplying inherited opacity and checking visibility at
 * every ancestor. Returns the EFFECTIVE opacity the user actually sees on
 * screen (e.g. a child of a faded-out scene wrapper is invisible even if its
 * own opacity is 1). Short-circuits at 0 / visibility:hidden.
 */
function effectiveOpacity(el: Element, doc: Document): number {
  const win = doc.defaultView ?? window;
  let op = 1;
  let cur: Element | null = el;
  const root = doc.documentElement;
  while (cur && cur !== root && cur !== doc.body) {
    let cs: CSSStyleDeclaration | null = null;
    try {
      cs = win.getComputedStyle(cur);
    } catch {
      return op;
    }
    if (cs.visibility === "hidden" || cs.display === "none") return 0;
    const own = parseFloat(cs.opacity);
    if (Number.isFinite(own)) {
      op *= own;
      if (op < 0.0001) return op;
    }
    cur = cur.parentElement;
  }
  return op;
}

/**
 * Hit-test at a screen-relative point (client coords within the iframe) and
 * return the topmost editable element the user can actually SEE.
 *
 * This fixes the "click at t=0 selects a later scene" bug. `document.
 * elementsFromPoint()` returns every element under the cursor regardless of
 * opacity — the browser's normal hit-test treats a faded-out element as
 * visible for event dispatch. We filter that list by effective opacity and
 * pick the first one whose ancestor chain passes the visibility threshold.
 *
 * `mode` controls ancestor resolution:
 *   • "drag" (default) — returns the nearest HTMLElement, skipping SVG
 *     internals. Use for selection and hover.
 *   • "text" — returns the deepest id'd element, including SVG. Use for
 *     double-click text editing.
 */
function pickVisibleAt(
  x: number,
  y: number,
  doc: Document,
  mode: "drag" | "text" = "drag",
): HTMLElement | null {
  const stack = doc.elementsFromPoint(x, y);
  const finder = mode === "text" ? findEditableAncestor : findDragAncestor;
  for (const el of stack) {
    // Cross-realm safe: `instanceof Element` would fail for iframe
    // elements since Element is a per-realm constructor. `nodeType === 1`
    // is a DOM contract, realm-independent.
    if (!el || el.nodeType !== 1) continue;
    if (effectiveOpacity(el, doc) < VISIBLE_OPACITY_THRESHOLD) continue;
    const editable = finder(el, doc);
    if (editable) return editable;
  }
  return null;
}

/**
 * Read the element's CSS `translate` property (the standalone 2D translate,
 * NOT `transform: translate(...)`) in logical pixels. Returns `{ x: 0, y: 0 }`
 * if the element has no explicit translate.
 *
 * We intentionally ignore `transform` here: GSAP animations write to
 * `transform`, and the drag overlay needs a channel that coexists with those
 * animations rather than fighting them. The browser composes `translate` with
 * `transform`, so our offset lives alongside whatever the timeline is doing.
 *
 * Non-px units (%, vw, etc.) are rejected — we stick to pixel offsets so the
 * drag math stays frame-rate and resize independent.
 */
/**
 * Guarantee the element is positioned so `left`/`top` actually move it.
 *
 * Elements default to `position: static`, where `left`/`top` are ignored.
 * If the element has no stylesheet rule making it absolute/relative/fixed,
 * we add an inline `position: absolute`. Idempotent — re-running on an
 * already-positioned element is a no-op.
 */
function ensurePositioned(el: HTMLElement): void {
  const inlinePos = el.style.position;
  if (inlinePos && inlinePos !== "static") return;
  const cs = el.ownerDocument?.defaultView?.getComputedStyle(el);
  if (cs && cs.position !== "static") return;
  el.style.position = "absolute";
}

/**
 * Read the element's current `left`/`top` in logical pixels.
 *
 * Prefers the inline style (that's what we write + what we serialise), then
 * falls back to getComputedStyle so the first drag on an unstyled element
 * still starts from the right place.
 */
function readLeftTop(el: HTMLElement): { left: number; top: number } {
  const parsePx = (raw: string | null | undefined) => {
    if (!raw) return Number.NaN;
    const m = /^(-?\d*\.?\d+)px$/i.exec(raw.trim());
    return m ? parseFloat(m[1] ?? "") : Number.NaN;
  };
  let left = parsePx(el.style.left);
  let top = parsePx(el.style.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    const cs = el.ownerDocument?.defaultView?.getComputedStyle(el);
    if (cs) {
      if (!Number.isFinite(left)) left = parsePx(cs.left);
      if (!Number.isFinite(top)) top = parsePx(cs.top);
    }
  }
  if (!Number.isFinite(left)) left = 0;
  if (!Number.isFinite(top)) top = 0;
  return { left, top };
}

function computeIframeScale(iframe: HTMLIFrameElement): {
  scaleX: number;
  scaleY: number;
  iframeRect: DOMRect;
} | null {
  try {
    const iframeRect = iframe.getBoundingClientRect();
    const doc = iframe.contentDocument;
    const stage =
      (doc?.querySelector("[data-composition-id]") as HTMLElement | null) ??
      doc?.documentElement ??
      null;
    const innerW = stage?.clientWidth ?? iframe.contentWindow?.innerWidth ?? 1920;
    const innerH = stage?.clientHeight ?? iframe.contentWindow?.innerHeight ?? 1080;
    if (!innerW || !innerH) return null;
    return {
      scaleX: iframeRect.width / innerW,
      scaleY: iframeRect.height / innerH,
      iframeRect,
    };
  } catch {
    return null;
  }
}

function readEditableText(el: Element): string {
  // Walk in document order, emitting "\n" for <br> and text for text nodes.
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const e = node as Element;
    if (e.tagName === "BR") {
      out.push("\n");
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(el);
  return out
    .join("")
    .replace(/\u00a0/g, " ")
    .trim();
}

async function deleteElement(projectId: string, id: string, filePath: string): Promise<void> {
  try {
    await commitMutation(projectId, { type: "delete", id }, filePath);
  } catch (err) {
    console.warn("[direct-edit] failed to delete element", err);
  }
}
