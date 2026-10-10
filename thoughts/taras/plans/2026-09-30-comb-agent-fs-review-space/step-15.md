---
id: step-15
name: Release agent-fs + bump swarm pins
depends_on: [step-3]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-15: Release agent-fs + bump swarm pins

**Repo:** both. Part A in agent-fs (`$AFS`), part B in agent-swarm. Part B waits for part A's release to publish.

## Overview

agent-fs steps 1-3 already run on prod after each merge (Fly deploys every push to `main`). But npm and GHCR publish only on a version bump, and the swarm pins agent-fs 0.14.0 everywhere: the worker CLI + baked skill, the compose images, the Helm chart, and the UI E2E workflow. This step releases agent-fs 0.15.0 and bumps every swarm pin, so workers get `--mention` / `--prefix` / `watch` and the updated skill, and local compose runs the Comb features without a custom image.

Publishing is outward-facing. The implementer prepares both PRs and verifies them. Taras merges.

When done: `agent-fs --version` in the worker image prints 0.15.0, and the baked skill documents mentions.

## Changes Required:

#### A. agent-fs release (in `$AFS`)
**Changes**:
- On a branch (not `main`): `./scripts/release.sh 0.15.0`. It syncs versions, regenerates `docs/openapi.json`, runs `bun install --frozen-lockfile`, commits `chore: release v0.15.0`, and pushes the branch (`scripts/release.sh:27-53`). Open the PR with `gh pr create`.
- PR body lists the Comb features added in steps 1-3 and the `/health` feature strings.
- After Taras merges: `auto-release.yml` tags `v0.15.0` and dispatches `npm-publish.yml` + `docker-publish.yml`. Confirm both runs succeed (`gh run list -R desplega-ai/agent-fs --limit 5`).

#### B. agent-swarm pins (after A publishes)
**Changes**: bump every pin, found with `grep -rn "0\.14\.0" --include='*.yml' --include='*.yaml' --include='Dockerfile*' . | grep -i agent-fs` (root-level scan, excluding `node_modules`). At planning time these were:
- `Dockerfile.worker:224` `ARG AGENT_FS_VERSION=0.14.0`
- `docker-compose.local.yml:57`, `docker-compose.example.yml:113`, `docker-compose.scripts-only.yml:57` image tags
- `charts/agent-swarm/values.yaml:308`, `charts/agent-swarm/examples/values-all-workers-agent-fs.yaml:261`
- `.github/workflows/ui-e2e.yml:245` `npm i -g @desplega.ai/agent-fs@0.14.0`
Check `runbooks/docker-images.md` and memory "agent-fs pin lockstep" for any other lockstep pin (for example a test or doc that asserts the version). Check whether the chart needs a chart version bump for a values change (`runbooks/release.md`).

### Success Criteria:

#### Automated Verification:
- [ ] agent-fs release branch is clean: `cd "$AFS" && bun run scripts/sync-versions.ts --check && bun run typecheck && bun run test`
- [x] Published: `npm view @desplega.ai/agent-fs@0.15.0 version` prints `0.15.0`, and `docker manifest inspect ghcr.io/desplega-ai/agent-fs:0.15.0` succeeds
- [x] No 0.14.0 agent-fs pin remains in the swarm repo: `grep -rn "agent-fs.*0\.14\.0\|AGENT_FS_VERSION=0\.14\.0" --include='*.yml' --include='*.yaml' --include='Dockerfile*' . | grep -v node_modules` prints nothing
- [x] Worker image builds: `bun run docker:build:worker:slim`
- [x] Compose config is valid: `docker compose -f docker-compose.local.yml config -q`

#### Automated QA:
- [x] In the built slim image: `docker run --rm --entrypoint agent-fs <image> --version` prints `0.15.0`, and `docker run --rm --entrypoint sh <image> -c 'grep -c -- "--mention" ~/.claude/skills/agent-fs/SKILL.md'` is at least 1 (adjust the skill path to where `Dockerfile.worker:221-226` installs it).
- [x] `docker compose -f docker-compose.local.yml up agent-fs` then `curl -s localhost:7433/health` lists all four Comb features.

#### Manual Verification:
- [ ] Taras merges the agent-fs release PR (publishes to npm and GHCR).
- [ ] Taras merges the agent-swarm pin PR.
- [ ] Prod agent-fs `/health` lists `comment-path-prefix`, `drive-members`, `comment-mentions`, `change-stream` (already true after steps 1-3 auto-deploy; re-check here).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes. Never push the release commit to agent-fs `main` directly. Use a branch + PR.

## Implementation Notes (part B)

- Branch chore/agent-fs-0.15.0 (worktree /Users/taras/worktrees/agent-swarm/2026-09-30-agent-fs-0150), commit 1eedb93f4. Bumped 9 files: Dockerfile.worker, 3 compose files, chart values.yaml and example values, ui-e2e.yml, DEPLOYMENT.md, agent-fs-co-deployment.mdx. No chart version bump (values-only; Chart.yaml tracks package.json version).
- Published after about 11 min in the merge queue. Slim image agent-swarm-worker:slim: agent-fs --version = 0.15.0, baked skill has 4 --mention hits. GHCR image /health (via docker exec, image binds loopback) lists all four Comb features.
- Prod /health re-check and merges are left to Taras.
