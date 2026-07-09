---
date: 2026-07-09
researcher: Claude
topic: Buttery-smooth scrolling, zooming, and live-follow for the agent activity timeline
component: apps/ui/src/components/dashboard/agent-activity-timeline.tsx
status: complete
---

# Smooth scroll / zoom / live-follow options for the activity timeline

Grounded in the current implementation at
`apps/ui/src/components/dashboard/agent-activity-timeline.tsx` (branch
`root-activity-timeline`, commit `85d42763`). Line references below are to that file.

## TL;DR — ranked architecture recommendation

**Rank 1 (recommended): Hybrid — keep the native scroller, stop writing `scrollLeft`
per frame.** Keep `overflow-auto` as the single input surface for panning (native
scrollbar, trackpad momentum, elastic overscroll all stay free). Change three things:

1. **Live-follow via a drift transform, not per-frame `scrollLeft` writes.** While
   live, the rAF loop translates the inner content wrapper with
   `transform: translateX(-driftPx)` (compositor-only, never touches the scroll
   position). Each `NOW_TICK_MS` re-render folds the drift back into layout +
   one programmatic `scrollLeft` write. The user's scroll position is *never*
   corrected between ticks, so the snap-back fight disappears by construction.
2. **Input-based follow-break** (wheel `deltaX < 0`, pointerdown) instead of — or in
   addition to — the current scroll-position deviation check. This is the
   chat-transcript / trading-chart pattern.
3. **Continuous zoom** — replace `zoomIndex` with a continuous `windowMs` clamped to
   `[1h, 7d]`, multiplied by `2^(deltaY·k)` per wheel event, rAF-throttled. The
   discrete levels remain only as button presets.

**Rank 2 (ideal endstate, if the timeline becomes a flagship surface): a d3-zoom-style
camera.** One piece of state `{tLeft, pxPerMs}` (time at the left edge + scale),
driven by wheel/pointer events on a non-scrolling container; content positioned by
`translateX` from that camera; bars virtualized by visible time range. This is what
react-calendar-timeline converged on (v0.30.0-beta.15 replaced native `scrollLeft`
with `transform: translateX()` **specifically because Safari's momentum engine fights
programmatic scrollLeft writes** — the exact bug this component has). Costs: you lose
the native scrollbar and must hand-roll drag inertia; trackpad momentum survives
because macOS delivers it as decaying `wheel` events.

**Rank 3 (not recommended): canvas rendering** (lightweight-charts / Grafana-uPlot
style). Best possible pan/zoom feel, but you'd re-implement bars, hover, tooltips,
links, focus rings, and lose all Tailwind/Radix integration. Overkill for ~1–2k bars.

Why Rank 1 wins here: every observed problem (snap-back fight, chunky zoom,
scroll-linked jank) is fixable without abandoning native scrolling, and the native
scroller is doing real work for you on macOS (momentum, rubber-banding,
`overscroll-x-contain`, scrollbar affordance, accessibility). Rank 2 is a rewrite of
the interaction layer for a dashboard widget; do it only if requirements grow
(minimap, pinch-zoom on touch, drag-to-pan).

---

## Root-cause analysis of the current fight (why snap-back happens)

The rAF loop (lines 549–567) writes `scrollLeft` **every frame** whenever it deviates
&gt; 0.5px from the live target. The follow-break check (lines 618–626) only fires when
the user has drifted &gt; `FOLLOW_BREAK_PX` (24px) *at the moment a scroll event is
processed*. But the rAF loop re-pins between scroll events, resetting the deviation
to ~0 each frame — so the user can only break follow by moving **more than 24px in a
single frame (~16ms)**. A slow trackpad drag never does; the view rubber-bands back.
Momentum makes it worse: each momentum tick is small, gets corrected, and the
`programmaticScrollRef` flag can be consumed by the wrong scroll event when a
programmatic write and a user scroll land in the same frame (one boolean, two queued
scroll events — attribution is a coin flip).

