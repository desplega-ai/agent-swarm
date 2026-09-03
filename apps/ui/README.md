# Agent Swarm Dashboard

The dashboard is a React and Vite application for operating an Agent Swarm deployment.

## Local development

Run these commands from `apps/ui`:

```bash
bun run dev
bun run build
bun run lint
bunx tsc -b
```

The development server proxies API requests to `http://localhost:3013`. Set
`VITE_PROXY_TARGET` to use another local API origin.

## Fixed deployment configuration

A dedicated UI deployment can connect to one swarm without showing connection or user switchers.
Set these Vite build variables:

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Fixed Agent Swarm API origin. |
| `VITE_API_KEY` | Fixed API credential. Required with `VITE_API_URL`. |
| `VITE_USER_ID` | Fixed user identity. Requires the URL and key. |
| `VITE_DEMO_MODE` | Shows the diagonal live demo ribbon when set to `true` or `1`. |

The URL and key replace stored connections and disable all connection changes. URL connection
parameters cannot override them. The Connections settings page remains available in read-only mode.

`VITE_USER_ID` resolves against the connected swarm user directory. The UI hides identity controls
and disables identity changes. Use an existing user ID from that swarm.

All `VITE_*` values become public browser bundle data. Use a restricted demo credential and a
demo-safe API deployment. Never place a private operator credential in `VITE_API_KEY`.

Copy `.env.demo.example` to an ignored local Vite environment file for local testing. Deployment
platforms such as Vercel can provide the same values as project build variables.
