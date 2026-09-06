---
date: 2026-09-04
author: Claude
topic: "Slack visual E2E: screenshots and step GIFs from slack-mock, posted to the PR"
tags: [e2e, slack, slack-mock, ci, visuals]
status: implemented (PR #1338)
autonomy: yolo
---

# Slack visual E2E: screenshots + step GIFs from slack-mock, posted to the PR

Date: 2026-09-04. Owner: Taras. Orchestrator: Claude. Executors: Codex (slice A: sol, slice B: terra).

## Goal

On a PR that touches Slack rendering, CI runs the black-box E2E Slack scenarios twice
(legacy renderer and `SLACK_RENDER_V2=true`), renders one PNG per Slack event for each
scenario thread from the slack-mock journal, stitches a step GIF, publishes the images to
the `ci-visuals` branch, and upserts one sticky PR comment that shows legacy and v2 side by side.

Verified by hand on 2026-09-04 with zero code changes (see
`/tmp/2026-09-04-1215-comms-slack-visuals.md`): `bun run e2e --only slack-mention --keep`
produces a journal, `slack-mock serve --data <prefix>` replays any prefix of it, and
`slack-mock screenshot` renders thread, channel, and desktop views. Both renderers pass.

## Facts the implementation relies on

- Runner: `scripts/e2e/run.ts` boots `SlackMock.start({ port: 0, manifest: slack-manifest.json, dataFile? })`
  in `scripts/e2e/slack.ts`, then the API as a child in `scripts/e2e/sut.ts` (`startSut(keep, slackEnv)`;
  env is `minimalEnv()` + fixed keys + `slackEnv`). Options parse in `scripts/e2e/report.ts`.
- `ScenarioContext` fields: `api`, `connectMcp`, `baseUrl`, `apiKey`, `db`, `slack`, `log`, `nonce`.
- `@desplega.ai/slack-mock@0.1.2` exports `SlackMock`, `Store`, `screenshot(url, { out, width?, height?, timeoutMs? })`,
  `findChrome()`. `SlackMock.start` options include `port`, `seed`, `dataFile`, `manifest`, `log`.
  `mock.baseUrl`, `mock.stop()`, `mock.bot.userId`, `mock.bot.botId`, `mock.env`.
- HTML views: `/c/<channelId>`, `/c/<channelId>/t/<ts>`. `screenshot()` appends `screenshot=1`
  (no chrome, fixed width). `?screenshot=0` renders the desktop layout with the thread side panel.
- Journal: one JSON line per change, `{"at": ISO, "kind": "...", ...}`. Kinds seen:
  `user.add`, `channel.add`, `message.add`, `message.update`, `message.delete`, `reaction.add`,
  `reaction.remove`, `file.add`, `member.join`, `channel.update`, `view.open`. Message-bearing kinds
  carry `message: { ts, channel, thread_ts?, ... }`. A prefix of the file is a valid journal.
  `SlackMock.start({ dataFile: prefix, seed: false })` replays it.
- Chrome: `findChrome()` checks `/usr/bin/google-chrome` (present on `ubuntu-latest`) and macOS paths.
- Legacy flow for one ask: `message.add` (ask), `reaction.add` eyes, `message.add` ack with Cancel
  button, `message.update` ack -> outcome, `reaction.remove` eyes, `reaction.add` white_check_mark.
  v2 flow: tree `message.add`, outcome card `message.add` (streaming), card `message.update`,
  `reaction.remove`, tree `message.update`, `reaction.add`. Failure reaction is `x` (`src/slack/ack.ts`).
- `POST /api/tasks/{id}/finish` body: `{ status: "completed" | "failed", output?, failureReason?, force? }`.
- Boundary: `scripts/check-e2e-boundary.sh` forbids imports from `src/`, `apps/`, `packages/`, `@swarm/*`
  and `bun:sqlite` outside `scripts/e2e/db.ts`. Reading `src/` files for reference is fine.
- Typecheck: `bun run e2e:tsc` (tsconfig includes every `scripts/e2e/**/*.ts`). Lint: `node_modules/.bin/biome check scripts/e2e`.
- `bun run lint` (biome on `src apps/evals`) does not cover `scripts/`, so run the targeted biome check.
- ffmpeg is on `ubuntu-latest` and on Taras's Mac (`/opt/homebrew/bin/ffmpeg`).
- Repo is public. `raw.githubusercontent.com/<owner>/<repo>/ci-visuals/<path>` URLs render in PR comments
  through GitHub's image proxy. Put the head SHA in the path so every run has a fresh URL.

## Contracts (frozen; both slices depend on them)

### `manifest.json` (written by the runner into `<visualsDir>`)

```json
{
  "profile": "legacy",
  "sutEnv": { "SLACK_RENDER_V2": "true" },
  "journal": "slack-journal.jsonl",
  "slackManifest": "/abs/path/to/slack-manifest.json",
  "scenarios": [
    {
      "name": "slack-mention",
      "status": "pass",
      "durationMs": 3400,
      "error": null,
      "threads": [{ "label": "mention", "channel": "C0GENERAL0", "ts": "1788516626.286000" }]
    }
  ]
}
```

`profile` = basename of `<visualsDir>`. `journal` is relative to `<visualsDir>`. `sutEnv` is `{}` when no `--sut-env` was given.

### `index.json` (written by `scripts/e2e/visuals.ts` into `<visualsDir>`)

```json
{
  "profile": "legacy",
  "channel": "channel.png",
  "scenarios": [
    {
      "name": "slack-mention",
      "status": "pass",
      "error": null,
      "threads": [
        {
          "label": "mention",
          "channel": "C0GENERAL0",
          "ts": "1788516626.286000",
          "frames": [{ "file": "frames/slack-mention/mention/01-message.add.png", "index": 5, "kind": "message.add" }],
          "gif": "frames/slack-mention/mention/steps.gif",
          "finalThread": "frames/slack-mention/mention/final-thread.png",
          "finalDesktop": "frames/slack-mention/mention/final-desktop.png"
        }
      ]
    }
  ]
}
```

All paths are relative to `<visualsDir>`. `gif` is `null` when ffmpeg is missing. `index` is the
1-based journal line number the frame was rendered after.

### Published layout on the `ci-visuals` branch

```
pr-<number>/updated-at                      # ISO timestamp, one line
pr-<number>/<sha7>/<profile>/index.json
pr-<number>/<sha7>/<profile>/channel.png
pr-<number>/<sha7>/<profile>/frames/**
```

Comment image URL = `<base-url>/<profile>/<relative file from index.json>` where
`<base-url> = https://raw.githubusercontent.com/<owner>/<repo>/ci-visuals/pr-<number>/<sha7>`.

### Sticky comment marker

First line of the comment body: `<!-- slack-visuals -->`. The upsert step finds the existing
comment by that marker and PATCHes it, else POSTs.

## Slice A: runner, scenarios, frame renderer, docs (Codex sol, worktree `.claude/worktrees/slack-visuals`)

Files: `scripts/e2e/report.ts`, `scripts/e2e/run.ts`, `scripts/e2e/sut.ts`, `scripts/e2e/slack.ts`,
`scripts/e2e/scenarios/slack-mention.ts`, new `scripts/e2e/scenarios/slack-helpers.ts`,
new `scripts/e2e/scenarios/slack-follow-up.ts`, new `scripts/e2e/scenarios/slack-failed-task.ts`,
new `scripts/e2e/visuals.ts`, `package.json` (scripts only), `LOCAL_TESTING.md`.

### A1. Runner flags

- `--sut-env KEY=VALUE` (repeatable). Parsed into `options.sutEnv: Record<string, string>`.
  Reject a value without `=`. Passed as a third argument `extraEnv` to `startSut`, spread LAST so it
  overrides fixed keys.
- `--visuals <dir>`. `options.visualsDir`. The runner `mkdir -p`s it, deletes a stale
  `<dir>/slack-journal.jsonl`, and passes that path as the mock `dataFile` (independent of `--keep`).
  After all scenarios and before cleanup it writes `<dir>/manifest.json` (contract above).
- Update `helpText`.

### A2. `ctx.markThread(label, channel, ts)`

Add to `ScenarioContext`. Records `{ scenario: <running scenario name>, label, channel, ts }`.
Always records (cheap); only `--visuals` writes the manifest. The runner knows the running scenario
name because it calls `runScenario` sequentially. Labels are file-name safe (`[a-z0-9-]+`).

### A3. Shared Slack steps: `scripts/e2e/scenarios/slack-helpers.ts`

Functions (all take `ctx` first, all throw via `expect` with messages that name the channel and ts):

- `registerLead(ctx, name)` -> `leadId`. `POST /api/agents { name, isLead: true }`, expect 201.
  If the API rejects a second lead in one run, fall back to registering a non-lead worker and note it
  in the report; do not silently hide it.
- `ask(ctx, text, threadTs?)` -> message. `ctx.slack.postMessage({ channel: "general", user: "alice",
  text: \`<@${ctx.slack.bot.userId}> ${text}\`, thread_ts })`.
- `waitForReaction(ctx, ts, name, timeoutMs = 30_000)` polls `ctx.slack.messages("general")`.
- `waitForEyes(ctx, ts)` = `ctx.slack.waitForApiCall("reactions.add", { where: name === "eyes" && timestamp === ts })`.
- `findSlackTask(ctx, triggerTs)` polls `GET /api/tasks?source=slack&fields=full&limit=50` for
  `slackTriggerMessageTs === triggerTs || slackThreadTs === triggerTs`, returns the task record.
  For a follow-up, match on `slackTriggerMessageTs` only (the thread ts belongs to the first task).
- `claim(ctx, leadId, taskId)`: exactly one `GET /api/poll` as the lead, then poll the task until `in_progress`.
- `finish(ctx, leadId, taskId, body)`: `POST /api/tasks/{id}/finish`, expect 200.
- `waitForOutcome(ctx, threadTs, needle)`: `ctx.slack.waitForMessage(m => m.channel === "C0GENERAL0" && m.thread_ts === threadTs && JSON.stringify(m).includes(needle))`.

Refactor `slack-mention` to use them. Keep every assertion it has today (auth.test, connection count,
source column via `ctx.db`, pending status, outcome from the bot, white_check_mark). Add
`ctx.markThread("mention", "C0GENERAL0", ask.ts)`.

Visible text must not contain the nonce. Use plain English asks and outputs. Uniqueness comes from
the thread ts. Lead names: `e2e-lead-mention`, `e2e-lead-follow-up`, `e2e-lead-failed`.

### A4. New scenarios

`slack-follow-up`:
1. ask "summarize the release notes" -> eyes -> bot reply in thread -> task pending -> claim -> finish
   completed with output "Three changes shipped: faster polling, a new Slack tree, and cost badges." ->
   outcome in thread -> white_check_mark on the ask.
2. `ask("and now list the open follow-ups", ask.ts)` (a mention inside the same thread) -> eyes on the
   follow-up ts -> a NEW task whose `slackTriggerMessageTs === followUp.ts` and whose
   `slackThreadTs === ask.ts` (assert both) -> claim -> finish completed with output
   "Two follow-ups are open: docs refresh and the retention PR." -> outcome in thread containing that
   text -> white_check_mark on the follow-up ts.
3. `ctx.markThread("follow-up", "C0GENERAL0", ask.ts)`.
Hazard: `src/slack/handlers.ts` has an "additive" buffered path for thread messages. Mention the bot
in the follow-up so the direct path is taken. If the follow-up still does not create a task, read
`src/tests/slack-thread-followups.test.ts` and `src/slack/handlers.ts` around line 500 to see what the
router expects, and report what you found instead of weakening the assertion.

`slack-failed-task`:
1. ask "deploy the hotfix to staging" -> eyes -> task -> claim -> finish
   `{ status: "failed", output: "Deploy aborted: the staging database migration 131 failed a checksum.", failureReason: "migration checksum mismatch" }`.
2. wait for an outcome message from the bot in the thread whose JSON contains "checksum"; wait for the
   `x` reaction on the ask.
3. `ctx.markThread("failed", "C0GENERAL0", ask.ts)`.

Register both in `scenarios` in `run.ts` after `slackMention`.

### A5. `scripts/e2e/visuals.ts` (`bun run e2e:visuals <visualsDir> [--no-gif] [--height 700] [--width 800]`)

1. Read `manifest.json` and the journal lines (skip blank lines).
2. For every scenario thread: relevant line numbers K (1-based) are those whose `kind` is in
   `message.add | message.update | message.delete | reaction.add | reaction.remove | file.add` and whose
   `message.ts === ts || message.thread_ts === ts`.
3. For each K, in order: write lines `1..K` to `<tmp>/prefix-<K>.jsonl`; `SlackMock.start({ port: 0, seed: false, dataFile, manifest: slackManifest, log: false })`;
   `screenshot(\`${baseUrl}/c/${channel}/t/${ts}\`, { out, width, height })`; `mock.stop()`.
   Frame file: `frames/<scenario>/<label>/<NN>-<kind>.png`, NN zero-padded from 01.
4. After the last frame: copy it to `final-thread.png`; render `final-desktop.png` from the FULL journal
   with `?screenshot=0`, 1280x900.
5. Once per profile: `channel.png` = `/c/<channel of the first thread>` from the full journal, 800x700.
6. GIF: if `Bun.which("ffmpeg")` and not `--no-gif`: concat demuxer list with `duration 1.2` per frame
   and the last frame repeated once more, `-vf "fps=2,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer"`,
   output `steps.gif`. Missing ffmpeg: print one line and set `gif: null`.
7. Write `index.json` (contract above). Scenarios with status `fail`/`skip` keep their status and get
   whatever frames could be rendered (a failed scenario may still have a thread).
8. No Chrome: throw with the slack-mock error text. Do not swallow.
9. Clean the tmp prefix dir at the end (also on error).

Performance target: under 90 seconds for three scenarios on the CI runner. One Chrome spawn per frame is acceptable.

### A6. Scripts and docs

- `package.json`: `"e2e:visuals": "bun scripts/e2e/visuals.ts"`.
- `LOCAL_TESTING.md`, section `Black-box E2E (bun run e2e)`: document `--sut-env`, `--visuals`, and
  `bun run e2e:visuals`. Add the two-line local recipe (legacy then v2). Add the three Slack scenario names.

### A7. Verification (run all, paste output in the report)

```bash
bun run e2e:tsc
bash scripts/check-e2e-boundary.sh
node_modules/.bin/biome check scripts/e2e
env -u ANTHROPIC_API_KEY bun run e2e --only slack-mention,slack-follow-up,slack-failed-task --visuals /tmp/vis/legacy --json /tmp/vis/legacy.json
env -u ANTHROPIC_API_KEY bun run e2e --only slack-mention,slack-follow-up,slack-failed-task --sut-env SLACK_RENDER_V2=true --visuals /tmp/vis/v2 --json /tmp/vis/v2.json
bun run e2e:visuals /tmp/vis/legacy && bun run e2e:visuals /tmp/vis/v2
ls -R /tmp/vis/legacy/frames /tmp/vis/v2/frames
env -u ANTHROPIC_API_KEY bun run e2e        # full contract suite still green
```

Expected: every scenario PASS in both profiles; each thread has 5 or more frames; `steps.gif` exists;
`index.json` validates against the contract; full suite unchanged.

## Slice B: comment builder, publish script, workflow (Codex terra, worktree `.claude/worktrees/slack-visuals-ci`)

Files: new `scripts/e2e/visuals-comment.ts`, new `scripts/e2e/visuals-publish.sh`,
new `.github/workflows/slack-visuals.yml`. Do not touch `package.json`, `LOCAL_TESTING.md`, or any
slice A file. Build against the frozen `index.json` contract using a fixture you create under
`/tmp` (not in the repo).

### B1. `scripts/e2e/visuals-comment.ts`

`bun scripts/e2e/visuals-comment.ts --base-url URL --profile legacy=<dir> --profile v2=<dir> --out comment.md [--run-url URL] [--sha SHA]`

- Reads `<dir>/index.json` per profile. Profiles keep the given order.
- Output body (GitHub Markdown + inline HTML):
  1. `<!-- slack-visuals -->`
  2. `### Slack rendering preview` then one line: `Rendered by slack-mock from the black-box E2E journal. Commit <sha7>. [Workflow run](run-url).`
  3. For each scenario name (union across profiles, in first-seen order): `#### <name>`; a table with one
     column per profile (`| legacy | v2 |`), one row of `<img src="<url>" width="420">` for
     `finalThread`; a scenario whose status is not `pass` in a profile shows `**<STATUS>**: <error>` in that cell.
     Then `<details><summary>Step by step</summary>` containing the same table shape with the `gif`
     (or `no ffmpeg on the runner` when `gif` is null), then `</details>`.
  4. `<details><summary>Desktop layout and channel</summary>` with, per scenario, the `finalDesktop`
     images side by side, and at the end the `channel` image per profile. `</details>`
- Image URL = `${baseUrl}/${profile}/${file}`. No trailing-slash bugs: normalise.
- Keep the body under 60,000 characters; if over, drop the desktop section first, then the step section,
  and say so in a final line.
- Exit non-zero on a missing `index.json`.

### B2. `scripts/e2e/visuals-publish.sh`

`bash scripts/e2e/visuals-publish.sh <out-root> <pr-number> <head-sha>`; prints `base_url=<url>` on the last line.

- `<out-root>` contains one dir per profile (`legacy/`, `v2/`), each with `index.json`, `channel.png`, `frames/`.
- Branch `ci-visuals`, always ONE commit deep (rebuilt every run, so history never grows):
  1. `git fetch origin ci-visuals` (tolerate absence). Remember the fetched SHA or empty.
  2. `git worktree add --detach <tmp>` then in it `git checkout --orphan ci-visuals-build`; if the remote
     branch existed, `git checkout <fetched-sha> -- .` to restore its files, else start empty.
  3. `rm -rf pr-<n>`; copy each profile dir into `pr-<n>/<sha7>/<profile>/` (only `index.json`, `channel.png`, `frames/`);
     write `pr-<n>/updated-at` with `date -u +%FT%TZ`.
  4. Prune every `pr-*/` whose `updated-at` is older than 30 days (skip dirs without the file).
  5. `git add -A`, commit as `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`
     with message `visuals: pr-<n> <sha7>`.
  6. `git push --force-with-lease=refs/heads/ci-visuals:<fetched-sha-or-empty> origin HEAD:refs/heads/ci-visuals`.
     On rejection: remove the tmp worktree and retry from step 1, at most 3 attempts. Fail loudly after that.
  7. Remove the tmp worktree and the `ci-visuals-build` branch.
- Derive `<owner>/<repo>` from `GITHUB_REPOSITORY` (fallback: parse `git remote get-url origin`).
- Base URL: `https://raw.githubusercontent.com/<owner>/<repo>/ci-visuals/pr-<n>/<sha7>`.
- `set -euo pipefail`, shellcheck-clean (`bunx shellcheck` if available, else review by eye).
- Local test (run it, paste output): `git init --bare /tmp/visuals-remote.git`, clone a scratch repo with
  `origin` pointing at it, create a fake `<out-root>` with two profiles from a fixture, run the script twice
  with different SHAs, confirm the branch has one commit and `pr-<n>/` holds only the latest SHA dir.

### B3. `.github/workflows/slack-visuals.yml`

```yaml
name: Slack Visuals
on:
  pull_request:
    paths:
      - "src/slack/**"
      - "src/prompts/**"
      - "scripts/e2e/**"
      - "slack-manifest.json"
      - "bun.lock"
      - ".github/workflows/slack-visuals.yml"
  workflow_dispatch:
concurrency:
  group: slack-visuals-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

One job `visuals`, `runs-on: ubuntu-latest`, `timeout-minutes: 20`,
`permissions: { contents: write, pull-requests: write }`,
`if: github.repository == 'desplega-ai/agent-swarm' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)`.

Steps (pin actions to the SHAs used in `.github/workflows/merge-gate.yml`: checkout `3d3c42e5aac5ba805825da76410c181273ba90b1`, setup-bun `0c5077e51419868618aeaa5fe8019c62421857d6` with `bun-version-file: package.json`, upload-artifact `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`):

1. checkout, setup-bun, `bun install --frozen-lockfile`.
2. `id: legacy`, `continue-on-error: true`: `bun run e2e --only slack-mention,slack-follow-up,slack-failed-task --visuals visuals/legacy --json visuals/legacy.json`
3. `id: v2`, `continue-on-error: true`: same with `--sut-env SLACK_RENDER_V2=true --visuals visuals/v2 --json visuals/v2.json`
4. `if: always()`: `bun run e2e:visuals visuals/legacy; bun run e2e:visuals visuals/v2` (each guarded by `test -f <dir>/manifest.json`).
5. `if: always()`: upload-artifact `slack-visuals` with `visuals/`.
6. `if: always() && github.event_name == 'pull_request'`, `id: publish`: run `visuals-publish.sh visuals <pr> <head sha>`; parse the `base_url=` line into a step output.
7. same condition: build the comment with `visuals-comment.ts --run-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --sha <head sha>`, then upsert with `gh api` using `GH_TOKEN: ${{ github.token }}`: list `repos/$REPO/issues/$PR/comments --paginate`, find the body starting with the marker, PATCH `repos/$REPO/issues/comments/$ID` else POST.
8. `if: always()`: fail the job when `steps.legacy.outcome != 'success' || steps.v2.outcome != 'success'`.

Add a header comment in the YAML that explains: informational job, not in the merge gate; images live on
the single-commit `ci-visuals` branch; fork PRs get artifacts only.

### B4. Verification (paste output)

```bash
bun run e2e:tsc                                   # the new .ts compiles
node_modules/.bin/biome check scripts/e2e
bash scripts/check-e2e-boundary.sh
bun scripts/e2e/visuals-comment.ts --base-url https://example.test/base --profile legacy=/tmp/fx/legacy --profile v2=/tmp/fx/v2 --out /tmp/fx/comment.md --run-url https://example.test/run --sha 0123456789abcdef && cat /tmp/fx/comment.md
bash scripts/e2e/visuals-publish.sh /tmp/fx 123 0123456789abcdef    # against the local bare remote
bunx actionlint .github/workflows/slack-visuals.yml 2>/dev/null || echo "actionlint unavailable; reviewed by eye"
```

## Non-goals (both slices)

- No changes under `src/`. No new dependencies. No agent-browser or Playwright.
- No pixel diffing, no baseline images in the repo.
- No changes to `nightly-e2e.yml` or `merge-gate.yml`.
- Do not edit this plan file. Do not `git commit` (linked worktree; the orchestrator commits).

## Follow-ups (not in this PR)

- DONE 2026-09-04: slack-mock 0.2.0 shipped `frames()`; `visuals.ts` now calls it per thread and only
  boots one `SlackMock` for the channel screenshot. Note: `file.add` lines never produce a frame (the
  file shows in the frame of the message that shares it).
- Delegation scenario (child task nested under the parent in the v2 tree).
- `/agent-swarm-status` ephemeral capture.
- Prune `pr-*` dirs for closed PRs by API instead of the 30-day rule.

## Manual E2E (after merge of both slices, on the PR itself)

```bash
# local
env -u ANTHROPIC_API_KEY bun run e2e --only slack-mention,slack-follow-up,slack-failed-task --visuals /tmp/vis/legacy
env -u ANTHROPIC_API_KEY bun run e2e --only slack-mention,slack-follow-up,slack-failed-task --sut-env SLACK_RENDER_V2=true --visuals /tmp/vis/v2
bun run e2e:visuals /tmp/vis/legacy && bun run e2e:visuals /tmp/vis/v2
bun scripts/e2e/visuals-comment.ts --base-url file:///tmp/vis --profile legacy=/tmp/vis/legacy --profile v2=/tmp/vis/v2 --out /tmp/vis/comment.md
open /tmp/vis/legacy/frames/slack-follow-up/follow-up/steps.gif
# CI: open the PR, wait for "Slack Visuals", check the sticky comment renders both columns,
# push a second commit, confirm the same comment is updated and the ci-visuals branch has one commit.
gh api repos/desplega-ai/agent-swarm/branches/ci-visuals --jq '.commit.sha'
```
