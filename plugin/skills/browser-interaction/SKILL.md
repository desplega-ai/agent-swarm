---
name: browser-interaction
description: Use agent-browser for website interaction, UI verification, screenshots, recordings, exploratory testing, and browser automation, with durable evidence uploaded to agent-fs.
---

# Browser Interaction

Use `agent-browser` for browser work: navigating websites, interacting with
forms, taking screenshots, recording video, extracting rendered data, and
testing web applications. Prefer it over built-in browser automation or web
fetch tools when the task needs a real browser.

Lead agents delegate UI verification to a worker. The worker drives the
browser and returns reproducible evidence; the lead should not operate the
browser itself.

## Bootstrap first

Run the persisted lazy installer before the first browser command in a task:

```bash
ensure-agent-browser
# agent-browser ready: cli 0.33.1, browser /path/to/chrome
```

The helper is idempotent and concurrency-safe. It installs the pinned CLI into
the persisted personal workspace, reuses the Chromium already present in the
full worker image, and downloads Chrome into persisted storage only when no
usable browser exists (for example, in a slim worker).

If bootstrap fails, stop and report its output. Do not retry with `sudo`, a
root-owned npm prefix, or `agent-browser@latest`.

## Start here

This skill is a discovery stub, not the usage guide. Before running browser
commands, load the version-matched workflow from the installed CLI:

```bash
agent-browser skills get core
agent-browser skills get core --full  # full command reference and templates
```

The CLI owns the command reference so these instructions cannot drift from the
installed version.

## Specialized workflows

Load a specialized skill when appropriate:

```bash
agent-browser skills get electron
agent-browser skills get slack
agent-browser skills get dogfood
agent-browser skills get derive-client
```

Run `agent-browser skills list` for the installed catalog. The independent
observability dashboard runs on port `4848`:

```bash
agent-browser dashboard start
```

## Capture and preserve evidence

Capture screenshots and video with the CLI's current command syntax:

```bash
agent-browser screenshot --full /tmp/task-page.png
agent-browser record start /tmp/task-flow.webm
# perform the interactions
agent-browser record stop
```

Upload PNG/WebM/MP4 bytes with `agent-fs write --file`. Never pipe a binary to
`--content` or otherwise decode it as text.

```bash
local_path=/tmp/task-page.png
remote_path="misc/<agent-id>/<task-id>/task-page.png"
org_id="<org-id>"
drive_id="<shared-drive-id>"

agent-fs --org "$org_id" --drive "$drive_id" write \
  "$remote_path" --file "$local_path" -m "browser QA evidence" --json

agent-fs --org "$org_id" --drive "$drive_id" stat "$remote_path" --json
context_json=$(agent-fs --org "$org_id" --drive "$drive_id" drive current --json)
: "${AGENT_FS_LIVE_URL:?AGENT_FS_LIVE_URL is required for share links}"
org_id=$(printf '%s' "$context_json" | jq -r '.orgId')
drive_id=$(printf '%s' "$context_json" | jq -r '.drive.id')
printf '%s/file/~/%s/%s/%s\n' \
  "$AGENT_FS_LIVE_URL" "$org_id" "$drive_id" "$remote_path"
```

Use the returned `orgId`, `driveId`, and path in a `store-progress` attachment
with `kind: "agent-fs"` so the evidence appears on the task. A human-clickable
link must use:

```text
${AGENT_FS_LIVE_URL}/file/~/<org_id>/<drive_id>/<path>
```

Never hardcode the live host.

## Swarm Page and UI verification

For a swarm-published page, load the `agent-swarm-page-branding` skill and
treat it as the brand gate: Agent Swarm tokens and light mode only. Verify at
both `1440x900` and `390x844`.

Do not rely on screenshots alone. Quote DOM-level evidence in the report:

- computed colors, font families, and relevant CSS custom-property tokens;
- `document.fonts.check(...)` results for required fonts;
- the actual axis-tick text arrays for every chart;
- console errors and failed resources;
- before/after state for each interaction.

For example, adapt selectors to the page and record the returned values:

```bash
agent-browser eval '({
  background: getComputedStyle(document.body).backgroundColor,
  foreground: getComputedStyle(document.body).color,
  font: getComputedStyle(document.body).fontFamily,
  primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
  spaceGrotesk: document.fonts.check("16px \"Space Grotesk\""),
  ticks: [...document.querySelectorAll(".tick text")].map((node) => node.textContent)
})'
```

Element refs are snapshots, not permanent selectors. Calling `click "@ref"` a
second time after the DOM changed can silently no-op and produce a false
negative. Re-snapshot between interactions and use the new ref.

## Why agent-browser

- Fast native CLI with Chrome/Chromium over CDP.
- No Playwright or Puppeteer runtime dependency.
- Compact accessibility-tree snapshots and element refs.
- Sessions, state persistence, screenshots, recording, and observability.