Note the pinning is also massively out of proportion to the motion it produces: at
the 1h zoom with a ~1280px viewport, `pxPerMs ≈ 0.00036`, so "now" advances
**~0.36px/second**. The loop runs 60 writes/sec to move the view a third of a pixel.
All zoom levels coarser than 1h move even less. The per-frame glide buys nothing
perceptible; it exists only to fight the user.

---

## Per-topic findings

### 1. Transform-based panning vs native `scrollLeft`

**How the libraries do it:**

- **react-calendar-timeline** — the closest architectural cousin (DOM bars in lanes).
  Renders a canvas `buffer × viewport` wide (default 3×), lets the browser scroll it
  natively, and when scroll passes 50% of the invisible side, re-anchors: repositions
  items' `left` and jumps the scroll back — "visually endless scrolling canvas"
  ([README](https://github.com/namespace-ee/react-calendar-timeline)). Crucially, in
  **v0.30.0-beta.15 (2025) they abandoned native `scrollLeft` for the pan position**:
  > "Fix Safari trackpad scroll jank by replacing native `scrollLeft` with CSS
  > `transform: translateX()` so the browser never owns the scroll position.
  > Eliminates the feedback loop where Safari's momentum engine fights programmatic
  > `scrollLeft` writes in `componentDidUpdate`."
  Same release: "Batch scroll events via `requestAnimationFrame` to coalesce multiple
  wheel/pointer events into a single onScroll → onTimeChange → canvas recalculation
  cycle per frame." Follow-up betas fixed the predictable transform-scroll fallout:
  absolutely-positioned markers collapsing inside the transform wrapper (beta.16) and
  vertical page scroll being hijacked by horizontal panning (beta.17)
  ([CHANGELOG](https://github.com/namespace-ee/react-calendar-timeline/blob/master/CHANGELOG.md)).
  **Lesson:** they hit *your exact bug* and solved it by taking ownership of the pan
  position away from the browser — but only after shipping years on native scroll.
- **d3-zoom** — the canonical camera model: a single `ZoomTransform {k, x, y}`,
  mutated by wheel (`k·2^(-deltaY·factor)`), drag, and pinch; consumers re-derive
  scales via `transform.rescaleX(xScale)` and re-render. No native scrolling at all;
  the container doesn't overflow. Handles "a surprising variety of input modalities
  and browser quirks" including macOS continuous-gesture wheels
  ([d3-zoom docs](https://d3js.org/d3-zoom),
  [d3 zoom — the missing manual](https://www.datamake.io/blog/d3-zoom/)).
- **vis-timeline** — DOM-rendered; pan/zoom mutate a `Range {start, end}` and trigger
  a full redraw that repositions items (`setWindow`/`getWindow` API). No native
  scroll for the time axis. Known to get heavy with many items because every pan
  frame is a re-layout ([vis-timeline docs](https://visjs.github.io/vis-timeline/docs/timeline/)).
- **TradingView lightweight-charts** — canvas; the time scale is a
  `{rightOffset, barSpacing}` camera (zoom = change barSpacing, pan = change offset).
  Follow-live is `shiftVisibleRangeOnNewBar` (below) and `scrollToRealTime()` is an
  *animated* restore ([time-scale docs](https://tradingview.github.io/lightweight-charts/docs/time-scale),
  [TimeScaleOptions](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/TimeScaleOptions)).
- **Grafana state-timeline** — uPlot, canvas, camera model again.

**Tradeoff table:**

| | Native `overflow-auto` (current) | Transform camera |
|---|---|---|
| Trackpad momentum / rubber-band | free, perfect | wheel momentum free (macOS emits decaying wheel events); drag inertia hand-rolled |
| Scrollbar | free | gone (or fake one) |
| Programmatic follow | **fights the user** | trivial — camera just advances |
| Continuous zoom anchoring | re-anchor `scrollLeft` in layout effect (flicker risk) | exact, one transform write |
| Keyboard / a11y scrolling | free | manual |
| Vertical scrolling of lanes | same scroller, free | keep native vertical, transform horizontal only (split axes) |
| Implementation risk | low | medium (see rct beta.16/17 regressions) |

**Recommendation:** stay native for input, but *stop competing for the scroll
position* (Rank 1 mechanism below). Adopt the camera only if you later need
drag-to-pan or a minimap.

### 2. Continuous zoom

Feasible without killing perf, in two tiers:

**Tier A — continuous re-render (try first).** Replace `zoomIndex` with
`windowMs` state, updated from wheel via exponential scaling and throttled to one
`setState` per rAF:

- The cost per zoom frame is exactly one discrete-step render today: `layoutLanes`
  over ~1200 tasks is O(n·rows) with tiny constants (~a few hundred µs), and the bars
  re-render with new `left/width`. The expensive part is React reconciliation of
  ~1200 `<Tooltip><button>` subtrees. Two mitigations make 60fps realistic:
  1. **Virtualize by time range** — only render bars whose `[left, right]` intersects
     `[scrollLeft − buffer, scrollLeft + viewport + buffer]`. You already compute
     geometry for every task in `layoutLanes`; filtering there is one pass. At the 1h
     zoom this typically cuts 1200 bars to a few dozen.
  2. **Memoize the bar** — extract `<TimelineBar task geometry …>` as a `memo`
     component keyed on primitive props so unchanged bars skip reconciliation.
     (Radix `Tooltip` renders its content lazily, but 1200 Trigger wrappers are still
     ~1200 context subscriptions — with virtualization this stops mattering.)
- d3's wheel formula, adapted: `windowMs *= 2^(deltaY / 200)` (per-event, clamp to
  `[3.6e6, 6.048e8]`), anchor logic identical to the existing `zoomTo`. Trackpad
  pinch arrives as `ctrlKey`-wheel with small deltas — continuous scaling makes the
  `WHEEL_ZOOM_THRESHOLD` accumulator obsolete (delete it; small deltas now produce
  small zooms, which is the correct feel).

**Tier B — transform-during-gesture, snap-render on idle (only if Tier A janks).**
During the active gesture apply `scaleX(k)` with `transform-origin: <anchor>px 0` to
the content wrapper (compositor-only; bars and their text stretch), then after
~120ms of wheel silence do one real re-render at the final `pxPerMs` and reset the
transform. Text distortion is visible but brief; counter-scaling every label with
`scaleX(1/k)` is possible but costs a style write per bar per frame — not worth it.
This is the classic "cheap preview, expensive settle" pattern (Google Photos grid
zoom, many map libs). Verdict: keep in the back pocket; with virtualization Tier A
should hold 60fps for this data size.

### 3. Live-follow that doesn't fight the user

**How the good ones do it:**

- **Chat/transcript UIs** ([intuitive scrolling for chatbot streaming](https://tuffstuff9.hashnode.dev/intuitive-scrolling-for-chatbot-message-streaming),
  [handling scroll behavior for AI chat apps](https://jhakim.com/blog/handling-scroll-behavior-for-ai-chat-apps),
  [the scroll problem nobody talks about](https://medium.com/@disgcfrguy/the-scroll-problem-nobody-talks-about-when-building-ai-chat-interface-987c223cafc0)):
  the consensus pattern is **input-event-based break**: a `wheel` / `touchstart` /
  `pointerdown` event is *definitionally* the user (layout shifts and programmatic
  scrolls never fire `wheel`), so follow breaks immediately on the first
  away-from-edge input event — no deadband race. Re-arm follow when the user scrolls
  back to the edge (deviation check is fine for *re-arming*, just not for breaking).
  The known failure mode in the wild is exactly yours: a pending
  "programmatic-scroll" flag mis-attributing the user's scroll and snapping back
  ([hermes-agent #37527](https://github.com/NousResearch/hermes-agent/issues/37527)).
- **lightweight-charts**: `shiftVisibleRangeOnNewBar` shifts the window **only when
  the last bar is already visible** — i.e. follow is a *derived* property of "user is
  at the live edge", not a mode the code defends per frame. `scrollToRealTime()` is
  an explicit, animated user action (your "Back to live" button)
  ([TimeScaleOptions](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/TimeScaleOptions)).

**macOS specifics:** trackpad momentum arrives as a continuing stream of `wheel`
events with decaying deltas (d3-zoom's docs call the macOS wheel "a continuous
gesture"), so wheel-based break detection keeps working *during* inertia — you don't
need to distinguish momentum-scroll events from programmatic ones at the `scroll`
level. `deltaX` is the horizontal component (two-finger horizontal pan); elastic
overscroll is already contained by the existing `overscroll-x-contain`.

**The drift-transform mechanism (removes the fight entirely):** while live, never
write `scrollLeft` from the loop. Between `NOW_TICK_MS` re-renders, "now" advances
≤ ~2px (5s × pxPerMs at the tightest zoom) — apply that as
`translateX(-drift)` on the content wrapper (and `+drift` on the now-line), both
compositor-only style writes on refs. On each 5s re-render, layout absorbs the new
`nowMs`, the transform resets to 0, and **one** `scrollLeft` write re-pins (layout
effect, flagged programmatic). Result: the browser owns the scroll position at all
times during user interaction; your code touches it once per 5s, and even that write
is skipped if follow was broken. This is react-calendar-timeline's insight ("the
browser never owns the pan position" — inverted: "your code never owns the scroll
position while the user might be using it") applied with 20 lines instead of a
rewrite.

### 4. Smooth zoom anchoring

- The current `pendingAnchorRef` + `useLayoutEffect` re-anchor (lines 574–582) is the
  correct primitive — synchronous before paint, no flicker. Keep it; with continuous
  zoom it runs per rAF-throttled zoom frame and the anchor point stays glued to the
  cursor *exactly* (this is precisely `d3.zoomTransform`'s invariant
  `x = anchorPx − k·anchorTime`).
- **Is an animated ~150ms zoom worth it?** Only for *discrete* inputs. Once zoom is
  continuous, wheel/pinch gestures are self-animating — the user's own event stream
  is the animation, and inserting easing adds input latency (trading charts do not
  ease wheel zoom; they apply it raw per event). Keep an eased transition **only for
  the buttons and reset** (a discrete 1h→3h jump is jarring). Implementation that
  avoids React-render-per-frame: rAF-interpolate `windowMs` in log-space
  (`exp(lerp(log(a), log(b), ease(t)))`) over ~150ms, calling the same rAF-throttled
  zoom setter — i.e. reuse the continuous-zoom path, ~10 renders total, each cheap
  after virtualization. The pure-CSS alternative (transition `scaleX` then
  snap-render) saves those ~10 renders but distorts text and needs the
  transform-origin/anchor bookkeeping — not worth it for a 150ms button animation.
- `scrollTo({behavior:'smooth'})` is **not** a building block here: easing and
  duration are UA-defined and not customizable, and there is no linear option
  ([MDN Element.scrollTo](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollTo)).
  Also note `element.animate()` (WAAPI) cannot animate `scrollLeft` — it animates CSS
  properties only. For the animated "Back to live" pan, hand-roll: rAF +
  `easeOutCubic` writing `scrollLeft` (flagged programmatic), 250–300ms, then arm live.

### 5. Perf toolbox (2026 status)

- **`will-change: transform`** — put it on the *one* inner content wrapper that the
  drift/zoom transforms touch (pre-promotes the layer, avoids re-raster on first
  frame). Do **not** put it on bars; hundreds of layers explode compositing memory.
- **`contain` / `content-visibility`** — per-lane `content-visibility: auto` +
  `contain-intrinsic-size: auto <laneHeight>px` lets the engine skip layout/paint of
  lanes scrolled out *vertically* (free vertical virtualization,
  [web.dev article](https://web.dev/articles/content-visibility)). **Trap:** layout
  containment makes the lane a containing block for `position: absolute` children —
  fine here since bars are positioned relative to their lane row anyway, but the
  now-line/connector SVG must stay outside contained subtrees (cf. the rct beta.16
  marker-collapse bug). It does nothing for *horizontal* overflow within a lane
  (bars are all in one contained box) — horizontal culling must stay manual
  (the time-range filter from §2), and the two compose fine
  ([MDN content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility)).
- **`pointer-events: none` during scroll/zoom** — set a class on the content wrapper
  while scrolling (clear on 150ms scroll-idle timeout). Kills hover hit-testing and
  the `setHoveredTaskId` state storms while bars stream under the cursor. Cheap,
  high yield — currently every bar passing under the pointer during a pan fires
  mouseenter/mouseleave → React state → connector recompute.
- **CSS scroll-driven animations (`animation-timeline: scroll()`)** — still **not
  Baseline** in mid-2026: Chrome 115+/Edge/Safari 26 yes, Firefox stable still behind
  `layout.css.scroll-driven-animations.enabled` (a named Interop 2026 priority;
  global support ~83%) ([web-features explorer](https://web-platform-dx.github.io/web-features-explorer/features/scroll-driven-animations/),
  [caniuse](https://caniuse.com/mdn-css_properties_animation-timeline_scroll),
  [MDN guide](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scroll-driven_animations)).
  Progressive-enhancement only; also note it's the wrong tool for the now-line
  (which is *time*-driven, not scroll-driven).
- **`element.animate()` for the now-line** — yes, this is the right tool: between
  5s ticks the now-line's motion is perfectly linear, so replace the per-frame
  `style.left` writes with one compositor animation per tick:
  `nowLine.animate([{transform:'translateX(0)'},{transform:`translateX(${5_000*pxPerMs}px)`}], {duration:5_000, easing:'linear', fill:'forwards'})`.
  (Switch the now-line from `left` to `left: 0` + `transform` so it never triggers
  layout.) One JS call per 5s instead of 60 style writes/s, and it keeps animating
  even if the main thread hitches.
- **Misc observed in the file:** `handleScroll` calls `void loadOlder()` on every
  scroll event when near the left edge — already guarded by `isLoadingHistory`, fine.
  The lane-label `translateY` sync on scroll (line 610) is the right pattern (ref
  write, no state). Keep both.

---

## Plan A — minimal change (1 PR, ~1 day)

Keeps: native scroller, discrete-render-on-tick data flow, `layoutLanes`, anchoring
logic. Changes: follow mechanism, follow-break trigger, zoom continuity, hover storm.

**A1. Kill the per-frame `scrollLeft` pin; add drift transform.**

```tsx
// Wrapper around the timeline content (inside the scroller, around timelineRef div):
// <div ref={driftRef} style={{ willChange: "transform" }}> ... </div>

// Rendered-at time of the current layout, for drift computation.
const renderNowRef = useRef(nowMs);
renderNowRef.current = nowMs;

useEffect(() => {
  if (!live) return;
  let raf = 0;
  const step = () => {
    const drift = (Date.now() - renderNowRef.current) * pxPerMsRef.current;
    // Content slides left so "now" stays put relative to the viewport…
    if (driftRef.current) driftRef.current.style.transform = `translateX(${-drift}px)`;
    // …and the now-line slides right within the content to stay on "now".
    if (nowLineRef.current) nowLineRef.current.style.transform = `translateX(${drift}px)`;
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(raf);
    if (driftRef.current) driftRef.current.style.transform = "";
    if (nowLineRef.current) nowLineRef.current.style.transform = "";
  };
}, [live]);

// Re-pin ONCE per layout change (the 5s tick / zoom / data), not per frame:
useLayoutEffect(() => {
  const node = scrollerRef.current;
  if (!node || !live) return;
  if (driftRef.current) driftRef.current.style.transform = "";   // fold drift into layout
  if (nowLineRef.current) nowLineRef.current.style.transform = "";
  const nowX = (nowMs - timelineStartMs) * pxPerMs;
  programmaticScrollRef.current = true;
  node.scrollLeft = liveScrollTarget(node, nowX);
}, [live, nowMs, pxPerMs, timelineStartMs, liveScrollTarget]);
```

Drift between ticks is ≤ ~2px at the tightest zoom, so the transform never visibly
diverges from "truth"; the 5s re-pin is a ≤2px correction the eye can't see.

**A2. Input-based follow break** (in the existing `setScrollerNode` wheel listener +
one new pointer listener):

```tsx
const onWheel = (event: WheelEvent) => {
  if (event.ctrlKey || event.metaKey) { /* existing zoom path */ return; }
  // A real user gesture pulling back in time breaks follow instantly.
  // Works during trackpad momentum too — macOS keeps emitting wheel events.
  if (liveRef.current && event.deltaX < -2) setLive(false);
};
// Scrollbar grabs / drag: any pointerdown followed by a leftward scroll is the user.
node.addEventListener("pointerdown", () => { userPointerRef.current = true; }, { passive: true });
node.addEventListener("pointerup", () => { userPointerRef.current = false; }, { passive: true });
```

In `handleScroll`, replace the 24px-deviation break with: break if
(`userPointerRef.current` || last wheel < 200ms ago) and `scrollLeft` decreased.
Keep the deviation check only for **re-arming**: if the user scrolls back within
`FOLLOW_BREAK_PX` of the live edge while paused, flip `live` back on (nice-to-have
parity with chat UIs; the explicit button stays).

**A3. Continuous zoom** (same anchoring, no more index):

```tsx
const [windowMs, setWindowMs] = useState(ZOOM_LEVELS[DEFAULT_ZOOM_INDEX].ms);
const MIN_WINDOW_MS = ZOOM_LEVELS[0].ms;               // 1h
const MAX_WINDOW_MS = ZOOM_LEVELS.at(-1)!.ms;          // 7d

// In the wheel handler (replaces the accumulator entirely):
const zoomWheel = (event: WheelEvent) => {
  event.preventDefault();
  pendingZoomFactorRef.current *= 2 ** (event.deltaY / 200);
  pendingAnchorClientXRef.current = event.clientX;
  if (zoomRafRef.current) return;                       // rAF-throttle renders
  zoomRafRef.current = requestAnimationFrame(() => {
    zoomRafRef.current = 0;
    const factor = pendingZoomFactorRef.current;
    pendingZoomFactorRef.current = 1;
    zoomToWindow((ms) => clamp(ms * factor), pendingAnchorClientXRef.current);
  });
};
```

`zoomToWindow` is the existing `zoomTo` with `setWindowMs(clamp(...))` instead of
`setZoomIndex`. Buttons animate: rAF-interpolate `log(windowMs)` over 150ms with
`easeOutCubic`, calling the same setter (~10 renders). Header shows a humanized
window (`formatDurationMs(windowMs)`) instead of the fixed label.

**A4. Cheap perf wins:**
- Virtualize bars by visible time range: track `scrollLeft` in a ref, keep a
  *coarse* `visibleRange` state quantized to half-viewport steps (so panning doesn't
  re-render per scroll event), filter `row.map(...)` on bar↔range intersection.
- `pointer-events: none` on the bars container during scroll (class toggled by a
  scroll-idle timer in `handleScroll`).
- Now-line: switch `left` to `transform` positioning (needed by A1 anyway).
- Extract `<TimelineBar>` as `React.memo`.

**Verification:** `cd apps/ui && bun run lint && bunx tsc -b`; manual QA on macOS
trackpad — (1) slow two-finger left drag while live must break follow on the first
event, no snap-back including during momentum; (2) pinch zoom must be continuous and
anchored under the cursor; (3) leave the tab live 10min, no drift accumulation;
(4) DevTools Performance: no long tasks while panning at 1h zoom with 1k+ tasks.

## Plan B — ideal endstate (camera architecture, ~3–5 days)

Only if the timeline grows into a primary surface (drag-to-pan, touch, minimap).

- **State:** `camera = { tLeft: number /* ms at left edge */, pxPerMs: number }` in a
  ref + a version counter for React renders (rAF-throttled). Derived:
  `xOf(t) = (t - tLeft) * pxPerMs`.
- **Container:** horizontal `overflow: hidden`; vertical stays native
  `overflow-y: auto` (split axes — lanes scroll vertically natively, time pans via
  camera). Inner wrapper gets `transform: translateX(-fracPx)` for the sub-render
  remainder; bars are laid out against a render window of
  `[tLeft − buffer, tLeft + viewport/pxPerMs + buffer]` and only re-laid-out when the
  camera exits the buffered window (react-calendar-timeline's 3×-canvas trick, but
  time-indexed instead of scroll-indexed).
- **Input:** wheel `deltaX` → `tLeft += deltaX / pxPerMs`; wheel+ctrl/meta →
  `pxPerMs *= 2^(-deltaY/200)` with the d3 anchor invariant
  `tLeft = tAnchor − anchorPx / pxPerMs`; pointer drag → pan + velocity tracking →
  exponential-decay inertia on release (`v *= 0.95` per frame, stop under 0.02px/ms).
  Optional `d3-zoom` itself on the container to get all of this + touch for free
  (it's dependency-light and the `{k, x}` transform maps 1:1 onto the camera).
- **Live-follow:** while live, `tLeft = now − viewport/pxPerMs + gap/pxPerMs` each
  frame — pure camera write, *nothing to fight*; any pan/zoom input while live
  simply sets `live = false` first. Identical semantics to lightweight-charts'
  edge-derived follow.
- **Scrollbar affordance:** either omit (charts do), or render a slim proxy scrollbar
  bound to the camera.
- **Risks (from rct's beta series):** absolutely-positioned overlays inside the
  transformed wrapper (now-line, connector SVG) need explicit height/containing-block
  care; must not hijack vertical trackpad intent (only consume `deltaX`-dominant
  wheel events: `Math.abs(deltaX) > Math.abs(deltaY)`).

## Sources

- [react-calendar-timeline README — "behind the scenes" 3× canvas](https://github.com/namespace-ee/react-calendar-timeline)
- [react-calendar-timeline CHANGELOG — 0.30.0-beta.15/16/17 transform-scroll migration](https://github.com/namespace-ee/react-calendar-timeline/blob/master/CHANGELOG.md) (verified against raw file 2026-07-09)
- [d3-zoom docs](https://d3js.org/d3-zoom) · [d3 zoom — the missing manual](https://www.datamake.io/blog/d3-zoom/)
- [vis-timeline docs — setWindow/range model](https://visjs.github.io/vis-timeline/docs/timeline/)
- [lightweight-charts Time scale](https://tradingview.github.io/lightweight-charts/docs/time-scale) · [TimeScaleOptions — shiftVisibleRangeOnNewBar, rightOffset, scrollToRealTime](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/TimeScaleOptions)
- [Intuitive scrolling for chatbot streaming](https://tuffstuff9.hashnode.dev/intuitive-scrolling-for-chatbot-message-streaming) · [Handling scroll behavior for AI chat apps](https://jhakim.com/blog/handling-scroll-behavior-for-ai-chat-apps) · [The scroll problem nobody talks about](https://medium.com/@disgcfrguy/the-scroll-problem-nobody-talks-about-when-building-ai-chat-interface-987c223cafc0) · [hermes-agent #37527 — snap-back mis-attribution bug](https://github.com/NousResearch/hermes-agent/issues/37527)
- [MDN Element.scrollTo — UA-defined smooth behavior](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollTo)
- [web.dev — content-visibility](https://web.dev/articles/content-visibility) · [MDN content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility) · [MDN — Using CSS containment](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Using)
- [Scroll-driven animations — web-features explorer (Baseline status)](https://web-platform-dx.github.io/web-features-explorer/features/scroll-driven-animations/) · [caniuse animation-timeline: scroll()](https://caniuse.com/mdn-css_properties_animation-timeline_scroll) · [MDN scroll-driven animations guide](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scroll-driven_animations)
