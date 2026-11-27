# App and page dev loop: `agent-swarm ui-dev` and `bun run ui:dev`

One command gives a browser-ready dashboard URL for a swarm app, a page, or any dashboard route, already connected to a swarm API as a fixed user. Use it to view, screenshot, record or QA an app or page, and to iterate on `apps/ui` code that renders them. It replaces ad-hoc Playwright scripts and localStorage seeding: do not write a one-off browser script to reach an app or page.

## The command

Two commands, one behavior: same options, same ready line, same exit codes.

- `agent-swarm ui-dev` needs no checkout. It ships in the worker image (`/usr/local/bin/agent-swarm`) and the npm package, so every swarm's agents can run it. It serves the dashboard bundle of `APP_URL` (default `https://app.agent-swarm.dev`, the hosted dashboard) on `127.0.0.1` and injects the connection into its `index.html`.
- `bun run ui:dev` runs from an agent-swarm checkout. It serves `apps/ui` source with Vite and hot reload: use it when you change dashboard code.

```bash
agent-swarm ui-dev --app <appId>          # same options as below
bun run ui:dev --app <appId>              # opens /apps/<appId>
bun run ui:dev --page <id|slug>           # opens /pages/<id>; a slug resolves to the newest matching page
bun run ui:dev --route '/apps/<id>/p/<page>?mode=chromeless'   # any dashboard path
bun run app:dev <appId>                   # alias for --app
bun run ui:dev --api local --app <appId>  # a throwaway API with a copy of the app (see Local mode)
```

