# HyperFrames Player — Performance Review & Architecture Proposal

**Author:** James Russo
**Revised by:** Vance Ingalls
**Date:** 2026-04-20
**Scope:** `packages/player` + `packages/core/src/runtime` + studio consumer
**Status:** Final draft

---

## TL;DR

The preview player's dominant perf costs for video/image-heavy compositions are (1) a non-vsync 50 ms `setInterval` as the runtime master clock, (2) `el.currentTime` drift correction that thrashes video decoders, (3) parent-proxy promotion that creates `<video>` elements where `<audio>` elements may suffice — potentially doubling decoder pressure (needs validation), and (4) asynchronous postMessage seek that forces studio to bypass the official bridge entirely.

The iframe boundary is **not** the bottleneck and remains the right choice for **public embeds** (untrusted hosts). For the **studio preview**, we should add a second `mode="inline"` that mounts compositions directly into the player's Shadow DOM — making seek synchronous, eliminating the audio-owner protocol for same-origin, and collapsing two compositor layer trees into one.

> **Caveat:** This analysis is code-reading, not profiling. Before landing any fix, validate with the traces specified in the Validation Plan. Each phase has concrete pass/fail SLOs — don't proceed to the next phase without hitting them.

---

## How the current pipeline works

1. `<hyperframes-player>` custom element creates a Shadow DOM containing an `<iframe sandbox="allow-scripts allow-same-origin">` with the composition HTML.

2. Inside the iframe, the core runtime installs a `setInterval(…, 50)` poll (`core/src/runtime/init.ts:1502-1561`) that:
   - Calls `syncCurrentTimeFromTimeline()` — reads the GSAP timeline position.
   - Calls `syncMediaForCurrentState()` (if playing) — iterates all `<video>`/`<audio>` elements, compares `el.currentTime` to expected, corrects drift.
   - Calls `postState(false)` — sends `window.parent.postMessage({source:"hf-preview", type:"state", …})`, throttled by `bridgeMaxPostIntervalMs: 80` (`core/src/runtime/state.ts:67`).
   - Calls `postTimeline()` every 20th tick (~once per second).

3. Parent listens for state messages, throttles UI updates to ~12 Hz, dispatches a `timeupdate` event.

4. Control flows (play/pause/seek) are **asynchronous**: parent `postMessage` → iframe bridge (`bridge.ts:22-71`) dispatches to handlers → next 50 ms tick → parent receives `state` → UI updates. Round-trip >= 50–100 ms.

5. The outer iframe is scaled with `transform: translate(-50%, -50%) scale(S)` to fit the container (`player/src/hyperframes-player.ts:530`).

6. Studio (same-origin) **bypasses postMessage entirely** and reads `iframe.contentWindow.__player` directly (with fallback to `__timelines`) for its own rAF loop (`studio/src/player/hooks/useTimelinePlayer.ts:233-239`). This is a strong signal that the official bridge is too slow for tight UI.

7. When autoplay is blocked, the runtime sends a `media-autoplay-blocked` message. The parent responds by "promoting" to parent-proxy ownership: it creates mirror `<video>`/`<audio>` elements for every `<video data-start>`/`<audio data-start>` in the iframe, preloaded at iframe-ready time (`player/src/hyperframes-player.ts:703-718`). The iframe runtime mutes its output; the parent proxies handle audible playback. **Both** the iframe video and the parent video decode simultaneously.

---

## Concrete bottlenecks

### 1. `setInterval(50 ms)` as the master clock

`core/src/runtime/init.ts:1502-1561`. Not vsync-aligned — on 60/120 Hz displays, ticks land at arbitrary points in the frame, producing beat-frequency stutter. Every tick unconditionally runs `syncCurrentTimeFromTimeline()`; `syncMediaForCurrentState()` is gated on `isPlaying` (line 1557). The per-tick media iteration is the dominant cost for 10-video grids because each clip's `currentTime` read/compare runs on every active element.

**Backgrounding concern:** When replacing with rAF, note that `requestAnimationFrame` stops firing when the tab is hidden (Page Visibility API). The current `setInterval` also throttles to ~1 Hz when backgrounded, but it doesn't stop entirely. The fix must include a fallback interval for keep-alive when the page is not visible.

### 2. Drift correction thrashes decoders

`core/src/runtime/media.ts:160-174`. The correction logic has three thresholds:
- **0.5 s "hard" threshold** (line 166): `offsetJumped = Math.abs(offset - prevOffset!) > 0.5`
- **`firstTickOfClip`** (line 165): forces a resync when `prevOffset === undefined` — painful for compositions with many sub-compositions that activate/deactivate clips frequently.
- **3 s "catastrophic" threshold** (line 167): forces correction regardless of other conditions.

Repeated `el.currentTime = relTime` writes (line 170) trigger decode-pipeline flushes. The 0.5 s threshold helps steady-state, but `firstTickOfClip` fires on every sub-composition entry.

### 3. Seek is async through postMessage

No same-frame UI feedback on a scrub. Studio works around it with direct `__player` access (`useTimelinePlayer.ts:233`), which only works same-origin. External embeds using the public API will feel laggy.

### 4. Parent-proxy `<video>` doubles decoders unnecessarily

`_adoptIframeMedia` (`player/src/hyperframes-player.ts:725-756`) mirrors `<video data-start>` into a parent `<video>`. The proxy exists **only for audio output** — the visual stays in the iframe. But creating a `<video>` element forces a second video decoder even though only the audio track is needed.

For a 5-video composition promoted to parent ownership, that's 10 simultaneous video decoders when 5 video + 5 audio would suffice.

**Note:** The proxy system itself is well-designed — preloading at iframe-ready time gives tight audio cut-in on promotion, one-way ownership prevents thrashing, and the 50 ms mirror drift threshold is ITU-compliant. The fix is narrow: use `<audio>` elements for video-source proxies.

### 5. MutationObserver on full iframe body subtree

`player/src/hyperframes-player.ts:803` — `obs.observe(doc.body, { childList: true, subtree: true })`. For image/video-heavy compositions with dynamic CSS/DOM, this fires constantly for mutations unrelated to media adoption.

### 6. `postState` fires at up to ~12–15 Hz during playback

`bridgeMaxPostIntervalMs: 80` (`core/src/runtime/state.ts:67`). Each hop serializes/deserializes, wakes the parent event loop, runs `_mirrorParentMediaTime` which loops through all proxies. Cost scales linearly with proxy count.

