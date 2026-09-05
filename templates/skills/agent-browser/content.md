# agent-browser

`agent-browser` (vercel-labs) is the swarm's browser-automation CLI. It drives a headless Chromium over CDP and returns accessibility-tree snapshots with compact `@eN` refs. Use it for any browser task: verify a UI change, take a screenshot, walk a page, fill a form, extract page text, reproduce a frontend bug, or attach UI evidence to a PR, issue, Linear comment, or Slack thread.

Do not use `qa-use`. It is not installed in the worker image any more.

## Step 0: check that the CLI is present

The full worker image (`agent-swarm-worker:latest`) ships `agent-browser` and a headless Chromium. The slim image (`:slim`) has neither. The first command of any browser work is:

```bash
command -v agent-browser
```

If it prints nothing, you are on the slim image. Say so in your progress report ("agent-browser is not available on this worker image") and fall back to manual QA: write the exact steps a human should run and mark the browser test cases as **Blocked**, not failed. Do not install a browser or the CLI yourself.

## Step 1: load the version-matched guide

The CLI bundles its own usage guide. Load it once per task before the first browser command. Do not guess flags from memory.

```bash
agent-browser skills get core          # overview + common patterns
agent-browser skills get core --full   # adds the full command reference
agent-browser skills list              # specialized guides (dogfood, electron, slack, ...)
```

## Step 2: the core loop

```bash
agent-browser open <url>
agent-browser snapshot -i              # accessibility tree, interactive elements only, @eN refs
agent-browser click @e12               # act on refs from the snapshot
agent-browser fill @e7 "text"
agent-browser screenshot /tmp/<name>.png
agent-browser close
```

- Re-run `snapshot` after every navigation or state change. Refs are only valid for the snapshot that produced them.
- Run one browser session at a time. Call `store-progress` between page batches so the heartbeat watchdog sees you.
- The browser is headless. Local servers inside the worker container are reachable at `http://localhost:<port>`.
- The image launches Chromium with `--no-sandbox,--disable-dev-shm-usage` through `AGENT_BROWSER_ARGS`. If you pass your own `--args`, include `--no-sandbox` again or Chrome will not start.

## Step 3: share the screenshot through agent-fs

Screenshots on the worker disk disappear with the task. Upload them to agent-fs under the qa path convention and share the signed URL. `--file` is binary-safe. `--content` is text-only and mangles PNGs.

```bash
agent-fs write thoughts/<agent-id>/qa/<topic>-screenshots/<name>.png \
  --file /tmp/<name>.png -m "<what it shows>"
agent-fs stat thoughts/<agent-id>/qa/<topic>-screenshots/<name>.png --json        # confirm size > 0
agent-fs signed-url thoughts/<agent-id>/qa/<topic>-screenshots/<name>.png --json  # 24h default, --expires-in up to 7d
```

- Embed the URL as `![caption](<url>)` in the PR body, review comment, Linear comment, or Slack message.
- In `store-progress`, list the upload in the `attachments` field with `kind: "agent-fs"` and the path, and paste the signed URL in the progress text.
- If `agent-fs auth whoami` fails, report the local path, say the upload was skipped, and continue.

The `artifacts` skill holds the full agent-fs recipe and the naming conventions.
