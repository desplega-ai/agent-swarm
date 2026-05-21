# Release Recorder

On-demand pipeline for the agent-swarm release demo video.

**Current cut: v6** — People-tab demo, DOM cursor baked into recording, native speed,
50.7s total (3s intro + 43.2s demo + 4.5s outro).

---

## Overview

The pipeline has three stages:

```
record-e2e-v6.mjs          Remotion render               ffmpeg (inside Remotion)
─────────────────   →   ───────────────────────   →   ───────────────────────────
Playwright records 5        SwarmDemo composition         Final MP4
segmented WebM beats        wraps raw footage in           out/swarm-demo-v6.mp4
with DOM cursor baked       mac-chrome, intro/outro,
into each frame             lower-thirds, music bed
```

### Why segmented beats?

Each beat records a fresh Playwright browser context. This eliminates carry-over
UI state (hover highlights, scroll position, stale React state) between scenes.
The recording script stitches them into a single continuous `.mp4` via ffmpeg concat
before handing off to Remotion.

---

## Prerequisites

1. **Local agent-swarm stack** running at their default URLs:
   - API: `http://localhost:3013`
   - UI: `http://localhost:5274`

   Start with: `bun run pm2-start` (or `bun run start:http` + `cd ui && pnpm dev` separately).

2. **Demo seed data** — Ada Sandoval user with 4 linked identities and 12 activity events:

   ```bash
   MCP_BASE_URL=http://localhost:3013 bun run seed:people
   ```

   Ada's user ID is hard-coded as `7f944e82787b481bb78d4c20d12b1fa3`.
   The seed script is idempotent — safe to re-run.

3. **ffmpeg and ffprobe** in `$PATH` (or override via `FFMPEG_BIN`).

4. **Playwright Chromium** at `/opt/playwright/chromium-1208/chrome-linux64/chrome`.
   Install if missing: `npx playwright install chromium`.

5. **Node.js 18+** (the script uses top-level `await`).

---

## How to generate the video

### Step 1 — Record the beats

```bash
cd assets/release-recorder
node record-e2e-v6.mjs
```