### 7. `document.querySelectorAll("video[data-start], audio[data-start]")` re-run frequently

`core/src/runtime/media.ts:23`. Cached in state but invalidated on sub-composition activation. Not catastrophic, but unnecessary churn in compositions with many clips.

### 8. Per-instance shadow stylesheet

`PLAYER_STYLES` is a raw CSS string (`player/src/styles.ts:1-198`) injected via `style.textContent = PLAYER_STYLES` per player instance (`player/src/hyperframes-player.ts:88`). In studio panels with thumbnails (multiple `<hyperframes-player>` nodes), this creates N duplicate `<style>` elements. `adoptedStyleSheets` with a shared `CSSStyleSheet` would eliminate the copies.

### 9. Full iframe reload on every composition switch

Setting `iframe.src` triggers a fresh HTML parse + script load + runtime bootstrap + full teardown of prior state (`player/src/hyperframes-player.ts:385-410`). Studio mounts a separate iframe per thumbnail — the expensive path repeated N times per project.

### 10. Outer `transform: scale()` — likely a non-issue

The iframe is scaled with `transform: translate(-50%, -50%) scale(S)` (`player/src/hyperframes-player.ts:530`). The original draft speculated this might inhibit hardware video overlay promotion. However, Chromium's `OverlayProcessor` promotes when the transform decomposes to a 2D axis-aligned translate/scale, which this transform does. Overlay promotion is more commonly blocked by non-axis-aligned transforms, blend modes, filters, or clip-path — none of which apply here.

**Recommendation:** Verify with a `chrome://gpu` trace in Phase 0. If confirmed as a non-issue (expected), remove from the action list. If the trace shows unexpected layer behavior, revisit.

---

## Recommended actions (ordered by impact-per-effort)

### 1. Replace the 50 ms `setInterval` with `requestAnimationFrame`

During `isPlaying`, use rAF for vsync-aligned ticks. Add a 250 ms `setInterval` fallback for:
- **Paused keep-alives** — the player still needs to post state occasionally.
- **Hidden-tab fallback** — rAF stops firing when `document.hidden === true`. Listen for `visibilitychange` to swap between rAF and interval.
- **Headless capture** — the producer package runs under Puppeteer's virtual time and already replaces `window.requestAnimationFrame` wholesale with a virtual-time queue (`producer/src/services/fileServer.ts:104-117`). Guard with `window.__HF_VIRTUAL_TIME__ === undefined` and fall back to the existing `setInterval` path. This makes the rAF swap safer than it might seem — producer intercepts rAF at a higher level — but the guard ensures the runtime's own fallback is explicit.

**Interaction with Action #2:** Moving from 20 Hz (50 ms interval) to 60 Hz (rAF) means 3x more ticks. This is fine because Action #2 removes the expensive per-tick work (drift polling). Without Action #2, rAF alone would *increase* per-tick cost. **These two actions must ship together in Phase 2.**

### 2. Use `requestVideoFrameCallback()` to measure drift, not per-tick polling

RVFC fires when a video frame has been composited, exposing `metadata.mediaTime` — the actual presented media time. Replace the per-tick `el.currentTime` read/compare with an RVFC-driven observation:

```
function onVideoFrame(now, metadata) {
  const drift = Math.abs(metadata.mediaTime - expectedMediaTime);
  if (drift > 0.5) el.currentTime = expectedMediaTime;
  el.requestVideoFrameCallback(onVideoFrame);
}
```

This cuts per-tick media iteration cost to zero for RVFC-capable elements during active playback. `<audio>` elements and older browsers fall back to the existing per-tick path.

**State-transition gap:** RVFC only fires while the video is actively playing and presenting frames. It does **not** fire during pause, seek-while-paused, clip activation/deactivation, or pre-start. The per-tick polling path must remain active for these state transitions — RVFC replaces steady-state drift observation, not the full media sync loop. Specifically: `firstTickOfClip` resyncs and seek corrections still run through the interval/rAF tick path.

**Browser support:** RVFC is available in Chrome 83+, Edge 83+, Safari 15.4+, Firefox 132+. No iOS Safari support below 15.4. Check the player's browser support baseline — if it includes older Safari, the fallback path must remain robust.

### 3. Use `<audio>` for video-source proxies (hypothesis — gated on Phase 0)

**Hypothesis:** In `_createParentMedia` (`player/src/hyperframes-player.ts:656-675`), parent proxies for `<video>` sources could use `<audio>` elements instead of `<video>` elements, since the proxy only needs audio output — the visual stays in the iframe. If browsers reliably decode audio from video containers (MP4/H.264+AAC, WebM/VP9+Opus) via `<audio>`, this would halve decoder pressure under parent-proxy promotion.

**Why this needs validation, not assumption:** The current proxy system is an intentional separation of concerns — the iframe video handles visuals, the parent video handles audio. The `<video>` tag in the parent ensures decoder-state parity with the iframe's media timeline. On mobile, video codec state can be tightly coupled with power management, and `<audio src="video.mp4">` may not reliably extract the audio track on all platforms. If A/V sync regresses or decoder-count reduction doesn't materialize, keep the current design.

**Phase 0 gate:** Test `<audio src="video.mp4">` playback on Chrome desktop, Chrome Android, Safari desktop, and Safari iOS with 5 representative composition videos. Measure decoder count (`webkitDecodedFrameCount`) and A/V sync drift. Only proceed if decoder count drops and sync holds within 50 ms on all platforms.

**Do NOT use `document.adoptNode` to transfer `<video>` elements from the iframe.** Adopting a playing `<video>` into a different document resets the decoder pipeline, causing a rebuffer.

### 4. Share the player stylesheet via `adoptedStyleSheets`

One `CSSStyleSheet` constructed with `new CSSStyleSheet()`, populated with `PLAYER_STYLES`, assigned to every player shadow root via `shadowRoot.adoptedStyleSheets = [sharedSheet]`. Eliminates N duplicate `<style>` elements in studio's thumbnail grid.

### 5. Scope the MutationObserver to `[data-composition-id]` host nodes

Instead of `doc.body` with `{ childList: true, subtree: true }`, observe only the composition host elements. This reduces mutation callbacks to composition-relevant DOM changes.

In inline mode (Phase 4), the MutationObserver for media adoption becomes unnecessary — media elements are already in the parent document.

### 6. Expose a synchronous `seek()` on the public player API

Studio already does this privately via `iframe.contentWindow.__player`. Formalize it:

```
// On the <hyperframes-player> element
player.seek(frame)  // synchronous when same-origin
player.seek(frame)  // async fallback when cross-origin (postMessage bridge)
```

