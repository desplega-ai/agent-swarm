# Release Recorder

On-demand recording driver for the agent-swarm release video pipeline.

Reads a `storyboard.json`, launches `agent-browser` for each beat, and writes
raw `.webm` clips to `raw/`. The raw clips are then handed to a `video-use`
session for editing, transcription, voiceover, and brand wrap.

---

## Quick start

```bash
# 1. Spin up demo stack (API + UI + seeded fixtures)
bin/reset-demo-stack.sh

# 2. Copy the sample storyboard (or generate one from a tag)
cp assets/release-recorder/storyboard.sample.json assets/release-recorder/storyboard.json

# 3. Record
cd assets/release-recorder
bun run.ts

# Clips land in: assets/release-recorder/raw/beat-0.webm, beat-1.webm, ...
```

---

## Storyboard schema

```json
{
  "version": "1.80.0",
  "summary": "one-line description shown in logs",
  "beats": [
    {
      "title": "Human-readable clip title",
      "prNumber": 504,
      "prUrl": "https://github.com/desplega-ai/agent-swarm/pull/504",
      "demo_script_id": "create-task",
      "vo_line": "Voiceover text for this beat (used by video-use ElevenLabs step)"
    }
  ]
}
```

`demo_script_id` maps to `scripts/<id>.ts`. Picateclas's `bin/storyboard-from-tag.ts`
generates `storyboard.json` automatically from a Git tag range.

---

## Demo scripts

Each script in `scripts/` exports a single default async function that drives
`agent-browser` commands against the local swarm UI (`http://localhost:5274`).

| Script | What it shows | Runtime |
|--------|---------------|---------|
| `create-task.ts` | Create a new task from the UI, watch it appear in the list | ~15-20s |
| `workflow-run.ts` | Open a workflow, view the DAG, trigger a run | ~15-20s |
| `schedule.ts` | Browse to a schedule, show cron expression + task template | ~12-18s |

**Best practices for writing scripts:**
- Add `await sleep(500)` after each interaction — gives the UI time to react and gives viewers a readable frame.
- Use role/text selectors (`find role button "…"`) rather than CSS selectors — more resilient to styling changes.
- Chain `.quiet().catch(() => {})` on optional actions that may not be present in all seeded states.
- Keep each script to 10-25s. Longer clips make editing harder.
- Add an EXIT-trap in `run.ts` — already handled globally; scripts don't need to worry about it.

---

## Environment variables

| Var | Default | Notes |
|-----|---------|-------|
| `SWARM_UI_URL` | `http://localhost:5274` | Override if UI runs on a different host/port |

---

## Directory layout

```
assets/release-recorder/
  run.ts                  Driver — reads storyboard, records per beat
  storyboard.json         Active storyboard (gitignored)
  storyboard.sample.json  Example fixture committed to the repo
  scripts/
    create-task.ts        Beat: create and view a task
    workflow-run.ts       Beat: workflow definition + run
    schedule.ts           Beat: browse a schedule
  raw/                    Output clips (gitignored)
    beat-0.webm
    beat-1.webm
    ...
```

---

## Cursor-track pipeline (v2)

The recorder emits a `cursor-track.json` file alongside each `.webm` clip. The
Remotion composition (`SwarmDemo.tsx`) reads it and replays the exact cursor
positions frame-accurately — no synthesized waypoints.

### What gets recorded

`record-e2e.ts` captures cursor events using `agent-browser`:

```typescript
// Get element center
const box = JSON.parse(await $`agent-browser get box ${selector}`.text());
const cx = Math.round(box.x + box.width / 2);
const cy = Math.round(box.y + box.height / 2);

// Move cursor (realistic approach: arrive 200-400ms before click)
await $`agent-browser mouse move ${cx} ${cy}`;
cursorEvents.push({ tsMs: Date.now() - recordingStartTs, x: cx, y: cy, action: "move" });

// Click
await $`agent-browser mouse click ${cx} ${cy}`;
cursorEvents.push({ tsMs: Date.now() - recordingStartTs, x: cx, y: cy, action: "click" });
```

The emitted `cursor-track.json` schema (TypeScript types in `src/cursor-track.ts`):

```json
{
  "version": "1",
  "durationMs": 22500,
  "viewport": { "width": 1920, "height": 1080 },
  "theme": "light",
  "events": [
    { "tsMs": 1200, "x": 760, "y": 340, "action": "move" },
    { "tsMs": 1450, "x": 760, "y": 340, "action": "click" }
  ]
}
```

### Browser defaults (v2)

| Setting | Default | Override |
|---------|---------|---------|
| Resolution | **1920×1080** | `--width N --height N` CLI flags |
| Theme | **light** | Pass `--theme dark` (injects `localStorage.theme=dark`) |

### Using the cursor-track in Remotion

1. After recording, a `<beat>-cursor.json` file lands in `raw/` alongside `<beat>.webm`.
2. Copy it to `assets/video-source/src/fixtures/cursor-track.json`.
3. `SwarmDemo.tsx` imports it as the cursor fixture — real positions, cubic-eased playback.
4. `sample-cursor-track.json` ships as a committed fallback so the composition
   always has valid data even without a fresh recording run.

### Timing contract

- Cursor moves arrive **200-400ms before** the click event (natural hand approach)
- Lower-thirds fire **~100ms after** the event renders on screen (not at the click frame)
- `Cursor.tsx` interpolates between events with `easeOutCubic` — no choppy linear jumps

---

## Full pipeline

1. **Storyboard** — `bin/storyboard-from-tag.ts vX.Y.Z` → `storyboard.json` *(Picateclas)*
2. **Reset stack** — `bin/reset-demo-stack.sh` → API + UI with seeded fixtures
3. **Record** — `bun assets/release-recorder/record-e2e.ts` → `raw/*.webm` + `raw/*-cursor.json`
4. **Copy fixture** — `cp raw/swarm-demo-cursor.json assets/video-source/src/fixtures/cursor-track.json`
5. **Edit** — open a Claude Code session with the `video-use` skill, point it at `raw/` + `storyboard.json` for VO lines
6. **Render** — `cd assets/video-source && npx remotion render SwarmDemo out/swarm-demo-final.mp4`
7. **Brand wrap** — `SwarmDemo.tsx` (intro + demo + outro) already ships the brand wrap
8. **Publish** — `gh release upload vX.Y.Z out/swarm-demo-final.mp4`

---

## Sharing outputs — binary files

**Never pipe `.webm` or `.mp4` files through `agent-fs write`.** The `agent-fs`
CLI accepts text only; binary data is UTF-8-mangled on write (non-ASCII bytes
become `ef bf bd` replacement chars) and the resulting file is unplayable —
ffmpeg rejects it with "EBML header parsing failed".

Instead, share binary outputs by:

- **Slack**: `slack-upload-file` (binary-safe, inline playback in Slack clients)
- **GitHub release**: `gh release upload vX.Y.Z final.mp4`

If you need to park a clip somewhere for a short-lived review link, upload to
Slack and share the Slack permalink — do not route it through agent-fs.
