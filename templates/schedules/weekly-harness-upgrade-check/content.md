# Weekly Harness Upgrade Check

This is a topology-preserving, anonymized port of the live Sunday schedule. It keeps its bundle, deduplication, baseline, partial-fallback, and CI acceptance behavior.

```json
{"cron":"0 16 * * 0","timezone":"UTC","agentRole":"lead","enabled":true}
```

**Weekly Harness Upgrade — self-hosted repository Dockerfile.worker**

Repo: `{{REPO_URL}}` (working dir: `/workspace/repo`)
File: `Dockerfile.worker`

The worker image pins these harnesses via `ARG`. Each week, check upstream for new versions and open ONE PR bundling ALL outdated harness bumps together ({{PR_REVIEWER}}'s preference — bump ALL in one PR per run, do NOT stagger one-per-run).

| ARG | Source | Sync requirement |
|---|---|---|
| `CLAUDE_CODE_VERSION` | npm `@anthropic-ai/claude-code` | none |
| `PI_CODING_AGENT_VERSION` | npm `@earendil-works/pi-coding-agent` | MUST match `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` in `package.json` (family-pin, all same version) — bump all together |
| `CODEX_VERSION` | npm `@openai/codex` | MUST match `@openai/codex-sdk` in `package.json` (enforced by `scripts/check-codex-default-model.sh`) — bump both |
| `OPENCODE_VERSION` | https://opencode.ai (latest release) | MUST match `OPENCODE_SDK_VERSION` |
| `OPENCODE_SDK_VERSION` | npm `@opencode-ai/sdk` | MUST match `OPENCODE_VERSION` — bump both together |

## Steps

1. `cd /workspace/repo && git fetch origin && git checkout main && git pull --ff-only`
2. Read current pinned versions from `Dockerfile.worker` (the `ARG` lines) and from `package.json` (for the pi family + `@openai/codex-sdk` + `@opencode-ai/sdk`).
3. For each harness, fetch the latest version:
   - npm claude-code: `npm view @anthropic-ai/claude-code version`
   - npm pi: `npm view @earendil-works/pi-coding-agent version` (use the SAME version for `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` — they're a family pin)
   - npm codex: `npm view @openai/codex version`
   - npm opencode-sdk: `npm view @opencode-ai/sdk version`
   - opencode: `curl -fsSL https://api.github.com/repos/sst/opencode/releases/latest | jq -r .tag_name`
4. Check for an existing open bundled PR — `gh pr list --search "harness upgrade in:title" --state open --repo '{{REPO_URL}}'`. Look at the branch prefix `harness-upgrade/`. If one is already open AND was created within the last 48h (sibling schedule may have just opened it), skip and complete with `"Skipped: sibling harness upgrade PR already open"` + the existing PR URL.
5. Collect ALL outdated harnesses. If none are outdated, complete with output `"All harnesses up to date as of YYYY-MM-DD"` (no PR).
6. Branch: `harness-upgrade/weekly-YYYY-MM-DD` (e.g. `harness-upgrade/weekly-2026-06-03`).
7. Edit `Dockerfile.worker` — bump every outdated ARG. Also update `package.json`:
   - Codex: bump `@openai/codex-sdk` to match `CODEX_VERSION`.
   - Pi family: bump `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` to the same new version as `PI_CODING_AGENT_VERSION`.
   - Opencode: bump `OPENCODE_SDK_VERSION` and `@opencode-ai/sdk` to match `OPENCODE_VERSION`.
   Then re-run `bun install` so `bun.lock` updates.
8. Local verification (all must pass before pushing):
   ```bash
   bun install --frozen-lockfile
   bun run lint
   bun run tsc:check
   bun test
   bash scripts/check-db-boundary.sh
   ```
   For Codex bumps: also run `bash scripts/check-codex-default-model.sh`.
   Note: do NOT run `docker build -f Dockerfile.worker .` locally — the runner lacks docker. CI's `docker-worker-build` job is the acceptance gate.
9. If any local check fails, apply the **partial-bundle fallback** before giving up — one harness must never block the others:
   **BASELINE FIRST — do this before ANY isolation work.** A red gate does NOT mean the bumps broke anything. Re-run the EXACT failing command on a pristine `origin/main` worktree with zero bumps applied (`git worktree add /tmp/hb-baseline origin/main && cd /tmp/hb-baseline && bun install --frozen-lockfile`) and compare. If the SAME checks fail with the SAME assertions and the same pass/skip/fail totals, the failure is **PRE-EXISTING and unrelated to the bumps** ⇒ it does NOT block this PR, and you must NOT attempt isolation for it. Proceed to step 10, open the PR, and add a `## Pre-existing failures (also fail on origin/main)` section quoting the verbatim error plus both totals (baseline vs branch) so the reviewer can see they match. Only a failure that is RED on your branch and GREEN on baseline was caused by a bump — apply a–d below to that failure ONLY. A gate that is red on origin/main is never a reason to skip the weekly bump.
   a. Isolate which harness's bump caused it. The error usually names the package; if not, revert bumps one at a time until the step-8 gate passes.
   b. Revert ONLY that harness — its `Dockerfile.worker` ARG **and** its `package.json` pins (respect the family/sync requirements in the table above) — then re-run `bun install` and the FULL step-8 gate.
   c. Gate green ⇒ open the PR with the remaining harnesses and add a `## Held back` section naming the excluded harness, current → attempted version, and the VERBATIM error. Name it in your `store-progress` output too.
   d. Gate still red with that harness reverted, OR the failure cannot be isolated to one harness ⇒ do NOT open a PR; report via `store-progress` with `failureReason`.
   Migrating an upstream API break (a removed option, a renamed export, a moved type) is still OUT OF SCOPE for this routine — hold that harness back per (c) rather than changing code here.
10. Push the branch and open a PR:
    - Title: `chore(docker): bump harnesses (weekly YYYY-MM-DD)` — or list the bumps, e.g. `chore(docker): bump claude-code, pi, opencode (weekly YYYY-MM-DD)`.
    - Body: include a table of current → new versions for every harness bumped, link to each upstream changelog (e.g. https://github.com/anthropics/claude-code/releases/tag/v<X.Y.Z>), and the local verification output (or "all green").
    - Add `{{PR_REVIEWER}}` as a reviewer.
    - DO NOT merge — {{PR_REVIEWER}} reviews and merges.
11. Verify CI on the PR — wait for the merge-gate workflow to start, confirm at least the `docker-worker-build` job is queued/passing. If CI fails, comment on the PR with the failure log and leave the branch for human review.

## Constraints

- **ONE bundled PR per run.** Bump every outdated harness in the same PR — do not stagger one-per-run. The ONLY permitted exclusion is a harness held back by the step-9 partial-bundle fallback, which must be declared in the PR body.
- **No `--no-verify`, no force pushes.**
- If a harness has a major-version bump (e.g. 2.x → 3.x), still bundle it but flag clearly in the PR description that this is a major bump and may need extra review.
- Pi family-pin: all three pi packages MUST be the same version. If they drift in the lockfile, fix the drift in the same PR.

## Sibling-schedule coordination
This schedule has a sibling — `weekly-harness-upgrade-check-wed` (Wednesday 05:00 BCN). If a sibling-opened PR is OPEN and `< 48h` old, step 4 skips. This is the dedup gate. Don't change branch-naming heuristics in a way that breaks the dedup.

## Output

`store-progress` with `status: "completed"` and `output` containing:
- The PR URL (if one was opened) + the table of harnesses bumped, OR
- "No-op: all harnesses up to date as of YYYY-MM-DD" with the version table, OR
- "Skipped: sibling harness upgrade PR already open" with the existing PR URL.
