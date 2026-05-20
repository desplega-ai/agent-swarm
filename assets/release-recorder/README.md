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

## Full pipeline

1. **Storyboard** — `bin/storyboard-from-tag.ts vX.Y.Z` → `storyboard.json` *(Picateclas)*
2. **Reset stack** — `bin/reset-demo-stack.sh` → API + UI with seeded fixtures
3. **Record** — `bun assets/release-recorder/run.ts` → `raw/*.webm`
4. **Edit** — open a Claude Code session with the `video-use` skill, point it at `raw/` + `storyboard.json` for VO lines
5. **Brand wrap** — `ReleaseShell` Remotion composition adds title card, lower-thirds, outro *(Picateclas)*
6. **Publish** — `gh release upload vX.Y.Z final.mp4`
