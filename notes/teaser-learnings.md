# Teaser → HyperFrames Learnings

Patterns extracted from `~/Desktop/teaser.html` (the standalone build of the
"Claude Design Teaser") that are worth porting, codifying, or just naming
inside HyperFrames. The teaser is a single-file React+Babel app with a
hand-rolled animation engine; we are not adopting its architecture, but it
contains real ideas that would improve HF.

22 patterns total, grouped by area, then ranked by effort/impact at the end.

---

## Framing: LLMs are the primary authors

HyperFrames compositions are written by LLM agents, not humans. A human
might inspect the output in Studio and request changes, but the markup is
LLM-generated. This changes which benefits matter.

What's different about LLM authors vs human authors:

1. **Lint and `validate` are the only feedback channel.** LLMs can't watch
   a render and notice stutter. They can't tab to Studio, scrub, and feel
   that the timing is off. Their entire awareness of correctness comes
   from `hf lint` output, `hf validate` headless errors, and whether the
   composition runs at all. Anything not caught by these is shipped broken.
2. **Every regeneration costs tokens, latency, and money.** First-try
   correctness is the only metric that matters at scale. APIs that are
   harder to misuse beat APIs that are easier to read.
3. **LLMs are bad at arithmetic.** Asking an LLM to "make sure all inner
   tweens sum to less than `data-duration`" is asking for hallucinated
   timings. Anything that lets the framework compute timings instead of
   the LLM is a major reliability win.
4. **LLMs only know patterns that are in skills.** A pattern that isn't
   documented in `~/.claude/skills/hyperframes*` won't be used reliably,
   even if the framework supports it. Skills are the system prompt;
   patterns outside skills are invisible.
5. **Constrained surfaces beat expressive ones.** 6 brand colors as
   tokens beat 16M hex codes — the LLM can't hallucinate a wrong hex if
   there's no hex to hallucinate. Same with eases, durations, etc.
6. **Error messages are read by LLMs, not humans.** They need to be
   specific and actionable enough that the LLM can fix the bug from the
   message alone, without scrolling source.
7. **Studio is for human reviewers.** Studio UX wins (sidebar relevance,
   widgets, click-to-select) help the human reviewing the LLM's output,
   but they don't make the LLM author better.

The benefit sections below are reframed accordingly: each one estimates
**effect on first-try LLM correctness** and **whether it needs a skill**
to land.

---

## 1. Time & Duration

### 1.1 Derived scene durations (`computeDur`)

Each scene exposes a static function that computes its duration from raw
tweak values, so editing one number resizes the scene and pushes everything
downstream — no manual bookkeeping.

```javascript
scene1Intro.computeDur = function (T) {
  const typeDur = T.s1_typeDur ?? 1.6;
  const holdDur = T.s1_holdDur ?? 1.2;
  const tail    = T.s1_tail    ?? 0.7;
  return typeDur + holdDur + tail;
};
```

**HF analogue:** clip durations should optionally be a function of attributes
on the clip, not a constant `data-duration`.

**Real-world benefit (LLM-authored):** Today, an LLM writing a clip has to
do this:
1. Decide the typing animation runs 1.6s
2. Decide the hold runs 1.2s
3. Decide the tail runs 0.7s
4. **Manually sum to 3.5s and write `data-duration="3.5"`**
5. Hope nothing in the inner tweens silently exceeds that

LLMs are bad at step 4 — they hallucinate sums (off by 0.1–0.5s often),
or pad pessimistically with `data-duration="6"` (creating dead frames),
or under-pad and clip the animation. **A typical multi-clip composition
has ≥1 timing arithmetic error per generation.** Each error means a
human notices the dead frame or the cut-off, sends it back, LLM
regenerates.

With `computeDur`: the LLM declares the inner timings and the framework
sums them. **Removes an entire class of LLM arithmetic errors.** The
generation succeeds on first try at a much higher rate.

Ripple effect: re-generating one clip with new timing no longer requires
the LLM to also rewrite all downstream clip start times — the framework
shifts them. That means a human request like "make scene 2 longer" turns
into a single-clip edit, not a full-composition rewrite.

**Skill needed:** yes — `hyperframes/compose-video` skill needs to teach
the LLM "do not compute durations; declare timings and let the framework
sum."

