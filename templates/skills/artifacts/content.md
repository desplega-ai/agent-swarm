# Artifacts

An artifact is any output that should outlive the session — a report,
screenshot, recording, log, data export, dashboard. There are two things you
can do with one, and this skill covers both:

- **Store it** — write it to agent-fs or the shared workspace so humans and
  other agents can find it later. This is the common case.
- **Serve it** — run a real web server behind a public, auth-protected URL so a
  human can *interact* with it (custom routes, form posts, live data).

| You need… | Use |
|---|---|
| A file, report, screenshot, or export someone will read later | **Store** (agent-fs) |
| A file another agent needs during *this* session | **Store** (`/workspace/shared/`) |
| A static HTML/JSON report shared by URL | The **`pages`** skill — cheaper, no process to babysit |
| Custom routes, websockets, file uploads, per-request computation | **Serve** (below) |

Rule of thumb: if the content is a *snapshot*, store it or make a page. If it's
a *running program*, serve it.

---

# Part 1 — Storing artifacts

Two stores: **agent-fs** (structured, searchable, shareable, survives restarts)
and the **shared workspace filesystem** (`/workspace/shared/`, fast, same-session).

## When to create one

- Your task produces a deliverable humans should review.
- Another agent or future session needs to pick up where you left off.
- You want to attach evidence to a PR, Linear ticket, or Slack message.
- The output is too large for `store-progress.output`.

## agent-fs (preferred for anything human-shareable)

```bash
# Write to your personal drive
agent-fs write thoughts/research/2026-05-28-topic.md --content "..." -m "description"

# Write to the shared drive (humans + other agents can see it)
agent-fs --org <org-id> write \
  thoughts/<agent-id>/research/2026-05-28-topic.md \
  --content "..." -m "research findings"
```

Your org and drive context is already configured — you only need `--org` when
writing somewhere other than your default. Read the id from
`agent-fs stat <path> --json` rather than hardcoding one you saw in an example.

Always verify the write landed — agent-fs writes can fail silently with an
empty payload:

```bash
agent-fs stat <path> --json | jq '.size'
# If size < 200 bytes on a non-trivial artifact, the write FAILED — re-do it.
```

### Sharing agent-fs files with humans

The deployment configures the live viewer host through `AGENT_FS_LIVE_URL`; the
documented fallback is `https://live.agent-fs.dev`. Resolve it in the shell and
combine it with the `orgId` and `driveId` returned by `agent-fs stat`:

```bash
FILE_PATH='thoughts/<agent-id>/research/<file>.md'
AGENT_FS_HOST=${AGENT_FS_LIVE_URL:-https://live.agent-fs.dev}
FILE_STAT=$(agent-fs stat "$FILE_PATH" --json)
ORG_ID=$(printf '%s' "$FILE_STAT" | jq -r '.orgId')
DRIVE_ID=$(printf '%s' "$FILE_STAT" | jq -r '.driveId')
SHARE_URL="${AGENT_FS_HOST%/}/file/~/$ORG_ID/$DRIVE_ID/$FILE_PATH"
printf '%s\n' "$SHARE_URL"
```

Paste the printed concrete URL into Markdown or a message. Markdown does not
expand environment variables.

## Shared filesystem

For non-text artifacts or files other agents need during the same session:

- `/workspace/shared/downloads/<agent-id>/` — downloaded files
- `/workspace/shared/misc/<agent-id>/` — other shared files

It does **not** survive container restarts. Anything that must outlive the
session goes to agent-fs.

## Binary artifacts (PNG, MP4)

**`agent-fs write` is text-only and mangles binaries** (it inserts UTF-8
replacement characters). Use a binary-safe upload path instead:

- QA screenshots → use `qa-use`'s built-in screenshot capture, which uploads
  correctly on your behalf.
- Custom captures → Playwright, ffmpeg, or a system screenshot tool, then
  upload via the binary path rather than `agent-fs write`.

## Naming conventions

Name paths predictably by task, date, and artifact type:

```
thoughts/<agent-id>/research/YYYY-MM-DD-<topic>.md
thoughts/<agent-id>/plans/YYYY-MM-DD-<topic>.md
thoughts/<agent-id>/qa/<topic>-screenshots/<filename>.png
misc/<agent-id>/<task-id>-<description>.ext
```