Detect same-origin access with a try/catch on `iframe.contentWindow` access. External cross-origin embeds fall back to the async bridge transparently.

### 7. Fast composition switching

Two complementary strategies:

**7a. `srcdoc` for studio (no network round-trip):** Studio already has composition HTML as a string. Use `iframe.srcdoc = compositionHtml` instead of `iframe.src = url`. This eliminates the network fetch and is faster than a pool for single-composition switches.

**7b. Warm iframe pool (optional, for rapid switching):** For cases where the user rapidly switches between compositions (project browser), maintain a pool of up to **3 warm iframes** (LRU by composition-id). **Exclude thumbnail grids** — thumbnails should use static screenshots, not live iframes.

Each warm iframe retains a full runtime + adapters + GSAP (+ potentially Three/Lottie), so memory pressure is real. Enforce a hard cap and evict the least-recently-used iframe when the cap is hit. Monitor total iframe memory in Phase 0 to validate the cap.

### 8. Coalesce `_mirrorParentMediaTime` writes

Tighten the threshold: only write `el.currentTime` when drift is *trending* (consecutive readings above threshold), not on a single spike. This reduces seek thrash during transient jitter without loosening the steady-state sync guarantee.

---

## Architectural alternative: two-mode player

The iframe exists for two reasons — **CSS isolation** (composition CSS doesn't leak to host) and **script isolation** (composition `<script>` doesn't touch host globals). In 2026, Shadow DOM handles CSS isolation fully; ES-module scoping handles script isolation for format-constrained compositions.

### `mode="isolated"` (iframe — current default)

What public embeds use. Keeps untrusted composition scripts sandboxed in a separate realm. The iframe's `window` global is distinct from the host page's.

### `mode="inline"` (shadow DOM, no iframe)

What studio and first-party hosts use.

- Composition HTML is parsed into a `<template>`, cloned into the player's shadow root.
- Runtime runs in the parent realm — **no postMessage, synchronous** `play`/`pause`/`seek`.
- `<video>` elements are real siblings of the host page — user activation propagates same-frame, eliminating the autoplay-gate and the entire parent-proxy promotion path.
- GSAP timelines are reached directly — studio's `__player` pattern becomes the public API.
- Compositing is one layer tree, not two.

### Security model

**The trust boundary must be explicit.** A same-origin iframe is a separate realm-of-scripts — it prevents a composition from accidentally calling `window.location.assign` or accessing host cookies. Inline mode removes that boundary.

Three trust levels:

| Level | Mode | When |
|-------|------|------|
| **Untrusted** | `isolated` (iframe) | Third-party embeds, user-shared compositions |
| **Format-constrained** | `inline` with validation gate | Studio preview of compositions that pass the linter and contain only registered adapters (GSAP, Lottie, Three.js) — no arbitrary `<script>` tags |
| **Fully trusted** | `inline` without gate | First-party compositions authored by the studio's own generator pipeline |

**Implementation:** Add a `canRunInline(compositionHtml): boolean` gate. Parse the HTML with linkedom (already a dependency via `htmlBundler.ts`) and reject if any of these fail:

1. **Script allowlist:** Every `<script src>` URL must match the registered CDN allowlist (GSAP `cdn.jsdelivr.net/npm/gsap@3`, Lottie, Three.js — enumerated, not pattern-matched). Unknown external scripts → reject.
2. **Inline script denylist check:** Scan each inline `<script>` body for dangerous patterns. This is a denylist approach (reject known-bad) rather than an allowlist AST parse, because compositions legitimately use `addEventListener`, `IntersectionObserver`, `requestAnimationFrame`, `MutationObserver`, `CustomEvent`, and dynamic `document.createElement` for Three.js scenes, scroll-linked animations, and Lottie setup. Reject scripts containing: `fetch(`, `XMLHttpRequest`, `import(`, `eval(`, `Function(`, `document.cookie`, `localStorage`, `sessionStorage`, `window.location`, `window.parent`, `window.top`, `window.opener`, `postMessage(` (outside the runtime bridge). Use a regex scan — adding a JS parser dependency (no JS parser exists in the project today) is not justified for a denylist.
3. **No inline event handlers:** Reject elements with `on*` attributes (`onclick`, `onerror`, `onload`, etc.).
4. **Linter pass:** No `external_script_dependency` warnings on unknown scripts.

Compositions that fail the gate fall back to `isolated` mode automatically. This makes inline mode safe-by-default. The gate runs at composition-load time, not per-frame — the cost is a single parse per composition switch.

**Composition scripts also need IIFE wrapping at compile time** — the bundler already does this (`core/src/runtime/compositionLoader.ts:206`), but inline mode must ensure the wrapping applies in the parent realm too, preventing global leakage.

### Runtime refactoring scope

