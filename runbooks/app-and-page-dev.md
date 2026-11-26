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
```

| Option | Default | Notes |
|---|---|---|
| `--api-url <url>` | `$MCP_BASE_URL` | Another URL must be loopback: the swarm key goes there. |
| `--as-email <email>` | first user with an email | The dashboard user you view as (primary email or alias). |
| `--port <n>` | `5274` | Fails fast when the port is taken. Any port works. |
| `--json` | off | Print only the ready JSON. |

Needs `AGENT_SWARM_API_KEY` or `API_KEY`. Agents run it in the background (`run_in_background`) and wait for the one stdout line:

```
UI_DEV_READY {"url":"http://127.0.0.1:5274/apps/<id>","target":{"kind":"app","id":"...","name":"..."},"apiUrl":"...","userId":"...","userEmail":"...","warnings":[...],"pid":123}
```

Vite logs go to stderr. The process holds until SIGINT or SIGTERM and stops the dev server with it. Exit codes: 0 clean stop, 1 dev server failure, 2 usage or config error (unknown app, page or user; bad `--api-url`; port taken).

## How it connects

- `ui-dev` (no checkout): a Bun server on `127.0.0.1` forwards every path except the API paths below to `APP_URL`, and adds `window.__AGENT_SWARM_UI_CONFIG__` (the same `VITE_*` keys as below) to the HTML, which the dashboard reads in `apps/ui/src/lib/deployment-config.ts`. It also drops the Plausible tags. The key and cookies never go to the `APP_URL` host. A dashboard build without the `agent-swarm-ui-runtime-config` meta tag would ignore the connection, so `ui-dev` refuses it with exit 2: update that dashboard, or set `APP_URL=https://app.agent-swarm.dev`. It has no WebSocket proxy (only Comb file presence uses one).
- `ui:dev` (checkout): the dashboard is built with `VITE_API_URL` set to the dev server's own origin, `VITE_API_KEY` set to the swarm key and `VITE_USER_ID` set to the chosen user (`apps/ui/src/lib/deployment-config.ts`). No connection setup, no `/setup` redirect, no "Who are you?" dialog. The URL carries no secret, so it is safe in logs, recordings and task output.
- Both proxy `/api`, `/health`, `/status`, `/p/*` and `/@swarm/*` to the API (`apps/ui/vite.config.ts`, `VITE_PROXY_TARGET`). The browser sees one origin, so:
  - no CORS allowlist entry is needed for the port;
  - a page's CSP `frame-ancestors 'self'` matches the dashboard, so HTML pages frame on any API, prod included;
  - the page-session cookie and the page's Browser SDK calls (`/@swarm/api/*`) stay first-party.
- The key sits in a loopback-only bundle or HTML response. Never expose either server beyond `127.0.0.1`.
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

With `$MCP_BASE_URL` the dashboard acts with your swarm key on the live swarm. An app action click runs the action; a page form or KV write lands in prod. The ready line says so in `warnings`. Rule: in prod, do not click actions or submit forms unless the task asks for it. A local copy mode (a throwaway API with the app or page copied in) is planned and not available yet.

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

Run `ui:dev` on `main` (a worktree) and on the branch, same target, same viewport, different `--port`. Put both frames in the PR's `## Before / after`. For a flow, record one video per side. Against prod, prefer a target whose data you may show publicly, or a dev API you seeded yourself (`--api-url http://127.0.0.1:<port>`).

## Proof

- Black-box, both commands: `bun run e2e --only ui-dev-remote` (`scripts/e2e/scenarios/ui-dev-remote.ts`).
- Browser: `bun run e2e:ui -- specs/ui-dev.spec.ts` (`packages/ui-e2e/specs/ui-dev.spec.ts`).
