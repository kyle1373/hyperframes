# HDR Follow-ups — Work Plan

Source: [Hyperframes HDR follow-ups](https://www.notion.so/347449792c6980ae8ac6f93b9ddd4610)

Organized into chunks that can be branched, tested, and merged independently.
Items are prioritized: critical bugs first, then correctness, then hardening, then cleanup.

---

## Chunk 0: Comprehensive HDR Regression Test

**Why first:** The existing HDR tests (`hdr-pq` and `hdr-image-only`) are trivial — a single full-bleed video or image with a static text label. They don't exercise any of the features that the HDR pipeline must explicitly handle differently from SDR: opacity animation, z-ordered multi-layer compositing, transforms, border-radius clipping, shader transitions, multiple HDR sources, object-fit modes, or mixed HDR+SDR layering. Every subsequent chunk in this plan needs a regression test that can prove the fix works *and* that nothing else broke. This chunk builds that test.

### What the current tests cover

| Test | Elements | Animations | Layers | Transitions |
|------|----------|-----------|--------|-------------|
| `hdr-pq` | 1 HDR video + 1 static label | None | 1 HDR + 1 DOM | None |
| `hdr-image-only` | 1 HDR PNG + 1 static label | None | 1 HDR + 1 DOM | None |

### What the HDR pipeline must support (complete feature inventory)

Found by auditing `renderOrchestrator.ts`, `videoFrameInjector.ts`, `layerCompositor.ts`, `alphaBlit.ts`, `shaderTransitions.ts`, `streamingEncoder.ts`, `hdrCapture.ts`, and `hyper-shader.ts`:

| # | Feature | HDR-specific behavior | Current coverage |
|---|---------|----------------------|-----------------|
| 1 | **Wrapper-opacity animation** | `getEffectiveOpacity()` walks ancestors, multiplies opacity chain. HDR path must read this and apply during compositing (Chrome can't do it — video is extracted separately). | None |
| 2 | **Direct-on-element opacity animation** | GSAP tween on `<video>` itself. HDR path skips element's own opacity because engine forces `opacity: 0 !important` to hide it. Known bug (Chunk 1A). | None |
| 3 | **Z-ordered multi-layer compositing** | `groupIntoLayers()` interleaves DOM and HDR layers by z-index. DOM layers get masked screenshots; HDR layers get native-pixel compositing. Adjacent DOM layers merge. | Trivial (1 HDR behind 1 DOM) |
| 4 | **DOM behind HDR behind DOM** ("sandwich") | Requires at least 3 layers: DOM(z:1) → HDR(z:5) → DOM(z:10). Tests that masking correctly shows/hides elements per layer. | None |
| 5 | **Multiple HDR video sources** | Fixed in PR #289 (was single-HDR-only in #288). No regression pins the fix. Two HDR videos composited in same frame. | None |
| 6 | **Mixed HDR video + HDR image** | Both `isHdr` in the stacking query. Different extraction paths (FFmpeg frames vs PNG decode). Same compositing path. | None (separate tests) |
| 7 | **CSS transforms (rotate, scale, translate)** | `el.transform` computed by `queryElementStacking()` / `getViewportMatrix()`. Must be applied via `blitRgb48leAffine()`. Currently dead — compositing only uses scale+translate (Chunk 4A). | None |
| 8 | **GSAP `force3D: true` (matrix3d)** | GSAP's default. `parseTransformMatrix()` only handles `matrix()`, returns null for `matrix3d()` (Chunk 4B). | None |
| 9 | **Border-radius clipping** | `el.borderRadius` computed from nearest `overflow:hidden` ancestor. Must be applied as pixel mask during HDR compositing. Currently dead (Chunk 4A). | None |
| 10 | **Shader transitions (15 effects)** | Operate on rgb48le buffers in PQ/HLG signal space. `hdrToLinear` → shader → `linearToHdr`. Cross-scene compositing uses both scene A and scene B HDR captures. | None (unit tests only) |
| 11 | **`object-fit` modes** | `resampleRgb48leObjectFit()` handles cover/contain/fill/none/scale-down. `ElementStackingInfo.objectFit` + `objectPosition` passed through. | None (`cover` only, implicitly) |
| 12 | **sRGB-to-BT.2020 conversion** | DOM screenshots are sRGB. HDR compositor converts via `srgbToHdr16()` matrix before blitting over HDR content. Incorrect conversion = color shift on text/graphics. | Implicit only (label color not validated) |
| 13 | **PQ transfer function** | SMPTE ST 2084. 65536-entry LUT. PQ OETF/EOTF constants (M1, M2, C1, C2, C3). | Implicit (hdr-pq test) |
| 14 | **HLG transfer function** | ARIB STD-B67. Separate LUT. HLG OETF coefficients. Entirely different code path from PQ. | **None — zero coverage** |
| 15 | **Cross-transfer conversion (HLG↔PQ)** | `convertTransfer()` for mixed-source compositions. HLG OOTF with Lw=1000, gamma=1.2. | **None** |
| 16 | **HDR10 mastering metadata** | `mdcv` box (G,B,R primary order per ISO 23001-8), `stco`/`co64` offset shifting, `max-cll`/`max-fall`. | Implicit (metadata not validated by harness) |
| 17 | **Captions over HDR content** | DOM text at high z-index over HDR layers. sRGB caption → BT.2020 conversion must preserve legibility. | Trivial (static label only) |
| 18 | **Audio sync with HDR** | Both current tests set `minAudioCorrelation: 0` — audio sync is **not enforced**. HDR path could drop/reorder audio silently. | **Not enforced** |
| 19 | **`layoutWidth`/`layoutHeight` for extraction** | Untransformed dims for FFmpeg extraction sizing. Currently unused — extraction uses `el.width`/`el.height` from getBoundingClientRect (Chunk 4C). | None |
| 20 | **Scene initial-state** | Non-first scenes should start at `opacity: 0`. If not, all scenes composite simultaneously at t=0 (Chunk 4D). | None |

### Design: time-sequenced test card

The regression harness samples 100 PSNR checkpoints evenly across the video. By giving each feature its own **time window**, a regression at a specific checkpoint immediately identifies which feature broke — no per-zone PSNR support needed.

Two compositions required: PQ and HLG use entirely separate code paths (different LUTs, different OETF/EOTF, different FFmpeg tagging). They cannot share a single composition. The fixture layout is identical; only the source assets and transfer function differ.

**Composition: `hdr-regression` (PQ variant, ~20s, 1920x1080)**

| Window | Time | Feature exercised | Elements |
|--------|------|-------------------|----------|
| A | 0.0–2.0s | Static baseline — HDR video + DOM overlay | Full-bleed HDR video, white text label at z:10. Sanity check: if this fails, everything else is meaningless. |
| B | 2.0–4.5s | Wrapper-opacity fade | HDR video inside a `<div>` wrapper. GSAP tweens wrapper from `opacity: 1` → `0.15` → `1`. Tests `getEffectiveOpacity()` ancestor walk. |
| C | 4.5–7.0s | Direct-on-element opacity | GSAP tweens `opacity` directly on `<video>` element. Same tween as (B). **Expected to fail until Chunk 1A lands** — proves the bug exists. |
| D | 7.0–9.5s | Z-order sandwich: DOM → HDR → DOM | Three layers: colored rect at z:1 (DOM), HDR video at z:5, semi-transparent overlay at z:10 (DOM). Tests `groupIntoLayers()` with interleaved types. |
| E | 9.5–12.0s | Multiple HDR sources | Two HDR videos side-by-side (left half, right half) at different z-indices with a DOM label between them. Pins the PR #289 multi-video fix. |
| F | 12.0–14.5s | Transform + border-radius | HDR video with `rotation: 15deg`, `scale: 0.8` via GSAP. Container has `border-radius: 24px; overflow: hidden`. **Expected to fail until Chunk 4 lands.** |
| G | 14.5–17.0s | Object-fit: contain | HDR video in a container that doesn't match its aspect ratio. `object-fit: contain` should produce letterboxing, not stretching. |
| H | 17.0–20.0s | Shader transition (crossfade) | Two-scene composition with `crossfade` transition at t=18.5s. Tests signal-space blending of HDR pixels. Scene A = HDR video, Scene B = HDR image. |

**Composition: `hdr-hlg-regression` (HLG variant, ~5s, 1920x1080)**

Shorter composition — HLG exercises the separate LUT/OETF code path, not a different compositing pipeline.

| Window | Time | Feature exercised | Elements |
|--------|------|-------------------|----------|
| A | 0.0–2.5s | HLG video + DOM overlay | Full-bleed HLG video with text label. Validates HLG OETF, `arib-std-b67` encoder tagging. |
| B | 2.5–5.0s | HLG opacity animation | Wrapper-opacity fade on HLG video. Validates HLG-specific LUT used during compositing. |

### Assets needed

| Asset | Format | Source | Notes |
|-------|--------|--------|-------|
| `hdr-bars-pq.mp4` | HEVC Main10, BT.2020 PQ | Synthesized via FFmpeg SMPTE bars / color ramp | Deterministic, OSS-safe. Replaces third-party `hdr-clip.mp4` (also addresses Chunk 11A). |
| `hdr-bars-hlg.mp4` | HEVC Main10, BT.2020 HLG | Synthesized via FFmpeg | Same pattern, HLG transfer. |
| `hdr-photo-pq.png` | 16-bit RGB, BT.2020 PQ, cICP tagged | Synthesized via FFmpeg + ImageMagick | Gradient with known reference values for color accuracy checks. Can reuse or replace existing `hdr-photo.png`. |

Synthesized assets solve fixture provenance (Chunk 11A) simultaneously.

### Known-failing windows

Some windows will fail against their golden snapshot until the corresponding chunk lands. This is intentional — the test documents the bug.

| Window | Fails because | Fixed by |
|--------|--------------|----------|
| C (direct opacity) | HDR path ignores direct-on-element opacity | Chunk 1 |
| F (transforms) | Transform/border-radius data not wired into compositing | Chunk 4 |

Use `maxFrameFailures` to accommodate these known failures. As chunks land, regenerate the golden and tighten the threshold. Alternatively, we can use GSAP-conditional guards to make known-broken windows produce a deterministic fallback (e.g. skip the animation) until the fix lands — this keeps `maxFrameFailures: 0` but weakens the "proves the bug" property.

### Replaces

- `hdr-pq` — functionality covered by window A
- `hdr-image-only` — functionality covered by window H (scene B uses an HDR image) plus can add a dedicated image-only window if needed

Both old tests are removed. CI shard updated to run `hdr-regression hdr-hlg-regression` instead.

### Gaps NOT covered by this regression test (out of scope)

These need separate unit/integration tests (addressed in Chunk 9):

- `hdrEncoder` error/cleanup path (unit test, Chunk 5A)
- `frameDirMaxIndexCache` cross-job isolation (unit test, Chunk 5B)
- Abort mid-transition (integration test, Chunk 5C)
- `ffprobe` unavailable fallback (unit test, Chunk 9B)
- `chunkEncoder` HDR metadata (separate encoder path, Chunk 3)
- Cross-transfer conversion HLG↔PQ in a single composition (would need a mixed-source fixture — consider as a follow-up)
- HDR10 mastering metadata validation (ffprobe post-render check, can be added to the harness)
- Audio sync enforcement (requires setting `minAudioCorrelation` > 0 on a composition with audio)

### Deliverables

1. `packages/producer/tests/hdr-regression/` — composition, meta.json, synthesized assets, golden snapshot
2. `packages/producer/tests/hdr-hlg-regression/` — HLG variant
3. Remove `packages/producer/tests/hdr-pq/` and `packages/producer/tests/hdr-image-only/`
4. Update CI workflow shard from `hdr-pq hdr-image-only` to `hdr-regression hdr-hlg-regression`
5. FFmpeg asset synthesis scripts (checked into `scripts/` or documented in README)

---

## Chunk 1: Opacity Pipeline Bugs

**Why first:** Two live correctness bugs produce wrong pixels. The HDR direct-on-video opacity bug is the most user-visible issue in the entire list.

| # | Item | File(s) | Source |
|---|------|---------|--------|
| A | HDR compositor ignores direct-on-video opacity animation | `videoFrameInjector.ts:437-439` | Standalone bug report |
| B | `queryVideoElementBounds` opacity fallback: `parseFloat("0") \|\| 1` treats opacity:0 as opacity:1 | `videoFrameInjector.ts:~202` | PR #288 I4 (unfixed residual) |
| C | `as HTMLElement` cast — use `instanceof` guard instead | `videoFrameInjector.ts:309` | PR #290 I1 |
| D | Opacity walk starts from parent — fragile ordering coupling with `hideVideoElements` | `videoFrameInjector.ts:426-428` | PR #290 M1 |

**Approach for (A):** The doc suggests three fix options. Option 3 (use `visibility: hidden` instead of `opacity: 0 !important`) is cleanest — needs verification that native `<video>` won't leak through. Option 1 (read opacity before engine forces it to 0) is the safe fallback.

**How to verify:**
- Render a composition with GSAP animating `opacity` directly on a `<video>` element (no wrapper)
- Compare SDR and HDR output at a mid-tween frame (e.g. t=3.5s, expected opacity ~0.15)
- Both paths should produce visibly dim video — not full brightness
- Regression: existing compositions with wrapper-based opacity animation must still work

---

## Chunk 2: Transition Duration Defaults

**Why:** Causes a visible ~0.3s brightness dropout on any transition without explicit `duration`. Preview and render also produce different blending curves due to ease mismatch.

| # | Item | File(s) | Source |
|---|------|---------|--------|
| A | Duration default mismatch: `1.0` in meta write, `0.7` in browser/engine mode | `hyper-shader.ts:130, 238, 361` | PR #268 C1 |
| B | Ease mismatch: `"none"` in meta vs `"power2.inOut"` in browser | Same file | PR #268 C1 |

**Fix:** Extract `DEFAULT_DURATION = 0.7` and `DEFAULT_EASE = "power2.inOut"` as shared constants. Use in all three sites.

**How to verify:**
- Render a composition with a transition that omits `duration` and `ease`
- No brightness dip in the last ~0.3s of the transition
- Preview (browser mode) and render (engine mode) produce matching blending curves
- Render with explicit `duration: 1.5` still works (not overridden by default)

---

## Chunk 3: chunkEncoder HDR — Live Bug

**Why:** Disk-based HDR encodes silently produce BT.709-tagged output. The streaming encoder is correct but chunkEncoder never reads `options.hdr`.

| # | Item | File(s) | Source |
|---|------|---------|--------|
| A | `buildEncoderArgs` hard-codes BT.709 color params, ignores `options.hdr` | `chunkEncoder.ts` | PR #265 I1 |
| B | `convertSdrToHdr` docstring says "zscale with 600 nit peak" but code uses FFmpeg colorspace filter; output hard-coded to HLG | `videoFrameExtractor.ts` | PR #265 I3 |
| C | HDR config type: `{ transfer: ... } | false` but IIFE returns `undefined` | `config.ts` | PR #265 I4 |

**How to verify:**
- Render an HDR composition using the chunk encoder path
- `ffprobe` the output: should show `bt2020nc` color matrix, `smpte2084` transfer, mastering display metadata
- Compare against streaming encoder output — metadata should match

---

## Chunk 4: Transform & Clipping Pipeline

**Why:** Transform extraction and border-radius computation exist but are dead — an HDR video with `rotation: 45` renders un-rotated, `border-radius: 50%` renders with sharp corners.

| # | Item | File(s) | Source |
|---|------|---------|--------|
| A | Wire `el.transform`, `el.borderRadius`, `el.layoutWidth`/`layoutHeight` into compositing loop | `renderOrchestrator.ts` | PR #290 C1 |
| B | `parseTransformMatrix` returns null for `matrix3d` (GSAP `force3D: true` default) | `alphaBlit.ts:634-643`, `videoFrameInjector.ts:370-407` | PR #290 I2 |
| C | HDR extraction dims use `el.width`/`el.height` (transform-affected) instead of `el.layoutWidth`/`layoutHeight` | `renderOrchestrator.ts:~996-1008` | PR #290 M3 |
| D | Scene initial-state: all non-first scenes should start at `opacity: 0` | `hyper-shader.ts:355-369` | PR #290 I3 |

**How to verify:**
- Render a composition with a rotated HDR video (`rotation: 45`) — should appear rotated
- Render a composition with `border-radius: 50%` on an HDR video container — should clip to circle
- Render a 3-scene composition — no overlapping at t=0
- `blitRgb48leAffine` should receive the full affine matrix, not just scale+translate

---

## Chunk 5: Resource Management & Resilience

**Why:** Leaked processes, unbounded memory growth, and missing abort checks. Each is independently fixable and testable.

| # | Item | File(s) | Source |
|---|------|---------|--------|
| A | `hdrEncoder.close()` not called on non-abort errors (orphaned FFmpeg) | `renderOrchestrator.ts` | PR #268 I1 |
| B | Module-scoped `frameDirMaxIndexCache` grows monotonically, never cleared | `renderOrchestrator.ts:~128` | PR #268 I2 |
| C | No abort signal between scene A and scene B compositing | `renderOrchestrator.ts:~1500` | PR #290 I4 |
| D | Per-frame `Buffer.alloc(width * height * 6)` — ~37 MB at 1080p, ~11 GB GC pressure for 10s/30fps | `renderOrchestrator.ts:~1082` | PR #290 M2 |
| E | File server lacks `isPathInside()` guard — relative path segments can escape project dir | `fileServer.ts` | PR #288 M1 (unfixed across stack) |

**How to verify:**
- (A) Kill a render mid-flight with a non-abort error; confirm no orphaned `ffmpeg` processes
- (B) Run two render jobs back-to-back; confirm cache is cleared between jobs
- (C) Abort during a transition frame; confirm it stops promptly (not after scene B capture completes)
- (D) Memory profiling: heap snapshots during a 10s render should show flat buffer allocation
- (E) Attempt `GET /../../../etc/passwd` against the local file server; should 403/404

---

## Chunk 6: Non-null Assertions & Type Safety

**Why:** Violates project policy. Straightforward mechanical fixes — good chunk for a single PR.

| # | Item | File(s) | Source |
|---|------|---------|--------|
| A | ~12 `!` assertions on M709_TO_2020 matrix rows | `alphaBlit.ts` | PR hdr-image-support C2 |
| B | `stack.pop()!` | `mp4HdrBoxes.ts:504` | PR hdr-image-support C2 |
| C | `layers[layerIdx]!` | `renderOrchestrator.ts` | PR #268 C2 |
| D | Duplicate `HfTransitionMeta` interface (rebase artifact) | `types.ts` (lines 42 and 68) | PR #268 I1 |
| E | Locally-redeclared `HfTransitionMeta` in browser shim (add sync comment) | `hyper-shader.ts:116-123` | PR #268 I2 |
| F | Dead code: `buildSrgbToHdrLut` / `getSrgbToHdrLut` if no external callers | `alphaBlit.ts` | PR hdr-image-support I4 |

**How to verify:**
- `grep -r '!\.' packages/engine/src packages/producer/src` — no new non-null assertions
- TypeScript compiles clean
- Existing tests pass unchanged

---

## Chunk 7: Refactoring — Compositing Helpers

**Why:** Reduces complexity and duplication in the render orchestrator. Do after correctness fixes so the refactored code is already correct.

| # | Item | File(s) | Source |
|---|------|---------|--------|
| A | Extract HDR compositing closure into top-level `compositeHdrFrame` helper | `renderOrchestrator.ts` | Deferred #1 |
| B | Factor `skipReadinessVideoIds` capture-option spread into `buildHdrCaptureOptions()` | Multiple files | Deferred #9 |
| C | Rename `extractVideoMetadata()` to `extractMediaMetadata()` (handles PNG too) | Engine utils | Deferred #8 |
| D | Hoist `countNonZeroAlpha`/`countNonZeroRgb48` debug helpers to module scope | `renderOrchestrator.ts` | PR #268 M1 |

**How to verify:**
- All existing tests pass without modification (pure refactor)
- No behavioral changes — diff should be structural only
- New `compositeHdrFrame` helper has explicit typed context object

---

## Chunk 8: Performance

**Why:** Potential perf regression from the layered HDR path. Measure first, then optimize.

| # | Item | File(s) | Source | Status |
|---|------|---------|--------|--------|
| A | Benchmark HDR-PQ wall-clock + peak heap/RSS, `--tags` filter, `bench:hdr` script | `benchmark.ts`, `renderOrchestrator.ts`, `tests/perf/README.md` | Deferred #2 | **Done** (PR `vance/hdr-benchmark-harness`) |
| B | Cache per-image transfer-converted HDR buffers per `(imageId, targetTransfer)` | Engine HDR path | Deferred #3 | **Done** (PR `vance/hdr-image-transfer-cache`) |
| C | Debug logging does JSON serialization every 30 frames regardless of log level | `renderOrchestrator.ts`, `logger.ts` | PR #289 M4 | **Done** (PR `vance/logger-level-gating`) |
| D | Diagnostic `countNonZeroAlpha`/`countNonZeroRgb48` iterate all pixels every frame (gated by KEEP_TEMP but check evaluates always) | Engine hot path | PR hdr-image-support M2 | **Already gated** — calls live behind `shouldLog = debugDumpEnabled && debugFrameIndex >= 0`, where `debugDumpEnabled` is itself driven by `KEEP_TEMP=1`, so the pixel iteration is fully skipped on production runs. No code change required; verified during 8C work. |

**Ordering:** Do (A) first to establish a baseline. Then (B)-(D) as optimizations. Re-measure after.

**8C resolution:** Added optional `isLevelEnabled(level)` to `ProducerLogger` and a `createConsoleLogger` implementation. The hot-loop call site in `renderOrchestrator.ts` (per-frame HDR composite snapshot every 30 frames) is now gated by `i % 30 === 0 && (log.isLevelEnabled?.("debug") ?? true)`, so the meta-object construction (`Array.find`, `toFixed`, conditional struct) is fully skipped at `level=info`. The `?? true` fallback preserves prior behavior for custom logger implementations that don't define the method. Covered by `packages/producer/src/logger.test.ts` (17 tests including a hot-loop call-site simulation that asserts zero builder invocations at info level).

**8B resolution:** Added `packages/producer/src/services/hdrImageTransferCache.ts` — a per-render-job bounded LRU keyed by `(imageId, targetTransfer)` that owns the converted HDR rgb48 buffer for static HDR image layers. Same-transfer requests return the source buffer untouched; cross-transfer requests pay one `Buffer.from` + `convertTransfer` on first miss and reuse the cached copy on every subsequent frame instead of re-converting per composite. Wired into `renderOrchestrator.ts` via `HdrCompositeContext.hdrImageTransferCache`, instantiated once per render job and consumed by `blitHdrImageLayer` for both the main composite path and the transition path. Covered by `packages/producer/src/services/hdrImageTransferCache.test.ts` (12 tests: hit/miss, distinct keys per image and per target transfer, LRU eviction + promotion, `maxEntries=0` passthrough, source-buffer immutability for cached entries, invalid options).

**How to verify:**
- Wall-clock timing on `hdr-pq` fixture: before vs after, at least 3 runs each
- Image cache hit rate logged (should be 100% for static images after first frame)
- No JSON.stringify calls in hot path unless log level is debug

---

## Chunk 9: Test Coverage

**Why:** Gaps identified across multiple PR reviews. Can be done in parallel with other chunks.

| # | Item | File(s) | Source | Status |
|---|------|---------|--------|--------|
| A | ~~Restore mixed SDR/HDR and HDR+captions regression fixtures/tests~~ | ~~Test fixtures~~ | ~~Deferred #5~~ | **Absorbed by Chunk 0** (windows D, E, H) |
| B | Add explicit ffprobe-unavailable fallback test (mock missing ffprobe) | Unit test | Deferred #10 | Open |
| C | ~~CI-wired integration test for the full HDR composite pipeline~~ | ~~Integration test~~ | ~~PR hdr-image-support test gaps~~ | **Absorbed by Chunk 0** |
| D | Test `hdrEncoder` error/cleanup path | Unit test | PR hdr-image-support test gaps | Open |
| E | Test `frameDirMaxIndexCache` cross-job isolation | Unit test | PR hdr-image-support test gaps | Open |
| F | alphaBlit: add known sRGB-to-BT.2020 reference values for matrix path | `alphaBlit.test.ts` | PR hdr-image-support test gaps | Open |
| G | Shader smoke tests at p=0.5 (midpoint regressions) | `shaderTransitions.test.ts` | PR #268 M2 | Open |

**How to verify:**
- `bun run test` — all new tests pass
- Coverage report shows the previously-uncovered branches are now hit

---

## Chunk 10: CLI — Restore Removed Flags

**Why:** Breaking change for existing users. Needs user-facing communication.

| # | Item | File(s) | Source |
|---|------|---------|--------|
| A | Restore `--crf` and `--video-bitrate` CLI flags alongside `--hdr` (or add deprecation) | `packages/cli/src/commands/render.ts` | PR #268 I3, PR hdr-image-support I3 |

**How to verify:**
- `hyperframes render --crf 18 ...` works (or prints deprecation warning)
- `hyperframes render --hdr ...` still works
- `hyperframes render --help` shows all flags

---

## Chunk 11: OSS & CI Hygiene

**Why:** Fixture provenance, CI stability, repo bloat prevention. Independent of code correctness.

| # | Item | File(s) | Source | Status |
|---|------|---------|--------|--------|
| A | ~~Replace third-party `hdr-pq` fixture with synthesized HDR source (FFmpeg test patterns)~~ | ~~Test fixtures~~ | ~~Deferred #4~~ | **Absorbed by Chunk 0** (synthesized assets) |
| B | ~~Relax HDR fixture `maxFrameFailures` from 0 to 2~~ | ~~Test config~~ | ~~Deferred #7~~ | **Absorbed by Chunk 0** (accommodates known-failing windows) |
| C | Add `tests/*/src/*.png` to LFS tracking in `.gitattributes` | `.gitattributes` | Deferred #11 | Open |

**How to verify:**
- (C) `git lfs ls-files` includes HDR PNG fixtures after commit

---

## Chunk 12: Investigation — `__name` Polyfill

**Why:** Investigation item — outcome determines whether there's a code change or just a polyfill removal.

| # | Item | File(s) | Source |
|---|------|---------|--------|
| A | Investigate the bundler/runtime boundary causing the `__name` issue; remove polyfill if fixable | Runtime | Deferred #6 |

**How to verify:**
- If root cause found: polyfill removed, `bun run test` passes, `bun run build` clean
- If root cause is upstream: document why polyfill is necessary, add a test that detects if the upstream fix lands

**Status: Done — keeping polyfill, documented + regression-tested.**

Empirical findings (probe in `/tmp/hf-name-probe`):

| Runtime / build | Injects `__name(fn, "name")` wrappers in `Function.prototype.toString()`? |
|-----------------|---------------------------------------------------------------------------|
| `bun` (TS loader) | No — verified for top-level and nested named functions / arrow expressions. |
| `tsx` (esbuild loader, `keepNames=true`) | Yes for nested named functions / arrows; observed crash mode in dev/test. |
| `tsc` (`noEmit` and emit) | No — does not inject the helper. |
| `tsup` for `@hyperframes/cli` (`noExternal: ["@hyperframes/engine"]`) | Polyfill *definition* is bundled, but `__name(...)` *call sites* are absent in `packages/cli/dist/cli.js` (grepped). |

Root cause: `@hyperframes/engine`'s `package.json` exports raw TypeScript (`main`/`exports` → `./src/index.ts`), so every consumer's transpiler decides whether to inject `__name`. Anything that runs through `tsx` (producer parity-harness, ad-hoc dev scripts, `bun run --filter @hyperframes/engine test` via Vitest's loader) will serialize wrapped function bodies into `page.evaluate(...)` and crash with `ReferenceError: __name is not defined`.

Decision: keep the no-op `window.__name` shim in `frameCapture.ts`. Cost is one `evaluateOnNewDocument` call; alternative (rewriting every `page.evaluate(fn)` site to `page.addScriptTag({ content: "..." })` like `packages/cli/src/commands/contrast-audit.browser.js`) is far more invasive and easy to regress.

What landed:
- Expanded the inline comment in `packages/engine/src/services/frameCapture.ts` to explain the per-runtime matrix above and point to the script-tag alternative.
- Added `packages/engine/src/services/frameCapture-namePolyfill.test.ts` — a pure unit-test (matches the rest of the engine package's convention, no browser launch) that:
  1. Asserts the polyfill is wired up via `evaluateOnNewDocument` and runs before the first awaited `browser.version()` call.
  2. Probes the active Vitest transpiler for `__name(...)` injection so the next maintainer can see at a glance whether the upstream behavior has shifted.

Verification:
- `bun run --filter @hyperframes/engine test` → 408/408 pass (3 new tests in this file).
- `bunx tsc --noEmit -p packages/engine` clean.
- `bunx oxlint` and `bunx oxfmt --check` clean on edited files.

---

## Suggested Merge Order

```
Chunk 0  (regression test)     — FIRST. Establishes the safety net. Known-failing windows accepted initially.
Chunk 6  (type safety)         — mechanical, zero risk, unblocks nothing but cleans the diff
Chunk 2  (transition defaults) — small, high-value correctness fix
Chunk 1  (opacity pipeline)    — highest-impact bug; regenerate golden for window C after merge
Chunk 3  (chunkEncoder HDR)    — live bug, independent code path
Chunk 5  (resource management) — independent fixes, each small
Chunk 10 (CLI flags)           — user-facing, small
Chunk 7  (refactoring)         — after correctness fixes land
Chunk 4  (transform pipeline)  — largest chunk, depends on Chunk 1; regenerate golden for window F after merge
Chunk 11 (OSS/CI hygiene)      — anytime (11A already addressed by Chunk 0's synthesized assets)
Chunk 9  (test coverage)       — anytime, pairs well with any chunk (9A partially addressed by Chunk 0)
Chunk 8  (performance)         — after refactoring lands (cleaner code to benchmark)
Chunk 12 (investigation)       — anytime, independent
```

Chunk 0 lands first to establish the regression safety net. Windows C and F will fail until Chunks 1 and 4 land — set `maxFrameFailures` accordingly and tighten as fixes merge.

Chunks 6, 9, 11, and 12 can run in parallel with anything. Chunks 1 and 4 share `videoFrameInjector.ts` so should be sequenced. Chunk 7 (refactoring) should land after Chunks 1-3 so you're refactoring correct code.