The runtime currently makes **30+ `document.*` queries, sets 7 `window.*` globals, registers 5 window event listeners, and communicates via `window.parent.postMessage`** across ~12 source files (`init.ts`, `bridge.ts`, `media.ts`, `state.ts`, `timeline.ts`, `entry.ts`, `picker.ts`, `compositionLoader.ts`, and 5 adapter files`).

Making the runtime realm-agnostic requires:

1. **Scope injection** — every `document.querySelector*` call takes a `root` parameter (either `document` or a `ShadowRoot`). Every `window.*` global becomes a property on a context object passed at init time.

2. **Bridge abstraction** — `postRuntimeMessage` calls a callback instead of `window.parent.postMessage`. In iframe mode, the callback is postMessage. In inline mode, it's a direct function call.

3. **Adapter scoping** — CSS adapter's `document.querySelectorAll("*")` and WAAPI adapter's `document.getAnimations()` must scope to the composition root. Lottie and Three.js adapters read `window.__hfLottie` / `window.__hfThreeTime` — these become context properties.

4. **Picker machinery** — the picker uses `document.elementsFromPoint()`, `document.body.classList`, and captures document-level mouse/keyboard events. In inline mode, these must scope to the shadow root. `elementsFromPoint` specifically needs to be called on the shadow root (`shadowRoot.elementsFromPoint`), which is supported in modern browsers.

5. **Multi-instance isolation** — multiple inline players on the same page must not collide. The current `window.__timelines` registry is keyed by composition ID — but in studio, the same composition can be open in multiple panels (preview + scene editor). Same composition ID, two inline players, one `__timelines` registry = the second instance overwrites the first's timeline. **`__timelines` must move out of the global scope and into the per-instance `RuntimeContext`.** This is load-bearing for Phase 4.

**Estimated scope:** ~500-800 LOC of refactoring across 12 files to introduce a `RuntimeContext` interface, plus adapter updates and picker scoping. The heaviest lift is `init.ts` (~1650 lines) which concentrates most of the `window.*` and `document.*` references. The picker machinery (`picker.ts`) is the second-heaviest due to its `elementsFromPoint`, event capture, and style injection patterns.

---

## What not to do (yet)

- **Full WebCodecs + OffscreenCanvas rewrite.** Throws away the "HTML *is* the composition" premise. CSS animations, nested iframes, Lottie, Three.js, and text layout stop working in a canvas. Reserve for a separate rendering backend used only for export (producer already lives there).

- **`AudioContext` mixer for all audio.** A `MediaElementAudioSourceNode` wrapper could aggregate cleanly for the asset-URL case. But don't aggregate until profiling confirms per-element decoder count is actually the bottleneck after Action #3 (audio-only proxies) ships.

---

## Proposed rollout order

### Phase 0 — Measure and establish baselines (~0.5 week)

Capture the traces listed in the Validation Plan on a representative 10-video composition. **Do not start Phase 1 until the traces confirm the bottleneck claims.**

**Pass/fail SLOs for each subsequent phase:**

Phase 0 will establish current baselines (the "est." column below). Absolute targets are UX-motivated and hold regardless of baseline.

| Metric | Current (est.) | Phase 2 target | Phase 4 target |
|--------|---------------|----------------|----------------|
| Scrub latency (same-origin) | ~100 ms | p50 < 50 ms, p95 < 80 ms | p50 < 16 ms, p95 < 33 ms |
| Scrub latency (cross-origin) | ~100 ms | p50 < 80 ms, p95 < 120 ms | p50 < 50 ms, p95 < 80 ms |
| Composition switch (warm) | ~1500 ms | < 800 ms | < 300 ms |
| Composition switch (cold) | ~2000 ms | < 1500 ms | < 1500 ms (< 2000 ms for heavy*) |
| Sustained fps (10-video) | ~30-45 fps | 60 fps | 60 fps |
| Decoder count under promotion | 2N | N (if Action #3 validates) | 0 (no promotion) |
| Dropped frames (10s playback) | TBD | < 5 | < 2 |

\* "Heavy" = compositions with Three.js + Lottie + WebGL context + >5 MB total assets. These have irreducible cold-start costs (WebGL context init, large asset decode) that inline mode doesn't eliminate.

### Phase 1 — Low-risk wins (~1 week, no API change)

- `adoptedStyleSheets` for shared player styles
- Scoped MutationObserver
- Audio-only proxy prototype (`<audio>` for video-source parent media) — validate on 4 browser/OS combos. Ship only if decoder count drops and A/V sync holds.
- Coalesced `_mirrorParentMediaTime` writes
- Verify outer-transform overlay-promotion hypothesis via `chrome://gpu` trace (expected: non-issue, close the item)

**Phase 1 validation:** Mirror write frequency drops by >50%. If audio-only proxy validates, decoder count under promotion drops to N.

### Phase 2 — Runtime clock + RVFC (~1–2 weeks)

- Replace `setInterval` with rAF (with visibility-change fallback and headless guard)
- RVFC-driven drift observation (ships together with rAF — see interaction note in Action #1)
- Producer parity regression suite run on day one

**Phase 2 validation:** 60 fps sustained on 10-video comp. Dropped frames < 5 per 10s. Producer parity harness green.

### Phase 3 — Synchronous seek + fast switching (~1–2 weeks)

- Synchronous `seek()` API on the player element (same-origin detection)
- `srcdoc` composition switching for studio
- Optional warm iframe pool (cap at 3, LRU, exclude thumbnails)

**Phase 3 validation:** Scrub latency < 50 ms same-origin. Composition switch < 800 ms warm.

### Phase 4a — Inline mode behind flag, studio-only (~5–7 weeks for 1 engineer, ~3–4 weeks for 2)

**Staffing assumption:** The scope splits naturally into (A) runtime/adapters (RuntimeContext, bridge abstraction, adapter scoping — concentrated in `core/`) and (B) player/gate/studio (inline player mode, `canRunInline()`, studio wiring — concentrated in `player/` and `studio/`). Two engineers with clear file-ownership can parallelize.

- `RuntimeContext` interface: scope injection for all `document.*` / `window.*` references
- Bridge abstraction (direct callback in inline mode)
- Adapter scoping (GSAP, Lottie, Three.js, CSS, WAAPI)
- Multi-instance isolation: move `window.__timelines` into per-instance `RuntimeContext` (same composition ID in two inline players must not collide)
- `canRunInline()` composition validation gate
- Shadow DOM CSS compatibility validation:
  - `@font-face` declarations — Chrome requires these in the document, not the shadow root. Compositions using custom fonts need font-face rules hoisted to the document at mount time.
  - `vh`/`vw` units resolve against the viewport, not the composition container. Compositions using viewport-relative units need transformation to container-relative units (or CSS `cqi`/`cqb` with container queries).
  - `:root` selectors target the document root, not the shadow host. Compositions using `:root { --custom-prop: ... }` need selector rewriting to `:host`.
- Inline player mode wired up behind `__HF_INLINE_PLAYER` feature flag
- Studio opts in for preview panel only (not thumbnails)

**Phase 4a validation:** Studio preview works in inline mode for 5 representative compositions (including at least one with custom fonts and one with viewport-relative units). Scrub latency p50 < 16 ms. No autoplay-proxy path triggered. Feature flag can be toggled without reload.

### Phase 4b — Inline mode as studio default (~2–3 weeks)

- Remove feature flag, inline is default for studio
- Migrate all studio call sites (preview, scene editor, export preview)
- Thumbnails remain iframe-based (static screenshot preferred)
- Producer compat shim (producer continues using iframe/headless path, unaffected)
- Public API stabilization: `<hyperframes-player mode="inline|isolated">`

**Phase 4b validation:** All studio E2E tests pass. No regressions in public embed path. Memory usage in studio < 1.2x current with 10+ compositions open.

---

## Producer impact

`packages/producer` consumes `@hyperframes/core`'s runtime for headless rendering via Puppeteer. `producer/src/services/renderOrchestrator.ts` and the parity harness (`producer/src/parity-harness.ts`) both bind against `__timelines`.

**What's affected:**

- **Phase 2 (rAF clock):** Headless rendering drives time virtually (seek-per-frame). rAF firing semantics under Puppeteer's virtual time differ from live playback. Producer already replaces `window.requestAnimationFrame` with a virtual-time queue (`fileServer.ts:104-117`), but the runtime's own `__HF_VIRTUAL_TIME__` guard provides an explicit fallback to `setInterval`.
- **Phase 4 (`RuntimeContext`):** Producer imports the IIFE runtime bundle. The `RuntimeContext` refactor must preserve the existing default export where `root = document` and `globals = window`. Producer never uses inline mode.

**Mitigation:** Run the producer parity harness as a CI gate on every Phase 2+ PR. If the harness doesn't cover the clock/media-sync paths (verify in Phase 0), extend it before starting Phase 2.

---

## Validation plan (run before landing fixes)

### Pre-land traces (Phase 0)

1. **Chrome Performance profile** on a representative 10-video composition during 10s of playback. Confirm the 50 ms tick is actually hot and that drift-correction `currentTime` writes show up as decoder flushes. Record CPU time in the setInterval callback.

2. **Decoder-count trace** — log `video.webkitDecodedFrameCount` and `video.webkitDroppedFrameCount` per-clip before and after promotion to parent-proxy audio ownership. Confirms the "double decoder" claim under autoplay-block. Test with `<audio src="video.mp4">` to validate the audio-only proxy approach.

3. **Composited-layers dump** (`chrome://gpu` + `chrome://tracing` with `cc,viz` categories) to confirm or reject the outer-transform overlay-promotion hypothesis. **Expected result: non-issue.** Document and close.

4. **Scrub latency** — record timestamp from `mousedown` on scrubber to first frame update in the preview, under both cross-origin (public) and same-origin (studio) paths. Establishes the "synchronous seek" benefit numerically.

5. **Composition-switch time** — record iframe `load` → `ready` for 5 representative compositions. Baseline for the fast-switch proposal. Compare `iframe.src` vs `iframe.srcdoc` for studio's case.

6. **Memory profile** — measure per-iframe memory overhead with a representative composition (runtime + GSAP + adapters). Establishes the memory cap for the warm iframe pool. If per-iframe cost is >50 MB, pool size may need to be capped at 2 instead of 3.

7. **RVFC browser coverage** — verify `requestVideoFrameCallback` availability across the player's supported browser matrix. Identify which browsers fall back to per-tick polling and ensure the fallback path remains correct.

8. **Composition corpus audit for `canRunInline()`** — run the proposed denylist gate against 20 representative shipped compositions (GSAP-only, GSAP+Lottie, Three.js scenes, audio-reactive, etc.). Report the pass/fail rate. If fewer than 70% of studio-authored compositions pass, the denylist is too aggressive and needs tuning before Phase 4a.

9. **Producer parity harness coverage check** — the existing parity harness (`producer/src/parity-harness.ts`) uses synchronous `renderSeek()` per-frame, which bypasses the interval/rAF clock entirely. It proves frame-accurate rendering but does **not** validate live-playback timing, media sync cadence, or state posting under the new clock. Phase 2 requires a separate **live-playback regression test**: play a 10-second composition end-to-end, assert dropped frames < 5 and A/V sync drift < 50 ms. Build this test in Phase 0 so it's ready when Phase 2 starts.

Store raw Phase 0 traces alongside this doc under `notes/traces/player-perf-2026-04/`.

---

## Automated performance tests

PostHog telemetry catches regressions in production after deploy. Automated perf tests catch them in CI before merge. We need both.

### What exists today

The producer already has a perf gate pattern we can follow:

- **`producer/src/benchmark.ts`** — runs each test fixture multiple times, records per-stage timing, saves to `tests/perf/benchmark-results.json`.
- **`producer/src/perf-gate.ts`** — compares measured time against `tests/perf/baseline.json` (currently 90s max, 15% regression tolerance). Fails CI if exceeded.
- **`producer/src/parity-harness.ts`** — synchronous seek-per-frame rendering. Proves frame accuracy but doesn't exercise live-playback timing.

The player has no perf tests of any kind.

### Proposed test suite

All tests run in headless Chromium via Playwright (already a dev dependency for studio E2E). Each test loads a composition in a `<hyperframes-player>` element, exercises a specific operation, and asserts timing against a baseline.

#### Test 1: Playback frame rate (`player-perf-fps`)

```
Load 10-video composition → play for 5 seconds → collect rAF tick count + dropped frames
Assert: fps >= 55 (allow 8% drop from 60), dropped frames < 3
```

**What it catches:** rAF clock regressions, per-tick work bloat, media sync overhead.

Runs in both `isolated` (iframe) and `inline` (shadow DOM, Phase 4+) modes.

#### Test 2: Scrub latency (`player-perf-scrub`)

```
Load composition → seek to 10 positions in sequence → measure time from seek() call to state update callback
Assert: p95 < 80ms (isolated), p95 < 33ms (inline, Phase 4+)
```

**What it catches:** Bridge latency regressions, seek path overhead, state posting delays.

#### Test 3: Composition load time (`player-perf-load`)

```
Set player src to 5 different compositions in sequence → measure per-composition load → ready time
Assert: p95 < 2000ms cold, p95 < 1000ms warm (with srcdoc, Phase 3+)
```

**What it catches:** Runtime bootstrap regressions, iframe pool issues, srcdoc path regressions.

#### Test 4: Media sync drift (`player-perf-drift`)

```
Load 5-video composition → play for 10 seconds → on each RVFC callback, record drift between expected and actual media time
Assert: max drift < 500ms, p95 drift < 100ms
```

**What it catches:** RVFC fallback regressions, drift correction threshold issues, clock/media desync.

#### Test 5: Live-playback parity (`player-perf-live-parity`)

This is the test missing from the producer harness. It exercises the **live clock path** (rAF/interval), not the synchronous seek-per-frame path:

```
Load composition → play from start to end (10s) → compare final frame against producer's reference screenshot
Assert: SSIM > 0.95 (structural similarity), A/V drift < 50ms at end
```

**What it catches:** Any divergence between the live-playback clock and the producer's deterministic clock. This is the Phase 2 safety net.

### Test fixtures

Create `player/tests/perf/fixtures/` with 3 representative compositions:

| Fixture | Content | Purpose |
|---------|---------|---------|
| `10-video-grid` | 10 overlapping video clips, GSAP stagger | Stress test for decoder count, media sync, fps |
| `gsap-heavy` | 50+ animated elements, timeline with 200 tweens, no media | Stress test for GSAP seek performance |
| `sub-compositions` | 3 nested sub-compositions with their own timelines | Stress test for `firstTickOfClip` resync, MutationObserver |

### Baselines

Follow the producer's pattern: store baselines in `player/tests/perf/baseline.json`:

```json
{
  "fps_min": 55,
  "scrub_latency_p95_isolated_ms": 80,
  "scrub_latency_p95_inline_ms": 33,
  "comp_load_cold_p95_ms": 2000,
  "comp_load_warm_p95_ms": 1000,
  "drift_max_ms": 500,
  "drift_p95_ms": 100,
  "allowed_regression_ratio": 0.10
}
```

The perf gate script compares each measured value against `baseline * (1 + allowed_regression_ratio)`. Update baselines after each phase lands (Phase 0 establishes the first set, each subsequent phase tightens them).

### CI integration

Add a `player:perf` script to the root `package.json`:

```
bun run player:perf   # runs all 5 tests, outputs JSON, exits non-zero on regression
```

Run in CI on every PR that touches `packages/player/` or `packages/core/src/runtime/`. Not on every PR — Playwright + Chromium is ~30s overhead that shouldn't gate unrelated changes.

### When to update baselines

- **After Phase 0:** Initial baselines from measured current state.
- **After each phase lands:** Tighten baselines to the new measured values (the improvement becomes the new floor).
- **Never loosen baselines** without an explicit decision and comment in the baseline file explaining why.

### Implementation: PR P0-1 (revised)

PR P0-1 now covers both the live-playback parity test AND the full perf test suite:

1. `player/tests/perf/` — test runner, 5 test files, 3 fixtures, baseline.json
2. `player/tests/perf/perf-gate.ts` — baseline comparison (same pattern as `producer/src/perf-gate.ts`)
3. Root `package.json` — add `player:perf` script
4. CI config — gate on `packages/player/**` and `packages/core/src/runtime/**` changes

---

## Performance observability

### Current state

Two telemetry paths exist today, neither covers player performance:

1. **CLI telemetry** (`cli/src/telemetry/client.ts`) — lightweight PostHog client using the HTTP batch API directly (no SDK). Anonymous, opt-in, fire-and-forget. Tracks CLI command usage only. Uses PostHog project key `phc_zjjb…`.

2. **Runtime analytics bridge** (`core/src/runtime/analytics.ts`) — vendor-agnostic. The runtime emits structured events via postMessage (`{ source: "hf-preview", type: "analytics", event, properties }`). The host app listens and forwards to its own analytics provider. Today this covers 6 discrete events: `composition_loaded`, `composition_played`, `composition_paused`, `composition_seeked`, `composition_ended`, `element_picked`. No performance metrics.

3. **Player package** — no telemetry of any kind.

### What we need

Continuous performance metrics flowing to PostHog so we can:
- Verify each phase actually improved the target metric
- Detect regressions after deploy
- Compare performance across browser/OS/hardware segments
- Track inline mode adoption and its impact (Phase 4+)

### Architecture

Extend the existing runtime analytics bridge with a `performance` message type. The player (as the host) listens, aggregates per-session, and flushes to PostHog using the same lightweight HTTP batch pattern as the CLI — no PostHog SDK needed.

```
                    ┌─────────────────────────────────┐
                    │  iframe (core/runtime)           │
                    │                                  │
                    │  performance.mark("hf:seek:start")
                    │  performance.measure(...)        │
                    │  postMessage({ type: "perf" })  ─┼──┐
                    └─────────────────────────────────┘  │
                                                         │ postMessage
                    ┌─────────────────────────────────┐  │
                    │  player (host)                   │◄─┘
                    │                                  │
                    │  Aggregates per-session metrics  │
                    │  Flushes to PostHog on:          │
                    │    - composition_ended            │
                    │    - page unload (sendBeacon)     │
                    │    - 60s idle timeout             │
                    └──────────────┬──────────────────┘
                                   │ HTTP POST (batch API)
                    ┌──────────────▼──────────────────┐
                    │  PostHog (us.i.posthog.com)      │
                    │  Same project as CLI telemetry   │
                    └─────────────────────────────────┘
```

In inline mode (Phase 4), there's no iframe boundary — the runtime emits directly to the player's aggregator via the `RuntimeContext.bridge` callback.

### Metrics

| Metric | Event name | Collection point | When emitted | Phase |
|--------|-----------|-----------------|--------------|-------|
| Scrub latency | `player_scrub_latency` | Player: `mousedown` → first state update | End of each scrub gesture | 1+ |
| Playback fps | `player_playback_fps` | Runtime: rAF tick count / elapsed time | Every 5s during playback, and on pause/end | 2+ |
| Dropped frames | `player_dropped_frames` | Runtime: `video.webkitDroppedFrameCount` delta | On composition_ended | 2+ |
| Decoder count | `player_decoder_count` | Player: count of active `<video>` + `<audio>` elements | On promotion to parent-proxy | 1+ |
| Composition load time | `player_comp_load` | Player: iframe `load` → runtime `ready` | On each composition load | 1+ |
| Media sync drift | `player_sync_drift_max` | Runtime: max observed drift during session | On composition_ended | 2+ |
| Inline mode used | `player_inline_mode` | Player: boolean, which mode was selected | On composition load | 4a+ |
| `canRunInline` result | `player_inline_gate` | Player: pass/fail + failure reason | On composition load (inline-capable hosts only) | 4a+ |

### Properties on every event

```
{
  // anonymous session (no PII)
  distinct_id: <anonymous_session_id>,  // random UUID per browser session
  $ip: null,                            // tell PostHog to discard IP

  // context
  player_version: "0.4.12",
  player_mode: "isolated" | "inline",
  composition_id: <hash>,               // hashed, not raw
  media_count: 5,                        // number of timed media elements

  // environment
  browser: "Chrome 126",
  os: "macOS 15.1",
  viewport_width: 1920,
  screen_refresh_rate: 60,               // from screen.refreshRate if available
  device_memory: 8,                      // navigator.deviceMemory (Chrome only)
  hardware_concurrency: 8,               // navigator.hardwareConcurrency
}
```

No user IDs, no file paths, no composition content, no cookies. Same privacy posture as the CLI telemetry.

### Opt-in / opt-out

The player doesn't have its own opt-in flow today. Two approaches:

1. **Host-controlled:** The `<hyperframes-player>` element accepts a `telemetry` attribute. Default: `off`. Studio sets it to `on` (respecting the user's existing CLI telemetry preference if available). Public embeds stay off unless the host explicitly opts in.

2. **Respect `DO_NOT_TRACK`:** Check `navigator.doNotTrack === "1"` or `navigator.globalPrivacyControl === true`. If either is set, no metrics are collected regardless of the attribute.

### Before/after methodology

Each PR that targets a specific metric must:

1. **Tag the deploy.** PostHog events include `player_version`. Bump the patch version on each phase's final PR so we can filter by version range.

2. **Wait for sample size.** Don't declare victory on <1000 sessions. PostHog's trend graphs with version-based cohorts give us the before/after comparison without manual work.

3. **Segment by environment.** Studio vs. public embed, browser, device memory, media count. A 50% improvement on Chrome desktop that regresses Safari mobile is not a win.

4. **One phase at a time.** Don't overlap Phase 1 and Phase 2 deploys. Each phase gets at least 1 week of production data before the next ships. This is the only way to attribute improvements to specific changes.

### Regression alerting

PostHog doesn't have built-in metric alerting, but it supports webhooks on cohort changes. Set up:

1. **PostHog insight:** `player_playback_fps` p10 by `player_version`, 7-day rolling window.
2. **PostHog action:** trigger when p10 fps drops below 45 for any version cohort with >100 sessions.
3. **Webhook:** fire to the team's Slack channel.

Same pattern for `player_scrub_latency` p95 (alert if >150ms) and `player_dropped_frames` p90 (alert if >10).

### Dashboard

Create a PostHog dashboard: **"HyperFrames Player Performance"** with these panels:

| Panel | Visualization | Breakdown |
|-------|--------------|-----------|
| Scrub latency p50/p95 | Line chart, 7-day rolling | by `player_version` |
| Playback fps p10/p50 | Line chart, 7-day rolling | by `player_version` |
| Dropped frames p50/p90 | Line chart, 7-day rolling | by `browser` |
| Composition load time p50/p95 | Line chart, 7-day rolling | by `player_mode` |
| Decoder count distribution | Bar chart | by `media_count` bucket |
| Inline mode adoption | Stacked area | by `player_inline_gate` result |
| Session volume | Counter | total sessions this week |

### Implementation: PR X-1 scope (revised)

PR X-1 (`feat(core,player): player performance telemetry`) now covers:

1. **Runtime side** (`core/src/runtime/analytics.ts`): add `emitPerformanceMetric(name, value, tags)` that sends `{ source: "hf-preview", type: "perf", name, value, tags }` through the bridge. Uses `performance.mark`/`performance.measure` internally for DevTools visibility. No PostHog dependency in core.

2. **Player side** (`player/src/hyperframes-player.ts`): listen for `type: "perf"` messages. Aggregate per-session (hold metrics in memory, compute p50/p95 on flush). Flush to PostHog via `fetch` + `navigator.sendBeacon` fallback on page unload. Same HTTP batch API pattern as CLI. Gated on `telemetry` attribute + DNT check.

3. **Studio side**: set `telemetry="on"` on the preview player, respecting the user's existing telemetry preference.

No PostHog SDK. No new dependencies. ~150 LOC.

---

## Planned PRs

Each PR is independently reviewable and shippable. Dependencies are noted — don't merge out of order.

### Phase 0 — Measurement infrastructure

| PR | Title | Packages | Files | Depends on |
|----|-------|----------|-------|------------|
| **P0-1** | feat(player): automated perf test suite + live-playback parity test | `player`, root | `player/tests/perf/` (runner, 5 tests, 3 fixtures, baseline.json, perf-gate.ts), root `package.json` | — |
| **P0-2** | chore: Phase 0 trace results and baseline doc | `notes/` | `notes/traces/player-perf-2026-04/*.json`, update baseline.json with measured values, update this proposal with measured baselines | P0-1 |

P0-1 creates the perf test infrastructure: 5 Playwright-based tests (fps, scrub latency, composition load, media sync drift, live-playback parity), 3 representative fixtures, baseline comparison gate, and CI integration for `packages/player/` and `packages/core/src/runtime/` changes. P0-2 is the manual trace capture — Chrome Performance profile, decoder-count trace, compositor-layers dump, memory profile, RVFC browser matrix, composition corpus audit for `canRunInline()`. Documented as raw traces + a summary addendum to this proposal. Also populates the initial baseline.json with measured values.

### Phase 1 — Low-risk wins (4 independent PRs, can land in any order)

| PR | Title | Packages | Key files | Depends on |
|----|-------|----------|-----------|------------|
| **P1-1** | perf(player): share PLAYER_STYLES via adoptedStyleSheets | `player` | `player/src/hyperframes-player.ts`, `player/src/styles.ts` | — |
| **P1-2** | perf(player): scope MutationObserver to composition hosts | `player` | `player/src/hyperframes-player.ts` (~line 803) | — |
| **P1-3** | perf(player): audio-only proxy for video-source parent media | `player` | `player/src/hyperframes-player.ts` (`_createParentMedia` ~line 656) | P0-2 (gated on trace #2 results) |
| **P1-4** | perf(player): coalesce _mirrorParentMediaTime writes | `player` | `player/src/hyperframes-player.ts` (`_mirrorParentMediaTime` ~line 604) | — |

P1-1 and P1-2 are the safest — pure player-internal changes with no API surface. P1-3 only ships if the Phase 0 audio-only proxy validation passes on all 4 browser/OS targets. P1-4 changes sync behavior so it needs a manual A/V sync check.

### Phase 2 — Runtime clock + RVFC (1 PR — must ship together)

| PR | Title | Packages | Key files | Depends on |
|----|-------|----------|-----------|------------|
| **P2-1** | perf(core): replace setInterval with rAF + RVFC drift observation | `core` | `core/src/runtime/init.ts` (~line 1502), `core/src/runtime/media.ts` (~line 160) | P0-1 (live-playback test exists), P0-2 (baselines established) |

This is one PR because rAF without RVFC increases per-tick cost (3x more ticks with the same drift-polling work). The PR includes:
- rAF loop during `isPlaying` with `visibilitychange` fallback to 250ms interval
- `__HF_VIRTUAL_TIME__` guard for headless capture
- RVFC-driven drift observation for `<video>` elements, with per-tick fallback retained for `<audio>`, state transitions (pause, seek, clip activation), and non-RVFC browsers
- 250ms paused keep-alive interval

**CI gate:** Producer parity harness + new live-playback regression test must both pass.

### Phase 3 — Synchronous seek + fast switching (2-3 PRs)

| PR | Title | Packages | Key files | Depends on |
|----|-------|----------|-----------|------------|
| **P3-1** | feat(player): synchronous seek() API with same-origin detection | `player` | `player/src/hyperframes-player.ts` | — |
| **P3-2** | perf(player): srcdoc composition switching for studio | `player`, `studio` | `player/src/hyperframes-player.ts` (~line 146), studio composition-switch call sites | — |
| **P3-3** | perf(player): warm iframe pool with LRU eviction | `player` | `player/src/hyperframes-player.ts` (new pool manager) | P0-2 (memory profile validates cap) |

P3-1 formalizes studio's existing `__player` direct-access pattern as a public API. P3-2 adds `srcdoc` as an alternative to `src` for studio's case. P3-3 is optional — only ship if memory profiling confirms per-iframe cost allows a pool of 3. Thumbnail grids are explicitly excluded (use static screenshots instead).

### Phase 4a — Inline mode behind flag (5 PRs with dependency chain)

**Staffing:** PRs P4a-1 through P4a-3 are `core/` work (engineer A). PRs P4a-4 and P4a-5 are `player/`+`studio/` work (engineer B, can start after P4a-1 lands).

| PR | Title | Packages | Key files | Depends on |
|----|-------|----------|-----------|------------|
| **P4a-1** | refactor(core): RuntimeContext interface + scope injection | `core` | `core/src/runtime/init.ts`, `core/src/runtime/media.ts`, `core/src/runtime/state.ts`, `core/src/runtime/timeline.ts`, `core/src/runtime/entry.ts`, `core/src/runtime/bridge.ts`, `core/src/runtime/compositionLoader.ts` | — |
| **P4a-2** | refactor(core): adapter scoping + multi-instance __timelines | `core` | `core/src/runtime/adapters/gsap.ts`, `css.ts`, `waapi.ts`, `lottie.ts`, `three.ts` | P4a-1 |
| **P4a-3** | refactor(core): picker shadow-root scoping | `core` | `core/src/runtime/picker.ts` | P4a-1 |
| **P4a-4** | feat(core): canRunInline() validation gate + Shadow DOM CSS transforms | `core` | new `core/src/compiler/canRunInline.ts`, `core/src/compiler/htmlBundler.ts` (CSS transforms) | — |
| **P4a-5** | feat(player): inline player mode behind __HF_INLINE_PLAYER flag | `player`, `studio` | `player/src/hyperframes-player.ts`, studio preview panel hook | P4a-1, P4a-2, P4a-3, P4a-4 |

**P4a-1** is the biggest PR (~300-400 LOC). It introduces `RuntimeContext` with `root` (Document or ShadowRoot), `globals` (context object replacing window properties), and `bridge` (callback replacing postMessage). All `document.*` queries and `window.*` globals are parameterized. The default context is `{ root: document, globals: window, bridge: postMessage }` so the iframe path is unchanged.

**P4a-2** scopes all 5 adapters to use `RuntimeContext` and moves `__timelines` from `window` into the per-instance context. This fixes the multi-instance collision where the same composition in two panels would overwrite each other's timeline.

**P4a-3** is the picker refactor — `elementsFromPoint` on ShadowRoot, event capture scoped to the composition root, style injection into the shadow root instead of `document.head`.

**P4a-4** is independent of the runtime refactor. It adds the `canRunInline()` denylist gate (linkedom HTML parse + regex script scan + CDN allowlist + `on*` attribute check) and the Shadow DOM CSS transforms (`@font-face` hoisting, `vh`/`vw` → container units, `:root` → `:host` selector rewriting).

**P4a-5** wires everything together: the player's `mode="inline"` attribute, template-based composition mounting into shadow DOM, RuntimeContext instantiation with shadow root, and studio's preview panel opt-in behind the feature flag.

### Phase 4b — Inline mode as default (2 PRs)

| PR | Title | Packages | Key files | Depends on |
|----|-------|----------|-----------|------------|
| **P4b-1** | feat(player): inline mode default for studio + studio migration | `player`, `studio` | `player/src/hyperframes-player.ts`, all studio player call sites | P4a-5 |
| **P4b-2** | feat(player): public API stabilization (mode="inline\|isolated") | `player` | `player/src/hyperframes-player.ts`, docs | P4b-1 |

P4b-1 removes the feature flag and makes inline the default for studio. Migrates all studio call sites (preview, scene editor, export preview). Thumbnails stay iframe-based. P4b-2 stabilizes the public API surface and documents the mode attribute for external consumers.

### Cross-cutting (ships alongside Phase 1+)

| PR | Title | Packages | Key files | Depends on |
|----|-------|----------|-----------|------------|
| **X-1** | feat(core): emitPerformanceMetric bridge for post-land instrumentation | `core` | `core/src/runtime/analytics.ts`, `core/src/runtime/bridge.ts` | — |

The existing `RuntimeAnalyticsEvent` union type covers discrete events (composition_loaded, composition_played, etc.). Performance counters (scrub latency, dropped frames, decoder count, load time) don't fit that shape. X-1 adds `emitPerformanceMetric(name, value, tags)` using `performance.mark`/`performance.measure` for client-side collection, with a bridge message for cross-frame reporting. Ship early so each phase can instrument its improvements.

### PR summary

| Phase | PRs | Total | Parallel tracks |
|-------|-----|-------|-----------------|
| 0 | P0-1, P0-2 | 2 | 1 |
| 1 | P1-1, P1-2, P1-3, P1-4 | 4 | all independent |
| 2 | P2-1 | 1 | 1 |
| 3 | P3-1, P3-2, P3-3 | 3 | all independent |
| 4a | P4a-1 → P4a-2, P4a-3 → P4a-5; P4a-4 independent | 5 | 2 (core + player/gate) |
| 4b | P4b-1 → P4b-2 | 2 | 1 |
| Cross-cutting | X-1 | 1 | independent |
| **Total** | | **18** | |

---

## References

- [requestVideoFrameCallback — MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
- [Perform efficient per-video-frame operations — web.dev](https://web.dev/articles/requestvideoframecallback-rvfc)
- [Shadow DOM vs. iframes — HackerNoon](https://hackernoon.com/shadow-dom-vs-iframes-which-one-actually-works)
- [adoptedStyleSheets — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document/adoptedStyleSheets)
- [Page Visibility API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- [ShadowRoot.elementsFromPoint — MDN](https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot/elementsFromPoint)
