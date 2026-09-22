# AI Builders deck deployment

This directory serves https://aib.agent-swarm.dev/ as a static site. No package
installation, compilation, or monorepo build is needed. `vercel.json` pins the
framework to Other (`null`), makes install/build commands no-ops (`true`), and
serves this directory (`.`). The ignored-build command exits 1 to allow builds,
including redeploys and merges that do not change the deck. These settings apply
only to projects whose root is this directory; other monorepo apps are unchanged.

## Project settings

Keep these settings on Vercel project `agent-swarm-aib`:

| Setting | Value |
| --- | --- |
| Project ID | `prj_VIW2zPxSCkmrWsNUfl46ku8j3A5B` |
| Team ID | `team_SONHKJEagNUFy3GJ4Qda6ixm` (`desplega-labs`) |
| Git repository | `desplega-ai/agent-swarm` |
| Production branch | `main` |
| `rootDirectory` | `talks/2026-09-21-ai-builders-memory` |
| Production domain | `aib.agent-swarm.dev` |
| `nodeVersion` | `24.x` (observed 2026-09-21; unused by the static deck) |

Vercel must select the root directory before reading its `vercel.json`.
`rootDirectory` is a dashboard/API project setting, not an allowed property in
the [current configuration schema](https://openapi.vercel.sh/vercel.json).
The Git link, production branch, and domain also belong to the project. Node
version is not a `vercel.json` property; this static site does not need a
`package.json` solely to select a runtime it does not use. See Vercel's
[build configuration](https://vercel.com/docs/builds/configure-a-build) and
[file configuration](https://vercel.com/docs/project-configuration/vercel-json).

The existing dashboard build/install/output values may remain in place. The
committed config overrides them for new deployments. Do not clear or repoint
the root directory. Redeploy the merge commit or a newer commit to use this
config; redeploying an older commit uses that older commit's files.

## Preview and production verification

Push a branch and use its preview deployment on **this project**, checking the
deployment's Git SHA against the branch. Do not promote a preview to production.
For the preview URL, verify `/` returns 200 with the deck HTML, `/deck.css`
returns 200 with `text/css`, and `/deck.js` returns 200 with a JavaScript content
type. Render a slide in a browser to confirm styling and script behavior. After
merging to `main`, repeat these checks on https://aib.agent-swarm.dev/.

No GitHub Action deploys this deck; the Vercel Git integration handles branch
previews and production merges.

## Adding or renaming talks

Adding a sibling under `talks/` does not change this site's content or break it.
This project remains pinned to the dated directory; it does not select the
newest talk automatically. Give another talk its own project/root/domain, or
plan an explicit migration if this domain should serve it instead.

Renaming or deleting this directory without updating `rootDirectory` breaks
future builds because Vercel cannot find the configured root. The last successful
deployment remains served, but new merges cannot update it. Keep the existing
directory until a replacement root is proven on a preview, then coordinate the
project setting change. Moving `vercel.json` alone does not update the root.
