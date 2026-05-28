# Artifacts

Artifacts are files, screenshots, recordings, logs, and reports that outlive a session and can be referenced by other agents, humans, or future tasks. The agent-swarm supports two artifact stores: **agent-fs** (structured, searchable, shareable) and the **shared workspace filesystem** (`/workspace/shared/`).

## When to Create Artifacts

- Your task produces a deliverable humans should review (report, screenshot, recording, data export).
- Another agent or future session needs to pick up where you left off.
- You want to attach evidence to a PR, Linear ticket, or Slack message.
- The output is too large for `store-progress.output`.

## Agent-fs (Preferred for Human-Shareable Artifacts)

agent-fs is a persistent, searchable file system shared across the swarm.

```bash
# Write to personal drive
agent-fs write thoughts/research/2026-05-28-topic.md --content "..." -m "description"

# Write to shared drive (humans + other agents can see)
agent-fs --org 648a5f3c-35c8-4f11-8673-b89de52cd6bd write \
  thoughts/c06cca59-187e-4aa6-8472-8ac6caf177af/research/2026-05-28-topic.md \
  --content "..." -m "research findings"
```

Verify the write succeeded (agent-fs writes can fail silently with empty payloads):
```bash
agent-fs stat <path> --json | jq '.size'
# If size < 200 bytes on a non-trivial artifact, the write FAILED — re-do it.
```

### Sharing agent-fs files with humans

Build the URL from the live host env var:
```
${AGENT_FS_LIVE_URL}/file/~/<org_id>/<drive_id>/<file_path>
```

`AGENT_FS_LIVE_URL` defaults to `https://live.agent-fs.dev`. Get `org_id` and `drive_id` from `agent-fs stat <path> --json`.

## Shared Filesystem

For non-text artifacts or files other agents need to access during the same session:

- `/workspace/shared/downloads/<agent-id>/` — downloaded files
- `/workspace/shared/misc/<agent-id>/` — other shared files

## Binary Artifacts (PNG, MP4)

**agent-fs write is text-only and mangles binaries** (inserts UTF-8 replacement characters). For PNG/MP4 uploads use the binary upload path:

```bash
# Use binary-safe upload, NOT agent-fs write
# For QA screenshots: use qa-use's built-in screenshot capture
# For custom screenshots: Playwright, ffmpeg, or system screenshot tools
```

For QA screenshots attached to PRs, see the QA evidence convention in TOOLS.md.

## Naming Conventions

Name paths predictably by task, date, and artifact type:

```
thoughts/<agent-id>/research/YYYY-MM-DD-<topic>.md
thoughts/<agent-id>/plans/YYYY-MM-DD-<topic>.md
thoughts/<agent-id>/qa/<topic>-screenshots/<filename>.png
misc/<agent-id>/<task-id>-<description>.ext
```

## Attaching Artifacts

- **PR body:** Embed `![caption](live.agent-fs.dev/file/~/...)` image URLs as markdown.
- **Slack messages:** Link to agent-fs URLs (they're public, no auth required).
- **`store-progress`:** Use the `attachments` field with `kind: "agent-fs"` and the path.
- **Linear comments:** Paste the live.agent-fs.dev URL in the comment body.

## What NOT to Store in Artifacts

- Secrets, API keys, OAuth tokens
- Raw customer data without approval
- Oversized files without approval (check file size before uploading)
- Ephemeral progress notes (put those in `store-progress.progress` instead)

## Trade-offs

**agent-fs vs shared filesystem:** agent-fs is persistent, versioned, and searchable across sessions. The shared filesystem is faster for same-session handoffs between agents but doesn't survive container restarts. Use agent-fs for anything that needs to outlive the current session or be reviewed by humans.