## Attaching artifacts

- **PR body** — embed `![caption](<resolved-share-url>)` after resolving and
  printing the concrete URL as shown above.
- **Slack** — link the agent-fs URL (public, no auth required).
- **`store-progress`** — use the `attachments` field with `kind: "agent-fs"` and the path.
- **Linear comments** — paste the live URL in the comment body.

## What NOT to store

- Secrets, API keys, OAuth tokens
- Raw customer data without approval
- Oversized files without approval (check size before uploading)
- Ephemeral progress notes — those go in `store-progress.progress`

## Trade-offs

**agent-fs vs shared filesystem** — agent-fs is persistent, versioned, and
searchable across sessions. The shared filesystem is faster for same-session
handoffs but doesn't survive container restarts. Use agent-fs for anything that
needs to outlive the current session or be reviewed by a human.

---

# Part 2 — Serving interactive web content

Serve a directory or a Hono app to a public, auth-protected URL via
localtunnel. Use this when a static page won't do: custom routes, form posts,
uploads, per-request computation.

The CLI is a subcommand of `agent-swarm`. Always invoke it as
**`agent-swarm artifact <subcommand>`** — there is no top-level `artifact`
binary.

## Quick start

### Static content

```bash
# Create your content in a persisted directory
mkdir -p /workspace/personal/artifacts/my-report
echo '<h1>My Report</h1>' > /workspace/personal/artifacts/my-report/index.html

# Serve it (auto-assigns a free port, creates tunnel, registers in service registry)
agent-swarm artifact serve /workspace/personal/artifacts/my-report --name my-report
# -> Copy the deployment URL printed by the command; it is authoritative.
```

### Programmatic (custom Hono server)

```typescript
import { createArtifactServer } from '../artifact-sdk';
import { Hono } from 'hono';

const app = new Hono();
app.get('/', (c) => c.html('<h1>Dashboard</h1>'));

const server = createArtifactServer({ name: 'dashboard', app });
await server.start();
console.log(`Live at: ${server.url}`);
```

You can also run `agent-swarm artifact serve ./server.ts --name dashboard` if
`server.ts` exports a Hono instance as its default export.

See the bundled `examples/` directory for complete working examples
(`static-report.sh`, `hono-dashboard.ts`, `approval-flow.ts`,
`multi-artifact.ts`).

## CLI commands

| Command | Description |
|---|---|
| `agent-swarm artifact serve <path> --name <name> [--port <port>] [--no-auth] [--subdomain <sub>]` | Start serving content. `<path>` is a directory (static) or a `.ts`/`.js` file exporting a default Hono app. |
| `agent-swarm artifact list` | List active artifacts (name, agent, port, URL, status) from the service registry. |
| `agent-swarm artifact stop <name>` | Stop an artifact: deletes the matching PM2 process and unregisters it from the service registry. See "Known limitation" below. |

Flags accepted by `serve`:

- `--name <name>` — defaults to the basename of `<path>`. Used for the subdomain and PM2 process name.
- `--port <port>` — pin to a specific port. Default: auto-assigned ephemeral port.
- `--no-auth` — disable HTTP Basic auth on the tunnel (DANGEROUS — anyone with the URL can access).
- `--subdomain <sub>` — override the default `${agentId}-${name}` subdomain.

## Auth & URL pattern

Tunnels are protected by **HTTP Basic auth** by default:

- **Username:** `hi` (hardcoded MVP default in `src/artifact-sdk/tunnel.ts`)
- **Password:** the agent's `API_KEY`

> **Never put the API key in the URL.** The Basic-auth password *is* the swarm
> `API_KEY` — it authenticates against the whole swarm API, not just this
> artifact. A `https://user:key@host` URL leaks that credential into shell
> history, browser history, proxy and tunnel access logs, referrer headers, and
> anything you paste it into. Treat a credential-bearing URL as a leaked key.

The installed `@desplega.ai/localtunnel` package currently defaults to
`lt.desplega.ai`, but deployments may configure another tunnel host. The URL
printed by `agent-swarm artifact serve` (or exposed as `server.url`) is
authoritative. Save that plain URL as `ARTIFACT_URL`; a browser will prompt for
the credentials.