---

### 1.2 Probe pass / render pass separation

Before render, a cheap arithmetic-only pass walks every scene's `computeDur`
and lays out scene start times.

```javascript
const T = ctx.__rawStore || {};
const durs = SCENE_FNS.map(fn => fn.computeDur ? fn.computeDur(T) : 5);
const starts = [0];
for (let i = 0; i < 7; i++) starts.push(starts[i] + durs[i]);
const totalDur = starts[7];
```

**HF analogue:** add a probe phase to the parser that resolves dynamic
durations before any rendering decisions are made.

**Real-world benefit (LLM-authored):** Required infrastructure to make
1.1 work. Without it, the renderer can't know total duration up front,
which breaks `hf validate`'s ability to report "this composition is 47s
long, expected ≤30s" — exactly the kind of structured error message an
LLM uses to course-correct.

**Skill needed:** no — invisible plumbing.

---

### 1.3 Explicit scene-time contract

Every scene function takes the same args:

```javascript
function scene1Intro(ctx, t, t0, sceneDur) { ... }
```

Local time is always `t - t0`, progress is always `(t - t0) / sceneDur`.
Consistent across all 7 scenes.

**HF analogue:** a small `hf.sceneTime(el)` helper returning `{ t, lt, dur, p }`.

**Real-world benefit (LLM-authored):** Every clip currently begins with
`const t = window.__hfTime; const clipStart = ...; const lt = t - clipStart;`
or some variation. LLMs get this slightly wrong constantly:
- Forget to clamp `lt` to `[0, dur]` → animation runs negative
- Use `Date.now()` instead of `window.__hfTime` → non-deterministic render
- Divide by wrong duration → progress drifts
- Compute `clipStart` by hand from the parent `<scene>` instead of reading it

Each of these is a silent bug at preview time and a broken render at
output time. With `hf.sceneTime(el)` returning `{ lt, dur, p }`, the LLM
writes one line, can't get it wrong. **Removes the second-most-common
class of LLM clip-script errors** (after timing arithmetic).

**Skill needed:** yes — every code example in the compose skill should
use `hf.sceneTime(el)` instead of hand-rolled time math, so it becomes
the default pattern.

---

### 1.4 Self-referencing `at` metadata

A tweak's "where it lives on the timeline" can be a function of its own value:

```
 at: v => sceneStart + v
```

So a "click delay" tweak's editor position follows the value as you drag it.

**HF analogue:** if Studio adds richer property panels, this is the right model.

**Real-world benefit (LLM-authored):** Effectively zero in the LLM-author
context. This is a Studio editor feature for humans dragging values around.
Park indefinitely.

---

## 2. Animation Primitives

### 2.1 Easings as pure functions

```javascript
const twEase = {
  smooth: t => { t = Math.max(0, Math.min(1, t)); return t * t * t * (t * (t * 6 - 15) + 10); },
  back:   t => { /* overshoot */ },
  // ...
};
```

`twEase.smooth(p)` returns 0..1, callable from anywhere — not bound to a
GSAP `gsap.to({ ease: "..." })` call.

**HF analogue:** ship `hf.ease.{smooth, in, out, back, linear}`.