| Option | Default | Notes |
|---|---|---|
| `--api-url <url>` | `$MCP_BASE_URL` | Another URL must be loopback: the swarm key goes there. |
| `--as-email <email>` | first user with an email | The dashboard user you view as (primary email or alias). |
| `--port <n>` | `5274` | Fails fast when the port is taken. Any port works. |
| `--json` | off | Print only the ready JSON. |
| `--api prod\|local` | `prod` | `bun run ui:dev` only. `local`: see [Local mode](#local-mode). |
| `--fixture <file>` | none | Local mode: copy an app or page bundle file instead of reading a source API. |
| `--state-dir <dir>` | `.ui-dev/<kind>-<id>` | Local mode: the throwaway API's database, log and `api-key` file. |

Needs `AGENT_SWARM_API_KEY` or `API_KEY`. Agents run it in the background (`run_in_background`) and wait for the one stdout line:

```
UI_DEV_READY {"url":"http://127.0.0.1:5274/apps/<id>","target":{"kind":"app","id":"...","name":"..."},"apiUrl":"...","userId":"...","userEmail":"...","warnings":[...],"pid":123}
```

Vite logs go to stderr. The process holds until SIGINT or SIGTERM and stops the dev server with it. Exit codes: 0 clean stop, 1 dev server, local API or copy failure, 2 usage or config error (unknown app, page or user; bad `--api-url`; port taken; unreadable fixture).

## How it connects

- `ui-dev` (no checkout): a Bun server on `127.0.0.1` forwards every path except the API paths below to `APP_URL`, and adds `window.__AGENT_SWARM_UI_CONFIG__` (the same `VITE_*` keys as below) to the HTML, which the dashboard reads in `apps/ui/src/lib/deployment-config.ts`. It also drops the Plausible tags. The key and cookies never go to the `APP_URL` host. A dashboard build without the `agent-swarm-ui-runtime-config` meta tag would ignore the connection, so `ui-dev` refuses it with exit 2: update that dashboard, or set `APP_URL=https://app.agent-swarm.dev`. It has no WebSocket proxy (only Comb file presence uses one).
- `ui:dev` (checkout): the dashboard is built with `VITE_API_URL` set to the dev server's own origin, `VITE_API_KEY` set to the swarm key and `VITE_USER_ID` set to the chosen user (`apps/ui/src/lib/deployment-config.ts`). No connection setup, no `/setup` redirect, no "Who are you?" dialog. The URL carries no secret, so it is safe in logs, recordings and task output.
- Both proxy `/api`, `/health`, `/status`, `/p/*` and `/@swarm/*` to the API (`apps/ui/vite.config.ts`, `VITE_PROXY_TARGET`). The browser sees one origin, so:
  - no CORS allowlist entry is needed for the port;
  - a page's CSP `frame-ancestors 'self'` matches the dashboard, so HTML pages frame on any API, prod included;
  - the page-session cookie and the page's Browser SDK calls (`/@swarm/api/*`) stay first-party.
- The key sits in a loopback-only bundle or HTML response. Never expose either server beyond `127.0.0.1`. `ui-dev` answers 403 to any Host other than `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding) and drops the `APP_URL` host's `access-control-*` headers, so no other origin can read that HTML.
- Both set `VITE_AGENT_PREVIEW=1` (`isAgentPreview` in `apps/ui/src/lib/deployment-config.ts`): the dashboard sends no UI telemetry and mounts no self-opening nudge or popup (GitHub star toast, feedback, org name, lead credential, first-task invite, home banners). The API still records its own events for the calls the preview makes.

## Pages

| Page type | Works | Notes |
|---|---|---|
| `application/json` | yes | Rendered in the SPA. |
| `image/svg+xml` | yes | Framed from `/p/<id>`. |
| `text/html`, `public` or `authed` | yes | Framed from `/p/<id>`; authed pages get their session through `POST /api/pages/<id>/launch`. |
| `text/html`, `password` | yes | The dashboard asks for the password, as in prod. |

Page bodies are HTML stored in the API, not repo code. With `bun run ui:dev`, hot reload covers the dashboard around them (header, JSON renderer, frame plumbing). To iterate on a body, `PUT /api/pages/<id>` against the API in use and reload.

## Prod writes

With `$MCP_BASE_URL` the dashboard acts with your swarm key on the live swarm. An app action click runs the action; a page form or KV write lands in prod. The ready line says so in `warnings`. Rule: in prod, do not click actions or submit forms unless the task asks for it. To click, submit or edit freely, use [Local mode](#local-mode).

## Local mode

`bun run ui:dev --api local` boots a throwaway API from the checkout (`src/http.ts` on a fresh SQLite file in `--state-dir`, `NODE_ENV=development`, integrations and heartbeat off, listening on `127.0.0.1` only, with the checkout's `.env` files ignored so a `DATABASE_URL` there cannot pick Postgres), copies the target into it, and points the dev server at it. Nothing it does reaches prod. Code: `scripts/ui-dev/local.ts`.

```bash
bun run ui:dev --api local --app <appId>                  # copy from $MCP_BASE_URL (or --api-url)
bun run ui:dev --api local --page <id|slug>
bun run ui:dev --api local --fixture scripts/ui-dev/fixtures/sample-app.json   # no source API
bun run ui:dev --api local --route /apps                  # empty local dashboard, nothing copied
```

| Use prod when | Use local when |
|---|---|
| Showing real data (QA of a live app or page, a demo video) | Changing `apps/ui` code that renders apps or pages, or editing a definition or page body you do not want live yet |
| Read-only clicking | Clicking actions, forms, or anything that writes |
| The UI change needs real data shapes to judge | A PR's before/after (reproducible, no prod writes) |

What the copy holds:

- **App**: `GET /api/apps/<id>/export` on the source, then `POST /api/apps/import?keepId=1` locally. Every row (no 1,000-row list cap) and the scripts its actions use; the app keeps its id. Import warnings (a script needing a connection or secret absent locally) land in the ready line's `warnings`. Script actions run locally, as a local `ui-dev` agent, in the quickjs sandbox (`SCRIPT_EXECUTOR=quickjs`): a copied script cannot read your files, env or processes, a native executor pin is dropped with a warning, and scripts carry no extracted `argsJsonSchema`. A script that needs Bun or `node:` APIs fails locally.
- **Page**: the record from `GET /api/pages/<id>` and its KV namespace, under a new local page id (the ready line's `target.id`). A password page becomes `authed`, with a warning: the password is not readable through the API. A page that calls swarm APIs beyond its own KV gets a "local data is empty" warning.
- **User**: the source user you view as (`--as-email`, else the first user with an email), recreated by email. With a fixture or `--route`: `--as-email`, else `ui-dev@example.com`.
- Not copied: sync schedules, connections, secrets, tasks and any other swarm data a page reads.

The ready line adds `"mode":"local"`, `source` (the source API, `fixture:<path>` or `none`), `stateDir` and `apiKeyFile`. The local key sits in that file, never in the ready line. Use it to drive the copy, for example to iterate on a page body:

```bash
KEY=$(cat "$STATE_DIR/api-key")
curl -X PUT "$API_URL/api/pages/<localId>" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"body":"<h1>v2</h1>"}'   # then reload the tab
```

Each start wipes the state directory's database. The directory stays after exit for its `api.log`; `.ui-dev/` is gitignored.

Fixtures are bundle files: an app bundle is the `GET /api/apps/<id>/export` body (`swarm-app-bundle/v1`); a page bundle is `{ "format": "swarm-page-bundle/v1", "page": { title, slug?, contentType, authMode?, body, theme?, themeTokens?, designVersion? }, "kv": [{ key, value, valueType? }] }`. The committed ones in `scripts/ui-dev/fixtures/` are synthetic. Prod rows never go into this public repo.

## Screenshots and video

Capture at 1440x900, plus a 375-wide viewport for mobile. Apps scroll inside an inner canvas: scroll it or raise the viewport height for a full capture.

```bash
agent-browser set viewport 1440 900
agent-browser record start ./out/prod-<slug>.webm "$URL"   # or: agent-browser open "$URL"
agent-browser wait 5000
agent-browser screenshot ./out/<slug>.png
agent-browser record stop
```

- Playwright: `browser.newContext({ recordVideo: { dir } })`, then `page.goto(url)`. No storage state is needed.
- Narrated recording: the `qa-loom` skill with `BASE_URL=<origin of the ready url>`.

Stage files under the repo or `/workspace/personal`, not `/tmp`. Upload with `agent-fs write shared/ui-videos/<kind>-<id>/<YYYY-MM-DD>/<name> --file <local>` (or the task's asset key), then check `agent-fs stat <path> --json | jq .size` is over 200 bytes. Prod data stays out of public PRs: link prod captures from the PR's `## Swarm provenance` only.

## Before and after for a PR

Use local mode with a fixture: the same data on both sides, no prod writes, nothing private in the frames.

```bash
git worktree add ../swarm-main origin/main
(cd ../swarm-main && bun install && bun run ui:dev --api local --fixture scripts/ui-dev/fixtures/sample-app.json --port 5301)   # before
bun run ui:dev --api local --fixture scripts/ui-dev/fixtures/sample-app.json --port 5302                                           # after
```

Each side gets its own state directory (the default is per checkout). Capture the same viewport on both (1440x900, plus 375 wide for mobile), and put both frames in the PR's `## Before / after`. For a flow, record one video per side. When the change needs a shape the sample lacks, commit a new synthetic fixture with the PR, or copy a real app with `--app <id>` and keep those frames out of the public PR (link them from `## Swarm provenance`).

## Proof

- Black-box, both commands: `bun run e2e --only ui-dev-remote` (`scripts/e2e/scenarios/ui-dev-remote.ts`).
- Local mode: `bun run e2e --only ui-dev-local` (`scripts/e2e/scenarios/ui-dev-local.ts`).
- Browser: `bun run e2e:ui -- specs/ui-dev.spec.ts` (`packages/ui-e2e/specs/ui-dev.spec.ts`).
