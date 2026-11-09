# Release runbook

Publishing a release is **automated**. You do not run `npm publish`, `docker push`, or `gh release` by hand — pushing a changed `version` in `package.json` to `main` triggers everything. Your job is the prep: bump the version, regenerate the artifacts that embed/derive it, and commit them together.

## TL;DR

The release PR writes the `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md` from the commits in `v<previous tag>..main`, because no other PR adds entries.

```bash
# 1. Bump the version (on a branch, not directly on main)
npm version --no-git-tag-version patch   # or minor / major — edits package.json only, no git tag

# 2. Regenerate everything that derives from the version
bun run prepare-release

# 3. Run the normal pre-push checks (see runbooks/ci.md)
bun run lint && bun run tsc:check && bun run test:root

# 4. Commit the bump + ALL regenerated files together, open a PR, merge to main
git add package.json CHANGELOG.md charts/agent-swarm/Chart.yaml openapi.json docs-site/content/docs/api-reference \
  .claude-plugin .codex-plugin .cursor-plugin .devin-plugin .kimi-plugin gemini-extension.json
git commit -m "chore(release): vX.Y.Z"
```

Merging to `main` does the rest (see [What happens on merge](#what-happens-on-merge)).

## `bun run prepare-release`

`scripts/prepare-release.ts` regenerates the three version-derived artifacts CI gates on, in one shot, and prints the changed files to commit:

| Step | Command it runs | Regenerates | Gated by |
|---|---|---|---|
| Helm chart sync | `sync-chart-version` | `charts/agent-swarm/Chart.yaml` (`version` + `appVersion`) | `helm-publish.yml` (`check-chart-version`), `docker-and-deploy.yml` (`sync-chart-version --check`) |
| Harness plugin descriptors | `sync-plugin-versions` | `version` in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/`, `.cursor-plugin/`, `.devin-plugin/`, `.kimi-plugin/`, `gemini-extension.json` | `merge-gate.yml` (`Operator Skill Check`, `check:plugin-versions`) |
| OpenAPI + docs | `docs:openapi` | `openapi.json` + `docs-site/content/docs/api-reference/**` | `merge-gate.yml` (`OpenAPI Spec Freshness Check`) |

It does **not** stage or commit anything — it regenerates and reports. Commit the listed files yourself alongside the version bump.

> **Why these two?** `openapi.json` embeds `package.json`'s `version`, and the api-reference MDX is generated from it. `Chart.yaml`'s `version`/`appVersion` must match `package.json`. Bumping the version without regenerating both makes CI fail the freshness/sync checks — see [runbooks/ci.md](./ci.md). `prepare-release` exists so you never have to remember which scripts those are.

## What happens on merge

`.github/workflows/docker-and-deploy.yml` runs on every push to `main`. Its `detect-version-change` job compares `package.json`'s `version` against the previous commit. **If — and only if — the version changed**, these jobs fire (each is idempotent and skips if the artifact already exists):

| Job | Output |
|---|---|
| `build-and-push-server-*` + manifest | `ghcr.io/desplega-ai/agent-swarm:<version>` (amd64 + arm64) |
| `build-and-push-worker-*` + manifest | `ghcr.io/desplega-ai/agent-swarm-worker:<version>` (amd64 + arm64) |
| `build-and-push-ui` | `ghcr.io/desplega-ai/agent-swarm-ui:<version>` (amd64 + arm64), the dashboard served by nginx |
| `publish-e2b-templates` | E2B release templates (`agent-swarm-api-<slug>`, worker/lead runtime) |
| `create-git-tag` | Pushes git tag `v<version>` |
| `publish-npm` | `@desplega.ai/agent-swarm@<version>` on npm (with provenance; skips if already published) |
| `create-release` | GitHub Release for `v<version>` with install instructions |

The Helm chart is published separately by `helm-publish.yml` when `charts/agent-swarm/Chart.yaml`'s `version` changes — which is exactly what `sync-chart-version` (and thus `prepare-release`) updates.

If you push to `main` **without** a version change, none of the publish jobs run — Docker images still build (and deploy at the next window) but aren't tagged with a release version. So a release is opt-in: it's defined by the `package.json` version bump.

### Moving Docker tags and deployment

Merging to `main` does not deploy prod. The three manifest jobs publish SHA and
optional version tags, and the `promote-main-tags` job moves API/worker
`:latest` and worker `:slim` to the run's manifest digests on every merge.
Prod runs `:prod` (API and worker), which only `.github/workflows/deploy.yml`
moves, at 09:00, 14:00 and 19:00 Europe/Madrid (`on.schedule` with
`timezone`), and on manual dispatch. Each deploy restarts the API, which cuts
and resumes in-flight tasks, so batching merges into three windows a day keeps
that cost bounded. Prod must never read `:latest`: with `pull_policy: always`,
any container restart would pull the main tip.

`promote-main-tags` holds the `agent-swarm-main-tags` concurrency lock.
`queue: max` preserves pending promotions (up to GitHub's 100-job limit), so a
late stale build cannot evict a queued main-tip run. After acquiring that lock,
it checks whether a newer main commit touches the workflow's `on.push.paths`
(read from the workflow file, so the list lives in one place). If one does,
that commit starts its own run, so this stale run keeps its SHA/version images
but skips promotion. Newer commits outside those paths (docs, for example)
start no run, so they do not block it. Logic: `scripts/deploy-guard.sh`; test:
`src/tests/deploy-guard.test.ts`. Promotion uses the run's digest outputs,
since even a SHA tag can change on a rerun.

`scripts/deploy-select.ts` walks main's first-parent history newest first and
takes the first commit whose API and worker `sha-<short>` images both exist;
builds are superseded per ref, so not every commit has images. It stops at the
commit the API `:prod` revision label names: reaching it means nothing new was
built, and the run skips with a job-summary notice (no promotion, no Dokploy
call, no Slack post). A missing `:prod` means no previous deploy: it deploys,
with an empty change list. It resolves both digests once, and promotion uses
those digests, since a rerun can move a SHA tag. Test:
`src/tests/deploy-select.test.ts`.

The deploy job holds the `agent-swarm-deploy` concurrency lock through the
completed Dokploy deploy, and selects only after taking it. Non-main dispatches
cannot deploy. The two registry writes are sequential, so a failed promotion
can leave partially updated tags; it fails the job before deployment, and the
next run retries.

Hotfix or rollback, without waiting for a window:

```bash
gh workflow run deploy.yml -R desplega-ai/agent-swarm                 # newest built main commit
gh workflow run deploy.yml -R desplega-ai/agent-swarm -f sha=<main sha>
```

A requested SHA must be on main and have API and worker images. A rollback holds
until the next window that finds a newer built commit.

The deploy step is `scripts/dokploy-deploy.ts`. `compose.deploy` only queues the
job; Dokploy creates the deployment record when its worker starts it, and that
start can lag the trigger by minutes. The script waits up to 7 minutes for any
record newer than the pre-trigger baseline, re-triggers up to 3 times if none
appears (a deploy of an unchanged `:latest` finishes in seconds), then follows
the records to a terminal status. It fails only when no record ever appears or
the newest one ends `error`/`cancelled`. Tunables: `DOKPLOY_RECORD_WAIT_SECONDS`,
`DOKPLOY_MAX_TRIGGERS`, `DOKPLOY_COMPLETION_TIMEOUT_SECONDS`. Before redeploying by
hand after a red run, list the compose's deployments (or run
`bun scripts/dokploy-deploy.ts --check` with `DOKPLOY_URL`, `DOKPLOY_COMPOSE_ID`,
`DOKPLOY_TOKEN` set): a late record means the deploy is still coming.

### Swarm Cloud image-release callback

After the server and worker Docker manifest lists are published, the workflow posts the same release payload to each configured Swarm Cloud image-release intake. The callbacks are limited to the protected publish context: `desplega-ai/agent-swarm`, non-PR events, and `refs/heads/main`.

The callback reports the detected release version when `package.json` changed, matching the tag created by `create-git-tag`; ordinary `main` pushes report `main`.

The callbacks send the manifest-list digest refs for the API and worker images, from that run's merge-job outputs, for example `ghcr.io/desplega-ai/agent-swarm@sha256:...` and `ghcr.io/desplega-ai/agent-swarm-worker@sha256:...`. They never resolve `:latest`, so overlapping builds or reruns cannot mislabel another run's images with this run's commit. The workflow builds `payload.json` once with `jq`, signs its exact bytes separately for each deployment's secret, and sends those same bytes with `curl --data-binary` so every signature matches raw-body verification.

The production target uses `SWARM_CLOUD_BASE_URL` with `IMAGE_RELEASE_INTAKE_SECRET`; it is authoritative, so a transport or non-200/201 response fails the release job. The development target uses `SWARM_CLOUD_DEV_BASE_URL` with `IMAGE_RELEASE_DEV_INTAKE_SECRET`; it is best-effort so development metadata stays fresh without making a development outage block publishing. An incomplete target pair is skipped with a warning. Even when production fails, the workflow still attempts development delivery before returning the production failure.

## Verifying a release

After the merge, confirm the `Docker Build + Publish` workflow run is green and the next `Deploy` run (or a manual dispatch) deployed it, then spot-check:

```bash
npm view @desplega.ai/agent-swarm@<version> version      # npm
git fetch --tags && git tag -l v<version>                # git tag
gh release view v<version>                               # GitHub release
docker manifest inspect ghcr.io/desplega-ai/agent-swarm:<version> >/dev/null && echo ok   # image
```

## Gotchas

- **Don't create the git tag yourself.** `create-git-tag` does it. A pre-existing tag makes that job warn-and-skip, so a manual tag isn't fatal — but it's redundant and easy to get wrong.
- **Commit the regenerated files in the same PR as the bump.** If `openapi.json` / api-reference / `Chart.yaml` drift from the new version, the merge-gate freshness checks block the PR before it ever reaches `main`.
- **Use `--no-git-tag-version`** with `npm version` so it only edits `package.json` — the tag is CI's job.
- **Idempotent by design.** Re-running the deploy (e.g. a re-push) won't double-publish: npm/tag/release jobs detect the existing version and skip.
- **E2B `-latest` templates must build from the `:<version>` image, never `:latest`.** E2B's builder caches the `fromImage` base layer by image reference *string*; a mutable `:latest` ref never changes, so every rebuild is a cache hit and the template stays frozen at the image pulled on the very first build (this pinned `agent-swarm-{api,worker}-latest` to v1.85 for weeks while every release "successfully" republished them). If a template ever gets stuck on stale layers, rebuild it manually with `bun run src/cli.tsx e2b build-template ... --no-cache` and re-publish.
