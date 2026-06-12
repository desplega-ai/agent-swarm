# Release runbook

Publishing a release is **automated**. You do not run `npm publish`, `docker push`, or `gh release` by hand — pushing a changed `version` in `package.json` to `main` triggers everything. Your job is the prep: bump the version, regenerate the artifacts that embed/derive it, and commit them together.

## TL;DR

```bash
# 1. Bump the version (on a branch, not directly on main)
npm version --no-git-tag-version patch   # or minor / major — edits package.json only, no git tag

# 2. Regenerate everything that derives from the version
bun run prepare-release

# 3. Run the normal pre-push checks (see runbooks/ci.md)
bun run lint && bun run tsc:check && bun test

# 4. Commit the bump + ALL regenerated files together, open a PR, merge to main
git add package.json charts/agent-swarm/Chart.yaml openapi.json docs-site/content/docs/api-reference
git commit -m "chore(release): vX.Y.Z"
```

Merging to `main` does the rest (see [What happens on merge](#what-happens-on-merge)).

## `bun run prepare-release`

`scripts/prepare-release.ts` regenerates the two version-derived artifacts CI gates on, in one shot, and prints the changed files to commit:

| Step | Command it runs | Regenerates | Gated by |
|---|---|---|---|
| Helm chart sync | `sync-chart-version` | `charts/agent-swarm/Chart.yaml` (`version` + `appVersion`) | `helm-publish.yml` (`check-chart-version`), `docker-and-deploy.yml` (`sync-chart-version --check`) |
| OpenAPI + docs | `docs:openapi` | `openapi.json` + `docs-site/content/docs/api-reference/**` | `merge-gate.yml` (`OpenAPI Spec Freshness Check`) |

It does **not** stage or commit anything — it regenerates and reports. Commit the listed files yourself alongside the version bump.

> **Why these two?** `openapi.json` embeds `package.json`'s `version`, and the api-reference MDX is generated from it. `Chart.yaml`'s `version`/`appVersion` must match `package.json`. Bumping the version without regenerating both makes CI fail the freshness/sync checks — see [runbooks/ci.md](./ci.md). `prepare-release` exists so you never have to remember which scripts those are.

## What happens on merge

`.github/workflows/docker-and-deploy.yml` runs on every push to `main`. Its `detect-version-change` job compares `package.json`'s `version` against the previous commit. **If — and only if — the version changed**, these jobs fire (each is idempotent and skips if the artifact already exists):

| Job | Output |
|---|---|
| `build-and-push-server-*` + manifest | `ghcr.io/desplega-ai/agent-swarm:<version>` (amd64 + arm64) |
| `build-and-push-worker-*` + manifest | `ghcr.io/desplega-ai/agent-swarm-worker:<version>` (amd64 + arm64) |
| `publish-e2b-templates` | E2B release templates (`agent-swarm-api-<slug>`, worker/lead runtime) |
| `create-git-tag` | Pushes git tag `v<version>` |
| `publish-npm` | `@desplega.ai/agent-swarm@<version>` on npm (with provenance; skips if already published) |
| `create-release` | GitHub Release for `v<version>` with install instructions |

The Helm chart is published separately by `helm-publish.yml` when `charts/agent-swarm/Chart.yaml`'s `version` changes — which is exactly what `sync-chart-version` (and thus `prepare-release`) updates.

If you push to `main` **without** a version change, none of the publish jobs run — Docker images still build/deploy but aren't tagged with a release version. So a release is opt-in: it's defined by the `package.json` version bump.

### Swarm Cloud image-release callback

After the server and worker Docker manifest lists are published, the workflow posts one signed callback to Swarm Cloud's image-release intake endpoint. The callback is limited to the protected publish context: `desplega-ai/agent-swarm`, non-PR events, and `refs/heads/main`.

The callback reports the detected release version when `package.json` changed, matching the tag created by `create-git-tag`; ordinary `main` pushes report `main`.

The callback sends the manifest-list digest refs for the API and worker images, for example `ghcr.io/desplega-ai/agent-swarm:latest@sha256:...` and `ghcr.io/desplega-ai/agent-swarm-worker:latest@sha256:...`. The workflow builds `payload.json` with `jq`, signs the exact file bytes with HMAC-SHA256, and sends that same file with `curl --data-binary` so the signature matches Swarm Cloud's raw-body verification.

The repository must have the `SWARM_CLOUD_BASE_URL` and `IMAGE_RELEASE_INTAKE_SECRET` Actions secrets configured. If either is missing, the workflow emits a warning and skips only the callback; configured callbacks treat HTTP 200 and 201 as success and fail on other responses.

## Verifying a release

After the merge, confirm the `Docker Build + Publish + Deploy` workflow run is green, then spot-check:

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