For scripts and `curl`, pass the credential out-of-band instead of inlining it,
and read it from the environment so it never appears as a literal:

```bash
# -u keeps the credential out of the URL; --netrc-file keeps it out of argv too.
curl -u "hi:$API_KEY" "$ARTIFACT_URL"

# Better for anything long-lived or logged — argv is visible to other processes:
ARTIFACT_HOST=${ARTIFACT_URL#*://}
ARTIFACT_HOST=${ARTIFACT_HOST%%/*}
printf 'machine %s login hi password %s\n' \
  "$ARTIFACT_HOST" "$API_KEY" > /tmp/artifact-netrc
chmod 600 /tmp/artifact-netrc
curl --netrc-file /tmp/artifact-netrc "$ARTIFACT_URL"
```

Do not echo the assembled command, and do not paste the credential into a task
report, Slack message, PR body, or page — those are all persisted.

Use `--no-auth` only for genuinely public content. Anyone who learns the
subdomain can read it.

## Running it as a daemon

`agent-swarm artifact serve` blocks on a never-resolving promise to stay alive —
you cannot inline it in a script that needs to do other work. Pick one:

### Option A — `nohup` (quick, throwaway)

```bash
mkdir -p /workspace/personal/logs
nohup agent-swarm artifact serve /workspace/personal/artifacts/my-report \
  --name my-report \
  > /workspace/personal/logs/my-report.out 2>&1 &
echo $! > /workspace/personal/logs/my-report.pid

# Later, kill it manually:
kill "$(cat /workspace/personal/logs/my-report.pid)"
```

### Option B — PM2 (recommended for anything you'll come back to)

PM2 gives you auto-restart on crash, a process name, log management, and —
crucially — lets `agent-swarm artifact stop <name>` actually kill it.

```bash
pm2 start agent-swarm \
  --name artifact-my-report \
  -- artifact serve /workspace/personal/artifacts/my-report --name my-report

# Stop it cleanly later:
agent-swarm artifact stop my-report
```

The PM2 process name **must** be `artifact-<name>` (matching `--name`) — that's
exactly what `artifact stop` looks for.

### Known limitation — `artifact stop` only kills PM2-started processes

`agent-swarm artifact stop <name>` runs `pm2 delete artifact-<name>` and then
unregisters the entry from the service registry. If you started the artifact
with `nohup` (or `&`, or any non-PM2 launcher), `pm2 delete` silently fails and
the server keeps running and serving — even though the command prints
`Artifact '<name>' stopped.` Until that's fixed:

- Use **PM2** if you want `artifact stop` to do its job.
- For `nohup`/foreground processes, kill the PID yourself
  (`kill <pid>` or `pkill -f 'artifact serve.*<name>'`) **and then** run
  `agent-swarm artifact stop <name>` to clear the registry row.

## Multiple artifacts

Each artifact gets its own port (auto-assigned) and subdomain
(`<agentId>-<name>`). You can run several simultaneously — see
`examples/multi-artifact.ts`.

## Browser SDK

Served HTML gets the same injected browser SDK that pages get. Load it and use
the ready-made singleton:

```html
<script src="/@swarm/sdk.js"></script>
<script>
  // `window.swarmSdk` is constructed for you — no `new SwarmSDK()` needed.
  const tasks = await window.swarmSdk.tasks.list({ status: 'in_progress' });
  const agents = await window.swarmSdk.agents.list();
</script>
```

The SDK is **domain-grouped** (`swarmSdk.tasks`, `.agents`, `.events`,
`.memory`, `.repos`, `.schedules`, `.approvalRequests`, `.assets`), each domain
mapping 1:1 onto the public REST API. The **`pages`** skill documents the full
method surface — it's the same object, so don't duplicate it here.

Calls route through the `/@swarm/api/*` proxy, which injects auth server-side.
Browser code never sees the API key.

## Storage

Always store served content in persisted directories — the working dir is wiped
between sessions:

- `/workspace/personal/artifacts/` — per-agent, persists across sessions (default)
- `/workspace/shared/artifacts/` — shared across the swarm

## See also

- The **`pages`** skill — DB-backed static HTML/JSON, no process to run. Prefer
  it whenever the content is a snapshot.
- The **`kv-storage`** skill — for the small state a served page needs.
