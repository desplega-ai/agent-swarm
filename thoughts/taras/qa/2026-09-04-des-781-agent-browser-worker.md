---
date: 2026-09-04
topic: "DES-781: agent-browser replaces qa-use in the worker image"
status: pass
---

# QA: agent-browser in the worker image (DES-781)

Local swarm-local-e2e run against the images built from branch `des-781-agent-browser-worker`.

## Setup

- agent-fs 0.13.5 + MinIO from `docker-compose.local.yml` (`docker compose -f docker-compose.local.yml up -d agent-fs`), reachable at `localhost:7433`.
- API from the worktree: fresh SQLite, `AGENT_FS_API_URL=http://localhost:7433`, Slack/GitHub/Linear/Jira/GitLab disabled. The boot seeder self-registered the API's agent-fs account (`created=1`).
- Full worker: `agent-swarm-worker:latest` (built from the branch), agent `cb82b832-c222-403e-8d47-dd2cb4d55167`, `HARNESS_PROVIDER=claude`, `AGENT_FS_API_URL=http://host.docker.internal:7433`.
- Slim worker: `agent-swarm-worker:slim` (built from the branch), agent `4986ceea-21d5-4bdb-af9e-e9395fa1adef`, same env.
- Task text (assigned by `agentId` to each worker): open `https://example.com` with the agent-browser skill, screenshot, upload to agent-fs under `thoughts/<agent-id>/qa/example-com-screenshots/example-com.png`, put the signed URL in `store-progress`, attach with `kind: "agent-fs"`, fall back to a manual description if agent-browser is missing.

## Full image: task `70597cf8-c94d-4fa0-8136-e9fc012571d5`

| Check | Result |
|---|---|
| Task status | `completed`, 0 session-log rows flagged as error |
| Session logs contain `command -v agent-browser`, `agent-browser skills get core`, `agent-browser open https://example.com`, `agent-browser screenshot`, `agent-browser close` | yes |
| Session logs contain `agent-fs write` and `agent-fs signed-url` | yes |
| `store-progress` attachment | `kind: "agent-fs"`, `mimeType: image/png`, `sizeBytes: 18245`, path `thoughts/cb82b832-.../qa/example-com-screenshots/example-com.png` |
| `agent-fs stat <path> --json` with the worker's provisioned credentials | `contentType: image/png`, `size: 18245`, `isDeleted: false` |
| Signed URL in the report downloads from the Mac | HTTP 200, `content-type: image/png`, 18245 bytes, PNG signature ok, renders the example.com page |

Screenshot copied to Taras's agent-fs for the PR: `qa/agent-swarm/2026-09-04-des-781-agent-browser/example-com-full-worker.png` (7-day signed URL in the PR body).

A first run of the same task on the same worker (`7220a961-4d16-4c46-ae65-41a8fc523258`) had the browser leg pass and the upload leg fail with "Not logged in". Cause: the worker booted with a brand-new agent ID on a fresh DB, and the boot-time `POST /api/fs/agent-credentials` ran before the agent row existed (`Agent not found`), so no per-agent key was provisioned and the runner does not retry. Restarting the container with the same agent ID provisioned the key (`[agent-fs] created agent-scoped credentials`) and the second run passed. Pre-existing behaviour, not touched by this branch.

## Slim image: task `be5f8062-11d0-420c-bcc8-617f4fa5a594`

| Check | Result |
|---|---|
| Task status | `completed`, 0 session-log rows flagged as error, no `failureReason` |
| `command -v agent-browser` ran first | yes (13 mentions in the logs) |
| Worker said the CLI is absent and fell back | yes: "`agent-browser` is not installed on worker-4986ceea (slim image)", wrote a manual-fallback doc, marked the browser test cases **Blocked (not failed)**, listed the exact commands a full-image worker should run |

## Image facts

| | before (main) | after (branch) |
|---|---|---|
| `agent-swarm-worker` full | 4,302,660,082 B (4.30 GB) | 4,300,367,177 B (4.30 GB) after the review-driven single-arch prune; 4,312,828,585 B on the build the E2E ran against |

Inside the after image: `/usr/local/bin/agent-browser` (0.31.1), no `qa-use`, `/opt/playwright/chromium -> /opt/playwright/chromium-1208/chrome-linux/chrome`, `AGENT_BROWSER_EXECUTABLE_PATH` and `AGENT_BROWSER_ARGS` set, `node_modules/agent-browser` 11 MB (only the `TARGETARCH` Linux binary kept; the E2E build still carried both Linux binaries, 23 MB), no `~/.claude/skills/qa-use`, runtime smoke as `worker` produces a PNG.
