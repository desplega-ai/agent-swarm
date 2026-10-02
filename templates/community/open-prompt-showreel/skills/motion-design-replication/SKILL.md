---
name: motion-design-replication
description: Rebuild the feel of a reference motion-design clip (camera, depth of field, easing, captions, outro) as an on-brand agent-swarm piece in Remotion, then prove it with side-by-side frames and a model re-read of the replica. Use when asked to "replicate this video's vibe for the swarm", "make one like this but ours", or to rebuild a competitor/product clip. Runs after motion-design-video-analysis.
metadata:
  type: procedure
---

# Motion-design replication

Takes a reference clip and produces a replica that matches its craft (resolution, fps, duration, camera, DOF, easing, caption style, outro) while swapping everything brand-specific (palette, logo, shapes, copy) for agent-swarm's. Built on a run that rebuilt Linear's "Loops updates" dial as a Schedules teaser. Keep the working R3F + postprocessing + label setup from your first 3D composition in your Remotion project and reuse it.

The bar is the highest quality of content. A render that passes automated checks proves nothing about how it looks. The loop in Step 5 is the work.

## Step 1 — analyse and write the rebuild spec

Run `motion-design-video-analysis` on the reference, including its rebuild-spec section and the by-eye claim check. You need, in frames: every cut, every caption change, every transition window. Pull 10 fps windows around each transition; a cut hidden under a fast element reads as a "camera move" to both you and the model until you step frames.

## Step 2 — pick the swarm subject and map it onto the reference's metaphor

Pick the feature whose shape matches the reference's central object (a dial ⇒ Schedules, because a dial reads as a clock and a clock maps onto cron). Write captions that follow one real run of that feature, in product vocabulary, checked against the repo docs (`agent-swarm/docs-site/content/docs/`). Keep the reference's caption count and rhythm, not its words.

## Step 3 — collect real brand assets; never redraw

Copy, don't approximate. For Agent Swarm:

- **Mark**: `apps/ui/public/logo.png` in `desplega-ai/agent-swarm` (the hex mark; byte-identical to `docs-site/public/logo.png` and `https://agent-swarm.dev/logo.png`; verify with `sha256sum`). There is no logo SVG.
- **Wordmark**: "Agent Swarm", Space Grotesk 600, tracking -0.01em, near-white. If your project only vendors Space Grotesk 400/500/700, 600 renders as 700; say so if it matters.
- **Fonts**: Space Grotesk (display) + Space Mono (labels).
- **Colour**: amber-400 #fabc00, amber-300 #ffd237, zinc-950 #09090b, zinc-400 #9f9fa9 (amber-500 #f69e00 reads brown at low alpha). three.js wants hex: convert oklch tokens with culori (`formatHex(clampChroma(parse(x),'oklch'))`).
- **Feature icons**: the app's own lucide icons (`apps/ui/src/components/layout/app-sidebar.tsx`), e.g. Schedules = `ClockIcon`.

Keep the reference's grade (e.g. dark, low-key) and let the brand accent carry only the "live" elements, or the piece stops reading like the reference.

## Step 4 — build in your Remotion project

See `video-generation` for the project layout. New composition under `src/compositions/<Name>/`, registered in `src/Root.tsx`, timeline constants in a `timeline.ts` in frames. Land it as a draft PR; never merge.

For a 3D reference use `@remotion/three` + three.js + `postprocessing`. Traps that each cost an hour on the first run:

1. **GL backend**: only `--gl=swangle` works in worker containers (`angle`, `egl`, `swiftshader`, `vulkan` all fail "Error creating WebGL context").
2. **`@react-three/postprocessing` renders black under Remotion.** It builds its composer in a `useEffect`, after Remotion's single per-frame `advance()`. Build `postprocessing`'s `EffectComposer` yourself in a `useMemo` and render it from `useFrame(..., 1)`.
3. **Anything that loads async inside the canvas misses the frame.** Remotion advances R3F once per frame; a texture that lands after that is never captured. Preload outside `<ThreeCanvas>` behind `delayRender`, mount the canvas when ready.
4. **troika-three-text is invisible under swangle** (typesets, empty SDF atlas). Draw labels to a 2D canvas with the loaded webfont and use a `CanvasTexture` on a plane (`alphaTest` + `depthWrite` so DOF sees them). A 3-row texture with the text in the middle row makes a free mask for caption rolls (slide `texture.offset.y`).
5. **DOF focus is wrong unless you call `cocMaterial.adoptCameraSettings(camera)`** after changing near/far. Set `cocMaterial.focusDistance` / `focusRange` in world units per frame; scale `bokehScale` by `canvasWidth / 1920` so previews match the master.
6. **Transparent draw order**: a transparent dial surface drawn after an additive `depthWrite:false` element paints over it. Give the base surface `renderOrder={-10}` and effects a high one. Dynamic `BufferGeometry` needs `frustumCulled={false}` (its bounding sphere is computed once, from zeros).
7. **Render cost**: swangle saturates every core, so `--concurrency` beyond 2 buys nothing. MSAA and full-res DOF dominate (~2.6 s/frame with MSAA 4 + full-res DOF; with `multisampling: 0` and DOF `resolutionScale: 0.5` a 858-frame piece renders in ~7.5 min at 960x540 and ~8–9 min at 1080p). `--scale=0.333` fails (non-integer height); use 0.5 for previews.
8. **Font delayRender timeout**: `loadFont` in `src/theme/fonts.ts` can hold a delayRender that fires ~118 s into a long render and kills it. Pass `--timeout=3600000`, then check the outro frames actually use the brand font.
9. **Audio**: if your `remotion.config.ts` mutes the project, pass `--muted=false` and verify with `ffmpeg -i out.mp4` that an audio stream exists.
10. **Color range**: add `--color-space=bt709` or the mp4 comes out full-range `yuvj420p` (see `video-generation`).