The script:
- Runs a preflight health check against the API and UI.
- Records 5 beats sequentially, each as its own `.webm` file in `raw/`.
- Stitches them into `raw/swarm-demo.mp4` (no speedup — native playback).
- Writes `raw/e2e-demo-cursor.json` (used for the zoom effect in Remotion).
- **Auto-updates** three Remotion source files with the actual beat durations
  (see [Auto-propagation](#auto-propagation) below).
- Copies `raw/swarm-demo.mp4` → `assets/video-source/public/swarm-demo.mp4`.
- Copies `raw/e2e-demo-cursor.json` → `assets/video-source/src/cursor-track.json`.

Expected output (v6 timings):

```
🔴 [navigate-people]  ⏹  7.6s — N events
🔴 [scan-list]        ⏹  7.2s — N events
🔴 [open-person]      ⏹  9.0s — N events
🔴 [linked-identities]⏹  8.6s — N events
🔴 [activity-timeline]⏹ 10.8s — N events

Total demo: 43.2s = 1296 frames
Total composition: 50.7s = 1521 frames
```

### Step 2 — Render the Remotion composition

```bash
cd assets/video-source
npm install        # or bun install — installs remotion + deps
npx remotion render src/index.ts SwarmDemo out/swarm-demo-v6.mp4
```

The final MP4 lands at `assets/video-source/out/swarm-demo-v6.mp4`.

### Step 3 — Share the output

**Never** pipe `.mp4` or `.webm` through `agent-fs write` — the CLI is text-only
and will silently corrupt binary content (non-ASCII bytes become `ef bf bd`).

Share via:
- **Slack**: `slack-upload-file` (binary-safe, inline playback).
- **GitHub release**: `gh release upload vX.Y.Z out/swarm-demo-v6.mp4`.

---

## Architecture

### DOM cursor injection

The cursor SVG is baked directly into every captured frame, not composited in
post. This ensures the cursor is always pixel-accurate and never desyncs from the
UI animation.

Mechanism: `context.addInitScript(pageInitScript, args)` injects a self-contained
script before any page JavaScript runs. The injected script:

- Sets `localStorage` auth tokens, active connection, and `agent-swarm-mode: light`
  before React reads them (no re-renders or double-navigation).
- Appends a `div#rec-cursor` fixed-position element with an SVG cursor path,
  and a `div#rec-cursor-ring` for the amber click-ripple animation.
- Injects `* { cursor: none !important; }` to hide the OS cursor.
- Starts a `requestAnimationFrame` loop that moves `div#rec-cursor` using
  easeOutCubic tweening.
- Exposes `window.__rc.{ moveTo(x, y, durationMs), setPos(x, y), click(x, y) }`.
- Uses a `MutationObserver` to re-inject the cursor div if React unmounts `body`.

### Per-beat recording

Each beat in `recordBeat(label, startUrl, fn)`:

1. Launches a fresh Playwright Chromium browser + context (with `recordVideo`).
2. Attaches the `addInitScript` so auth/cursor code runs on every navigation.
3. Opens the start URL and waits for `domcontentloaded` + 1.2s hydration hold.
4. Runs the choreography function `fn(page, moveTo, click, track)`.
5. Calls `moveTo(x, y, durationMs)` which drives both the DOM cursor
   (`window.__rc.moveTo`) and the real Playwright mouse (for hover effects).
6. Holds 400ms at beat end, closes page/context/browser, waits 600ms for the
   WebM to flush.
7. Renames the recorded file to `raw/beat-{label}.webm`.
8. Measures actual duration via `ffprobe` (falls back to ffmpeg `-f null`).

### cursor-track.json

After recording, `cursor-track.json` aggregates all beat events with cumulative
time offsets. In v6 this file drives **only the zoom effect** in `SceneDemo.tsx`
— the `Cursor.tsx` overlay is retired. `computeZoom()` reads click events,
applies an 8% scale-up centred on the click point, then eases back over 24 frames.

### Remotion composition structure

```
Root.tsx
└── SwarmDemo (1521 frames = 50.7s @ 30fps)
    ├── Sequence 0–90      → SceneIntro    (3s)  — wordmark fade-in
    ├── Sequence 90–1386   → SceneDemo     (43.2s) — video + zoom + lower-thirds
    └── Sequence 1386–1521 → SceneOutro    (4.5s) — wordmark + agent-swarm.dev
```

`SceneDemo` renders the raw `swarm-demo.mp4` inside a mac-chrome window
(1760×1026, centred in 1920×1080), applies the zoom transform from
`computeZoom()`, and overlays lower-thirds captions.

### Auto-propagation

After recording, the script auto-patches three source files using regex
replacement so Remotion stays in sync without manual edits:

| File | What changes |
|------|-------------|
| `SceneDemo.tsx` | `DEMO_FRAME_COUNT`, fadeOut interpolation range, `LOWER_THIRDS` array |
| `SwarmDemo.tsx` | `<SceneDemo>` `durationInFrames`, `<SceneOutro>` `from` offset |
| `Root.tsx` | `<SwarmDemo>` `durationInFrames` |

### Beat layout (v6)

| # | Label | Start URL | What it shows | Duration |
|---|-------|-----------|---------------|----------|
| 1 | `navigate-people` | `/people` | People grid, page heading pan | 7.6s |
| 2 | `scan-list` | `/people` | Row-by-row cursor scan (3 rows × 2 columns) | 7.2s |
| 3 | `open-person` | `/people` | Click Ada row → navigate to profile | 9.0s |
| 4 | `linked-identities` | `/people/{id}` | Right-rail identity badges (Slack/GitHub/Linear/GitLab) | 8.6s |
| 5 | `activity-timeline` | `/people/{id}` | Scroll down, scan 3 event rows | 10.8s |

### Lower-thirds captions

```
Beat 1 (navigate-people)  → "People tab — humans as first-class users"
Beat 2 (scan-list)        → "Real identities, not just agent IDs"
Beat 3 (open-person)      → (none — navigation beat)
Beat 4 (linked-identities)→ "Linked identities across every system"
Beat 5 (activity-timeline)→ "Full activity timeline"
```

Captions fire 21 frames (0.7s) after each beat starts and end 21 frames before
each beat ends. The `CAPTIONS` array in `record-e2e-v6.mjs` controls copy — edit
it and re-run the script; `LOWER_THIRDS` in `SceneDemo.tsx` is auto-updated.

---

## How to change things

### Edit the beat choreography

Each beat's mouse path is a closure inside `record-e2e-v6.mjs`. Look for
`beats.push(await recordBeat('label', url, async (page, moveTo, click) => {`.
`moveTo(x, y, durationMs)` takes pixel coordinates (1920×1080 space).
`click(x, y)` moves then clicks with a ripple animation.

### Edit captions

Find `const CAPTIONS = [...]` near the bottom of `record-e2e-v6.mjs`.
`null` means no caption for that beat. Re-run the script — `SceneDemo.tsx` is
auto-updated.

### Change the version badge

Edit `SceneIntro.tsx` (`assets/video-source/src/scenes/swarm-demo/SceneIntro.tsx`).

### Change intro / outro copy

Edit `SceneIntro.tsx` and `SceneOutro.tsx` in the same directory.

### Change the music bed

Replace `assets/video-source/public/audio/montauk-point.mp3` and update the
`<Audio src={...}>` reference in `SwarmDemo.tsx`. Current volume: 0.10.

### Change demo seed data

Edit `scripts/seed-people.ts` and re-run `bun run seed:people`.
Ada Sandoval's ID (`7f944e82787b481bb78d4c20d12b1fa3`) is hard-coded in
`record-e2e-v6.mjs` — update `ADA_ID` if you reseed with a different user.

### Full re-record

Re-run `node record-e2e-v6.mjs` any time the UI changes.
The script is idempotent — it overwrites existing beat files in `raw/`.

---

## Known issues / future polish

These are **deferred** — not blockers for merging v6.

| Issue | Detail |
|-------|--------|
| Loading-screen frames visible | Some beats show a brief loading state at the start before content renders. The recorder waits for `domcontentloaded` + a fixed sleep, but content-ready detection is not pixel-perfect. Fix: use `page.waitForSelector()` on a stable content element, or apply a CSS opacity mask at beat start. |
| Total runtime ~50s | Target was 30–35s. The v6 cut is deliberate (native speed, no setpts speedup), but the dwells could be tightened and one beat could be dropped to shorten. |
| Music bed starts at full volume | No fade-in. Add Remotion `<Audio startFrom>` or a volume interpolation for a smoother open. |
| No VO track | `SwarmDemo.tsx` has a commented-out `<Audio vo>` slot. Drop a generated VO mp3 at `public/audio/vo.mp3` and uncomment. |

---

## Environment variables

| Var | Default | Notes |
|-----|---------|-------|
| `SWARM_UI_URL` | `http://localhost:5274` | UI host/port override |
| `SWARM_API_URL` | `http://localhost:3013` | API host/port override |
| `API_KEY` | `123123` | Auth key for localStorage injection |
| `FFMPEG_BIN` | `ffmpeg` | Path to ffmpeg binary |

---

## Directory layout (v6)

```
assets/release-recorder/
  record-e2e-v6.mjs       Active recording script (v6)
  record-e2e-v5.mjs       Previous version (kept for reference)
  record-e2e.ts           Original Bun/agent-browser version (v1-v3)
  raw/
    beat-navigate-people.webm
    beat-scan-list.webm
    beat-open-person.webm
    beat-linked-identities.webm
    beat-activity-timeline.webm
    swarm-demo.mp4         Stitched MP4 (auto-copied to video-source/public/)
    e2e-demo-cursor.json   Cursor events (auto-copied to video-source/src/cursor-track.json)

assets/video-source/
  public/
    swarm-demo.mp4         Source footage for Remotion
    audio/montauk-point.mp3  Music bed
  src/
    Root.tsx               Remotion root — registers SwarmDemo composition
    compositions/
      SwarmDemo.tsx        Top-level: intro + demo + outro sequences
    scenes/swarm-demo/
      SceneDemo.tsx        Main demo scene: video + zoom + lower-thirds
      SceneIntro.tsx       Opening 3s: wordmark fade-in
      SceneOutro.tsx       Closing 4.5s: wordmark + site URL
      Cursor.tsx           Cursor overlay (retired in v6 — kept for reference)
    cursor-track.json      Click events for zoom effect
```