**Real-world benefit (LLM-authored):** When an LLM needs an eased value
outside a GSAP tween (canvas drawing, audio-reactive math, SVG morph,
manual `clip-path` math) it currently does one of:
1. **Hand-rolls easing math.** ~70% of the time it gets the curve wrong
   (writes `t * t * (3 - 2*t)` thinking it's smootherstep, etc.) → render
   looks subtly off, human reviewer can't articulate why.
2. **Pulls in another easing lib.** Adds a dependency, inconsistency with
   the rest of the composition.
3. **Sets up a paused dummy GSAP tween just to read `progress`.** Works
   but is grotesque — no LLM does this without prompting.

With `hf.ease.smooth(p)`: one function call, can't be wrong, matches the
curve used elsewhere in the composition. **Eliminates the "hand-rolled
easing math" failure mode entirely.**

**Skill needed:** yes — list canonical ease names in the compose skill so
the LLM uses `hf.ease.smooth` instead of hallucinating a Penner formula.

---

### 2.2 `seq` and `hold` declarative keyframes

```javascript
function seq(now, stops) {
  if (now <= stops[0][0]) return stops[0][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, v0, e0] = stops[i];
    const [t1, v1] = stops[i + 1];
    if (now >= t0 && now < t1) {
      const raw = (now - t0) / (t1 - t0);
      return twLerp(v0, v1, (twEase[e0 || "smooth"] || twEase.smooth)(raw));
    }
  }
  return stops[stops.length - 1][1];
}
```

**HF analogue:** `hf.seq(t, [...])`.

**Real-world benefit (LLM-authored):** Compare what the LLM has to
generate today vs with `seq`/`hold`.

**Today** ("fade in, hold, change to red, fade out" on one element):

```javascript
const tl = gsap.timeline({ paused: true });
tl.set(el, { opacity: 0, color: "white" });
tl.to(el,  { opacity: 1, duration: 0.5 });
tl.to(el,  { color: "red", duration: 0 }, 2.5);
tl.to(el,  { opacity: 0, duration: 0.5 }, 3.0);
window.__timelines.set("el-7", tl);
tl.seek(window.__hfTime - clipStart);
```

7 lines, requires:
- correct delay arithmetic (LLM gets `2.5` wrong if any earlier tween changes)
- correct registration on `window.__timelines` (LLM forgets the registration on ~20% of generations)
- correct `seek` math (`window.__hfTime - clipStart`, easy to mess up)

**With `seq`/`hold`:**

```javascript
el.style.opacity = seq(t, [[0, 0], [0.5, 1], [3, 1], [3.5, 0]]);
el.style.color   = hold(t, [[0, "white"], [2.5, "red"]]);
```

2 lines, no timeline registration, no seek math, no delay arithmetic
(the keyframe times are absolute, not relative). **Eliminates three
common LLM error sources at once.** First-try correctness for "fade in
hold change fade out" patterns probably goes from ~70% to ~95%.

**Skill needed:** yes — feature `seq` prominently in the compose skill,
demote raw GSAP timelines for simple keyframe sequences.

---

### 2.3 `envS` show/hide envelope

```javascript
function envS(now, t0, t1, t2 = Infinity, t3 = Infinity) {
  // fade-in t0→t1, hold, fade-out t2→t3
}
```

**HF analogue:** `hf.env(t, in, holdEnd, fadeStart, fadeEnd)`.

**Real-world benefit (LLM-authored):** "Fade in, hold, fade out" appears
in essentially every composition — every caption, lower-third, callout,
overlay. Today the LLM generates a paused GSAP timeline with three
tweens for each one (see 2.2 for the exact 5–7 lines).

A 60s caption-heavy composition has 20+ envelopes per minute. **At 5–7
lines each, that's 100–140 lines just for opacity envelopes.** Every
line is a chance for the LLM to mis-register, mis-seek, or mis-time.

With `envS`:

```javascript
el.style.opacity = envS(t, 1.0, 1.4, 3.4, 3.8);
```

20 envelopes × 1 line = 20 lines, each one impossible to mis-register.
**~80% reduction in code volume for the most common animation pattern,
correlated drop in error rate.** Also: shorter generated code = more
context budget for the *next* clip in the same conversation.

**Skill needed:** yes — make `envS` the canonical opacity-envelope
pattern in skills.

---

## 3. Tweak System

### 3.1 Tweak with metadata

Every animated value is registered with rich metadata (`label`, `at`
lifespan, `el` ownership, `step`/`min` widget hints).

**HF analogue:** `data-*` attributes already do most of this for clips.

**Real-world benefit (LLM-authored):** No action — HF's data-attribute
model already captures this. Documented for context.

---

### 3.2 Manifest as render byproduct

The teaser rebuilds the editor manifest fresh on every render.

**HF analogue:** HF extracts metadata at parse time, which is correct for
headless rendering.

**Real-world benefit (LLM-authored):** Confirms HF's current architecture.
No action.

---

### 3.3 Typed tweak helpers

```javascript
ctx.num   ("s1_size",    54,           { ... });
ctx.point ("s2_ing_pos", [300, 230],   { ... });
ctx.color ("s3_accent",  "#FF6B35",    { ... });
```

The editor renders the right widget (slider, XY pad, color picker).

**HF analogue:** add `data-tweak-type="number|point|color|select"` so Studio
can pick widgets instead of inferring.

**Real-world benefit (LLM-authored):** Largely a Studio (human-reviewer)
feature — the LLM doesn't care if Studio renders a color picker vs a text
field. **One LLM-relevant angle though:** if `data-tweak-type="color"`
constrains values to a palette declared on the parent `<theme>`, it
prevents the LLM from generating a brand-conflicting hex. Same for
`data-tweak-type="duration"` clamping to project-wide max. So this is
mostly a Studio win, with a smaller "constrain LLM choices" win on top.

Lower priority than the items targeting LLM correctness directly.

**Skill needed:** marginal.

---

### 3.4 Globally unique tween IDs

`s1_typeDur`, `s2_ing_pos`, `s3_accent` — scene-prefixed names.

**HF analogue:** if HF ever adds a flat tweak namespace (export to JSON
config), use this convention.

**Real-world benefit (LLM-authored):** Niche. Park.

---

### 3.5 Quadratic relevance falloff in Studio

Editor only shows tweaks "near" the playhead, with quadratic fade.

**HF analogue:** Studio sidebar polish.

**Real-world benefit (LLM-authored):** Pure human-reviewer UX. Helps the
person reviewing the LLM's output find the knob to tweak. Nice but does
not affect LLM correctness. Lower priority.

---

## 4. Element & Layer Model

### 4.1 One identifier, three roles (`el`)

A single string serves three purposes (tweak ownership, timing metadata,
DOM selection target).

**HF analogue:** `data-el` (or just element ID) linking clip attributes ↔
DOM ↔ Studio inspector.

**Real-world benefit (LLM-authored):** Studio-side benefit (select-to-edit,
hover-to-highlight) is for human reviewers. **LLM-side benefit:** if `data-el`
becomes the canonical "name this element" attribute, the LLM has one place
to attach metadata instead of inventing IDs/classes/data-name ad hoc. Reduces
naming hallucination. Skill could mandate "every animated element gets a
unique `data-el`."

Modest win. Mostly a Studio polish item.

**Skill needed:** yes if adopted — single naming convention.

---

### 4.2 Per-element culling, post-registration

Tweaks register before culling — manifest stays stable across timeline.

**HF analogue:** when HF adds dynamic clips, ensure metadata extraction is
independent of "is this clip currently visible".

**Real-world benefit (LLM-authored):** Future-proofing. No code today, just
a principle. Worth naming so a future LLM-generated conditional-clip
pattern doesn't break inspectability.

---

## 5. Visual Polish

### 5.1 Two-layer crossfade

Background color/scene transitions stack two divs with opacity.

**HF analogue:** ship as a registry block.

**Real-world benefit (LLM-authored):** Every registry block is one fewer
thing the LLM has to author from scratch. A blessed `bg-crossfade` block
that the LLM can `hyperframes add` and reference means:
- LLM doesn't have to invent the two-layer pattern itself
- LLM doesn't accidentally use `transition: background 0.5s` (scrub-unsafe)
- LLM doesn't write a one-layer GSAP `to({ background })` that flickers
  on color interpolation

**Every registry block raises the floor on LLM-authored quality.**
`bg-crossfade` is one of the highest-leverage blocks because background
transitions are universal in multi-scene videos and the wrong way to do
them is the most natural way for an LLM (CSS transitions).

**Skill needed:** the registry skill should list this block as the
canonical answer to "I need a background transition."

---

### 5.2 Per-scene "tone" tracks

Scalar values defined per-scene that interpolate during crossfades
(texture/grain/vignette/color-grade/audio level).

**HF analogue:** a "scene tracks" concept — global per-scene scalars that
interpolate on transitions.

**Real-world benefit (LLM-authored):** Today, when an LLM tries to add
"grain stronger in the dark scene, lighter in the closing scene" it has
to: write per-scene CSS variables, animate them on scene boundaries with
GSAP, register the timelines, get the crossfade timing to match the
scene's actual transition. Roughly 30 lines of correct, fragile code per
"tone" axis.

With scene tracks: declare `data-grain="0.3"` per scene, framework
interpolates. **One attribute per scene replaces 30 lines of GSAP.**

LLMs almost never produce cinematic-look compositions today because the
mechanics are too error-prone — they default to flat scenes. Scene
tracks change the default: with the right skill, the LLM adds grain,
vignette, audio ducking by reflex because it's one attribute.

**Raises baseline production quality of LLM-generated videos.**

**Skill needed:** yes — give the LLM a list of conventional tone tracks
it can set per scene.

---

### 5.3 `RevealText` progress-normalized stagger

Word-by-word reveal that always finishes at p=1, regardless of word count.

```javascript
const gap = n > 1 ? (1 - stagger) / (n - 1) : 0;
```

**HF analogue:** any text-stagger block in the registry should follow this
math.

**Real-world benefit (LLM-authored):** When the LLM regenerates a clip
because the human reviewer asked for different copy, the timing must
remain correct. Today: LLM writes a 4-word reveal with stagger such that
total = 1.5s. Human says "make it say [longer thing]". LLM regenerates
the text but doesn't recompute stagger → text overflows the clip.

This is **the most common failure mode of LLM-driven copy iteration on
text-heavy compositions.** With normalized stagger, the LLM doesn't have
to do the math: total time is constant by construction. Copy edits stop
breaking timing.

Note: this isn't "save marketers time on iteration" anymore — it's "the
LLM doesn't ship broken timing when re-prompted with different copy."

**Skill needed:** yes — `RevealText` and similar text-stagger blocks
should be the canonical answer in skills, with a note that stagger is
normalized.

---

### 5.4 `TypeText` caret discipline

Caret stays solid while typing, blinks after typing completes.

**HF analogue:** any typewriter component in the registry should do this.

**Real-world benefit (LLM-authored):** Free quality bump in the registry
component. The LLM doesn't have to know about caret behavior — it just
uses `<type-text>` and gets the right behavior. This is what blocks are
for: encoding designer-grade details so the LLM doesn't have to.

**Skill needed:** no — registry block handles it transparently.

---

## 6. Embedding & Lifecycle

### 6.1 `postMessage({type: "finished"})` host contract

```javascript
if (next >= duration) {
  if (!doneRef.current) {
    doneRef.current = true;
    try { window.parent.postMessage({ type: "finished" }, "*"); } catch {}
  }
}
```

**HF analogue:** documented `postMessage` protocol for `<hyperframes-player>`
(`{type: "ready" | "frame" | "finished" | "error"}`).

**Real-world benefit (LLM-authored):** Distribution unlock. Once the
protocol exists, an LLM can generate not just the composition but also
the integration code for embedding it in a docs page, marketing email,
or app — including the host-side "swap to CTA on finish" logic. Without
the protocol, the LLM has to invent an ad-hoc signal (timer, polling)
that's almost always wrong.

Concrete pattern an LLM can emit reliably:

```html
<iframe src="https://hf.example.com/embed/abc"></iframe>
<script>
  window.addEventListener("message", e => {
    if (e.data?.type === "finished") showCta();
  });
</script>
```

**Without the protocol, the LLM produces broken embed code at high rate.**
With it, the LLM has a single canonical pattern to emit. Distribution
becomes a one-shot LLM task.

**Skill needed:** yes — add to compose-video skill or a new "embed"
skill.

---

### 6.2 Two builds from one source

Standalone player vs editor build, same scenes, different chrome.

**HF analogue:** HF already has this split (`engine`, `studio`, `player`).

**Real-world benefit (LLM-authored):** Audit task. The LLM-relevant angle:
if `core` accidentally imports Studio code, the player bundle bloats and
embed performance suffers — which makes the postMessage embed unlock
(6.1) less attractive. Worth an audit before 6.1 ships.

**Skill needed:** no.

---

### 6.3 dt clamp on tab-hidden

```javascript
const dt = Math.min((now - lastRef.current) / 1000, 0.1);
```

**HF analogue:** Studio preview should clamp dt.

**Real-world benefit (LLM-authored):** Pure human-reviewer UX. Helps the
person previewing the LLM's output not lose their place when alt-tabbing.
Cheap to do, but the benefit is for the human, not the LLM. Lower
priority than items that affect LLM correctness.

---

## 7. Discipline / Invariants

### 7.1 No CSS transitions — scrub-safe

Stated in the file header as a core invariant.

**HF analogue:**
- Document loudly in `hyperframes/SKILL.md` and `core/AGENTS.md`.
- Add a `hyperframes lint` rule that flags `transition` / `animation` CSS
  inside `.clip` elements.

**Real-world benefit (LLM-authored):** **The single most important item
in this entire document.**

LLMs will write `transition: opacity 0.3s ease` constantly, because:
- It's the most common pattern in their training data
- It's the answer to most "how do I animate X in CSS" Stack Overflow posts
- It looks correct in any browser preview the LLM might be evaluating
  against
- It's shorter than the GSAP equivalent

The LLM has **no way to know this is wrong** unless lint catches it.
Studio preview will look fine. The LLM cannot watch the rendered video
and notice stutter — that's a human reviewer's job. Without lint, this
bug ships, every time, on every composition.

The cycle without lint:
1. LLM generates composition with `transition: opacity 0.3s`
2. LLM runs `hf lint` — passes
3. LLM runs `hf validate` — passes (no JS errors, transition is valid CSS)
4. Human renders → output is broken
5. Human writes back "the fade looks stuttery"
6. LLM has no way to localize the bug from that description, churns

The cycle with lint:
1. LLM generates composition with `transition: opacity 0.3s`
2. `hf lint` errors: `Found CSS transition on .clip element. Transitions
   are scrub-unsafe and produce stuttery renders. Use GSAP timelines or
   hf.envS instead.`
3. LLM reads the error, rewrites with `envS`, lint passes
4. Render works first time

**This single lint rule is the difference between LLM-authored HF being
production-ready and being unreliable.** Probably the highest-leverage
change in the whole codebase.

**Skill needed:** lint rule + skill mention. Skill should explicitly say
"never use CSS transition or animation properties on clips — use GSAP
timelines or hf.envS."

---

### 7.2 Deterministic pseudo-randomness

`Math.random()` in animation logic = different "random" values every render
= snow/jitter that wasn't in preview.

**HF analogue:** already an invariant; add lint enforcement.

**Real-world benefit (LLM-authored):** Same class as 7.1 — invisible to
the LLM, breaks the render. LLM writes `Math.random() * 100` for
particle X position because it's the natural way to express "random
position." Lint catches it pre-render.

Without this lint rule, the LLM ships particle/shimmer effects that
flicker chaotically in the rendered output and look fine in preview.
LLM cannot diagnose this from a human bug report ("particles look
weird") because it has no way to inspect frame-by-frame.

**Skill needed:** lint rule + skill mention. Skill should provide a
seeded-random helper as the blessed alternative.

---

### 7.3 Constrained design system

Six color tokens, one serif font, one sans, one mono.

**HF analogue:** registry blocks should consume CSS variables (`var(--hf-color-bg)`),
not hardcoded hex.

**Real-world benefit (LLM-authored):** **Hallucination reduction by
constraint.** When the palette is 6 named tokens, the LLM can't pick
`#FF6B35` when the brand color is `#FF7B30` — the option literally
doesn't exist in the namespace. Same for fonts, eases, durations
(if duration tokens exist).

This is the framework version of "give the LLM a multiple choice
question instead of a fill-in-the-blank." LLMs are dramatically more
accurate on constrained-choice problems.

Concrete:
- Today, generating "5 social media videos in the brand palette" results
  in 3-4 of them having one or two off-brand hex codes (LLM
  approximated by eye).
- With tokens: LLM emits `var(--brand-primary)`. Either the token
  exists and is correct, or lint errors. **Brand consistency goes from
  ~70% to 100%.**

For an org producing dozens of customer-templated videos per quarter,
this is the difference between "manually QA every video for brand
compliance" and "trust the framework."

**Skill needed:** yes — list the available tokens in the project's
context so the LLM uses `var(--…)` references. Lint rule to forbid
hex codes in `.clip` elements would close the loop.

---

### 7.4 Doc comments explain WHY, not WHAT

Cultural pattern in `teaser.html` — comments justify design choices,
constraints, tradeoffs.

**HF analogue:** add to `AGENTS.md`.

**Real-world benefit (LLM-authored):** When future LLMs (and humans)
modify HF source, "why" comments prevent the "this looks redundant, let
me remove it" refactor that breaks production. Concrete: 6.3's dt clamp
is a one-liner that looks deletable — without the comment explaining
tab-switch behavior, the next LLM cleaning up the file removes it.
**LLMs are aggressive simplifiers without context.** "Why" comments
are the only defense.

**Skill needed:** add to internal contributor docs (`AGENTS.md`).

---

## 8. Anti-patterns observed (do not adopt)

- **Shipping the toolchain in the page.** Babel standalone, React DOM dev,
  duplicated transformed code all live inline. Fine for a one-off marketing
  artifact, wrong for any framework. HF's compile-time approach is correct.
- **Single 17000-line HTML file.** Authoring works for one person; doesn't
  scale. HF's package boundary is correct. Note: also makes the file
  unreadable to LLMs (exceeds typical context budgets).
- **Inline `blob:` URLs for fonts.** Die the moment the file leaves the
  original origin. Use proper font files.

---

## Prioritization (LLM-author lens)

Re-ranked: items that improve **LLM first-try correctness** or **LLM
distribution-code generation** rise. Pure Studio UX items fall.

| # | What | Effort | LLM first-try gain | Notes |
|---|------|--------|--------------------|-------|
| **7.1** | Lint `transition`/`animation` inside `.clip` | ~1 day | **Massive** — closes the #1 invisible-to-LLM bug class. | LLM cannot diagnose this without lint. Highest leverage in the doc. |
| **7.2** | Lint `Math.random`/`Date.now` in clips | ~30 min | **Massive** — same bug class as 7.1. | Pair with 7.1 in same PR. |
| **2.1–2.3** | `hf.utils` (`ease`, `seq`, `hold`, `envS`, `lerp`) | ~1 day | **Large** — replaces the 5–7-line GSAP boilerplate where LLMs make 3+ classes of error. | Code volume drops ~80% on opacity envelopes. |
| **1.1 + 1.2** | `computeDur` + probe pass | ~1 week | **Large** — removes the LLM's timing-arithmetic burden entirely. | Bigger architectural change but eliminates the most common LLM error class. |
| **7.3** | Tokenize registry blocks (CSS variables) + lint hex in clips | ~3 days* | **Large for branded work** — turns brand consistency into a framework guarantee. | *~1 hour per existing block to retrofit. |
| **5.3** | Audit registry text components for progress-normalized stagger | ~2 hours | **Medium** — kills "copy regen breaks timing" failure mode. | Cheap, do alongside other registry work. |
| **5.1** | Background crossfade as registry block | ~4 hours | **Medium** — every block raises the floor on LLM output. | Pair with skill update so LLM uses it by default. |
| **6.1** | `postMessage` embed protocol | ~1–2 days | **Medium for distribution** — LLM can emit working embed code. | Distribution unlock; complements composition authoring. |
| **5.2** | Per-scene tone tracks (grain/vignette/audio) | ~1 week | **Medium** — raises baseline production quality of LLM output. | LLMs will use this if the skill teaches them to. |
| **1.3** | `hf.sceneTime(el)` helper | ~1 hour | **Medium** — kills second-most-common clip-script error class. | Trivial to ship. |
| **5.4** | Typewriter caret discipline in registry | ~30 min | **Small** — handled by registry block transparently. | LLM gets the win for free. |
| **4.1** | `data-el` unifying inspector ↔ stage ↔ attrs | ~2 days | **Small for LLM, large for human reviewers** — naming convention helps slightly. | Mostly a Studio UX upgrade. |
| **6.2** | Audit `core`/`engine`/`studio`/`player` boundary | ~1 day | **Small** — supports 6.1 by keeping player bundle small. | Run before 6.1 ships. |
| **3.3** | `data-tweak-type` widget hints | ~3 days | **Small for LLM, large for Studio** | Mostly a human-reviewer feature. |
| **6.3** | `dt` clamp on tab-hidden in Studio | ~10 min | **Zero** — pure human-reviewer benefit. | Still cheap and worth doing. |
| **3.5** | Quadratic relevance falloff in Studio | ~2 hours | **Zero** — human-reviewer UX. | Defer until human-reviewer flow is the bottleneck. |
| **7.4** | Doc comment philosophy in `AGENTS.md` | ~30 min | **Indirect** — protects LLM-authored code from over-aggressive future LLM refactors. | Cultural; cheap. |
| **4.2** | Per-element culling discipline | — | **Indirect** — future-proofing for LLM-authored conditional clips. | Principle, no code today. |
| **3.1, 3.2** | Already in HF | — | — | No action. |
| **3.4, 1.4** | Niche; only matters if Studio expands | — | — | Park. |

The pattern: **lint rules and `hf.utils` are the highest-leverage items
because they directly affect what the LLM can ship without human
intervention.** Studio polish items still matter, but only after the
LLM-authoring path is reliable.

---

## Suggested first PRs

**Optimize for the LLM authoring loop**, not the human review loop.
Order:

### PR 1: Lint rules for `transition`/`animation` and `Math.random`/`Date.now` in clips (#7.1, #7.2)

Extend `packages/cli/src/commands/lint.ts` with two regex/AST-based rules.
~50 LOC each. Critical: **error messages must be specific enough that an
LLM can fix from the message alone**, e.g.:

```
error: hf/no-css-transitions
  notes/example.html:42:5
  CSS `transition: opacity 0.3s ease` found on a `.clip` element.

  Renders capture frames at independent timestamps; CSS transitions are
  not scrub-safe and produce stuttery output that looks correct in
  Studio preview.

  Fix: use a paused GSAP timeline registered on `window.__timelines`,
  or `hf.envS(t, fadeIn, holdEnd, fadeOut, end)` for opacity envelopes.
```

**Pitch:** "These two lint rules are the difference between LLM-authored
HF being shippable and being unreliable. They catch the bug classes the
LLM literally cannot see. Half a day of work, pays back the first time
they fire."

### PR 2: `hf.utils` module (#2.1–2.3, #1.3)

`packages/core/src/utils/{ease,seq,env,lerp,sceneTime}.ts`. ~100 LOC,
zero risk. Bundle includes:

- `hf.ease.{linear, smooth, in, out, back}`
- `hf.lerp(a, b, t)`
- `hf.seq(t, [[t0, v0, ease?], [t1, v1, ease?], ...])`
- `hf.hold(t, [[t0, v0], [t1, v1], ...])`
- `hf.envS(t, fadeIn, holdEnd, fadeOut, end)`
- `hf.sceneTime(el) → { t, lt, dur, p }`

**Pitch:** "Replaces 5–7-line GSAP timeline boilerplate with single
expressions for the patterns that appear in every composition. LLM
generates fewer lines, makes fewer of the three common mistakes
(timing-registration, seek math, delay arithmetic). First-try
correctness goes up, token spend goes down."

### PR 3: Skills update — make the new utils + lint rules canonical

The skills currently teach LLMs to use raw GSAP timelines. After PRs 1
and 2 ship, the `hyperframes/compose-video` and `hyperframes-cli`
skills should:

- Demote raw GSAP timeline patterns for opacity envelopes
- Teach `hf.envS` / `hf.seq` / `hf.hold` as the canonical answers
- Document the new lint errors and how to satisfy them
- Mandate `hf.sceneTime(el)` over hand-rolled time math
- Provide explicit "do not use" examples for `transition`, `animation`,
  `Math.random`, `Date.now` inside clips

**Pitch:** "PRs 1 and 2 are useless without this. Skills are the
LLM's system prompt — patterns outside skills don't get used reliably."

### PR 4: `computeDur` convention (#1.1, #1.2)

Bigger architectural change. Deserves its own design doc before code.
Touches the parser, the runtime, Studio's scrubber, and the render
pipeline.

**Pitch:** "Removes the LLM's burden of summing inner timings. Eliminates
a major arithmetic-error class that currently requires human review to
catch. High-impact but bigger change — design separately."

### PR 5: Tokenize registry blocks + lint hex in clips (#7.3)

Constrained palette beats freeform hex. Retrofit existing blocks to
consume CSS variables, add a lint rule against literal hex/rgb in clip
elements, document the project's token namespace in skills.

**Pitch:** "Brand consistency stops being a 'manually QA every video'
problem and becomes a framework guarantee. Especially valuable for
HeyGen's customer-templated work."

---

PRs 1–3 are tightly coupled and should ship together as the
"LLM-authoring reliability" patch. PR 4 is high-leverage but bigger;
plan separately. PR 5 is independent and can ship anytime.