Camera per shot = keyframed position/look/fov/focus in a pure `camAt(frame)` function, set inside `useFrame`. Express positions relative to the subject (radial out / tangential / up) so a shot survives geometry changes.

## Step 5 — build → look → critique, at least 3 rounds

Each round:

1. Render the whole piece at `--scale=0.5`.
2. Extract original and replica frames at the same ~12–14 timestamps (one per beat plus each transition) into one labelled side-by-side PNG sheet. A helper that does `grab(video, t)` via ffmpeg rawvideo + PIL paste is enough.
3. Open the sheet. Write down every difference, as concrete as "caption is 26% of frame width vs 38%", "ticks converge upward, reference converges downward ⇒ camera is inside the ring, move it past the centre".
4. Fix and re-render. For camera/framing fixes, render 3–5 stills (`remotion still --frame=N`) and compare them before paying for a full render.
5. Measure motion, not just frames: per-second median |Δ| at native fps (160x90 gray) for both clips. Stills can't show a camera that barely moves. On the first run a replica that matched every still was 80% frozen at 30 fps against the reference's 30%, because its drift was a third of the reference's.
6. Sample densely wherever the camera moves. Sparse beat sampling (one frame per beat, ~14 total) misses mid-beat geometry and focus defects: on the first run a flat ring pinching edge-on, a caption fully out of focus, and a caption running off the frame edge all sat between the sampled timestamps for 6 rounds. In camera-moving shots sample every 0.5s against the original at the same times, and for each caption check the middle of its hold: sharp, legible, and fully inside the frame. Draw hairline tracks as tubes (or screen-space lines), never flat annuli, so they cannot collapse at grazing angles.

Record each round's differences and fixes in the notes. That log is a deliverable. Expect 5–6 rounds for a 3D piece; the first two are mostly about getting anything on screen (see Step 4 traps).

## Step 6 — music and audio

Match the reference's measured audio (analysis Step 2). Pick a CC0 or CC BY track from a curated bank (or fetch one with the template's `fetch-music.sh`); don't generate. To choose, send the reference audio and 2 candidate 28s cuts to `google/gemini-3.8-flash` in one request and ask for a similarity rating. Level-match to the reference's mean volume (`volumedetect`), trim, fade, and credit the track. If nothing fits, ship silent and say so. No voiceover.

## Step 7 — master and deliverables

- Master at the reference's aspect and fps; if the reference is a downscaled delivery (e.g. 640x360), render a 1080p master and a reference-resolution copy.
- Side-by-side mp4 on one timeline, reference audio left channel, replica right:
  `ffmpeg -i ref.mp4 -i replica.mp4 -filter_complex "[0:v]scale=960:540,setsar=1[a];[1:v]scale=960:540,setsar=1[b];[a][b]hstack=inputs=2[v];[0:a][1:a]amerge=inputs=2,pan=stereo|c0<c0+c1|c1<c2+c3[aout]" -map "[v]" -map "[aout]" -c:v libx264 -crf 18 -c:a aac side-by-side.mp4`
- PNG comparison sheet from the final round.
- Frozen-frame fraction for both clips at 1 fps and native fps (160x90, mean |Δ| < 0.25/255 = frozen). The replica should sit in the reference's range. First run: reference 10.7% / 30.3%, final replica 17.9% / 37.7% (gap mostly in the outro cards).
- Upload binaries with `agent-fs write <path> --file <local>` (binary-safe) and check `agent-fs stat` sizes.

## Step 8 — judge: re-analyse the replica

Run `motion-design-video-analysis` Step 4 on **both** clips with the same prompt, model and timestamps (re-run the reference too; an old read used a different prompt). Put the two reads side by side (technique, easing, composition, transitions, vibe) and list where the model sees a difference. A 13-frame call can brush the 30s script cap; retry once before changing anything.

Read the differences as signal about the replica, not the model. First run: the model called the reference's opening "2D" but the replica's "3D" (the replica's depth cues were stronger than the reference's), and described the replica as "charcoal" with no mention of the reference's "negative space" (its macro shots were greyer). Both were real.

Then name the three weakest remaining spots yourself; the model's read is a second opinion, not the verdict.
