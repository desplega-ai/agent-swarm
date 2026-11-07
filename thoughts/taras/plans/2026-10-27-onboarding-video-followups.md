---
date: 2026-10-27
topic: Onboarding video follow-ups (skills, product issues, codex-exec, record mode)
status: ready
---

# Onboarding video follow-ups

Use a workflow (Workflow tool) for this: one track per task below, run in parallel. Tracks that change code work
in their own git worktree. The main session reads every diff, commits, pushes and opens the PRs. Never merge a PR.

## Context

The onboarding demo video is done and approved (2026-10-27, round 5). Everything is pushed:

- Videos repo `~/Documents/videos/swarm` (github.com/desplega-ai/agent-swarm-videos, main): `2cc832e` voice (audio
  tags, tempo), `c2e997e` capture scripts, `3ea49eb` onboarding template, `6972f8e` README cut
  `final/onboarding/onboarding-readme.mp4`.
- agent-swarm PR #2515 swaps the README hero video. All checks green. Not merged (waits for Taras).
- Decision log: `assets/edit/project.md` (Session 17, rounds 1 to 5). Template notes:
  `skills/video-swarm/TEMPLATES.md` (onboarding section). Capture notes and product findings:
  `templates/onboarding/assets/source-notes.md`.
- Memory: `project_onboarding_video.md`.

## Rules for every track

- Prose: STE style, no em dashes, times in BCN. Never print a credential.
- Browser: agent-browser only, always with `AGENT_BROWSER_SESSION=<name>`, close it at the end. Never qa-use.
- Videos repo: commit straight to main (its history does that). agent-swarm and ai-toolbox: a worktree under
  `~/worktrees/<repo>/`, a branch, a PR. agent-swarm PRs follow `.github/pull_request_template.md`; check with
  `bun scripts/check-pr-body.ts --title "<t>" --body-file <f> --author tarasyarema`. Urgency: nice to have.
  Never touch CHANGELOG.md.
- Commit messages end with the Claude-Session line from the session's attribution reminder.
- Clean up at the end: worktrees, `/tmp/<task>-*`, boxes (`box.sh list` empty), `df -h /` before and after.

## Track 1: video-swarm skill (videos repo)

Move the general learnings out of the onboarding notes into the skill, so the next template gets them.

- `skills/video-swarm/SKILL.md`, voice section: `eleven_v4` is the newest model on our key (check
  `GET /v1/models`). It acts out audio tags (`[playfully]`, `[calmly]`); `packages/voice/src/timing.ts` strips
  tags from word timings and captions, and older models and `say` get the text without them. v4 ignores `speed`,
  `style` and speaker boost: pace with `tempo` (ffmpeg atempo after synthesis, reuses the cached take). Takes
  vary per call. Check a take with Scribe (no tag read aloud) and with pitch statistics for tone (the `[excited]`
  multiplayer take sat at a 198 Hz median against 124 Hz for the other lines; Taras found it "too much").
- `skills/video-swarm/EPISODES.md`, technical traps (Remotion 4.0.523):
  - A Sequence whose `from` and `durationInFrames` round separately leaves one-frame gaps: tile Sequences from
    rounded boundaries, and pick the current cut on the same frames.
  - `Freeze` + `OffthreadVideo` mounted for one frame renders blank: draw held frames as JPEG stills that
    prepare() extracts with ffmpeg.
  - A frozen `OffthreadVideo` re-seeked every frame stuck on one frame at 158x: cut fast timelapses into their
    own clips with ffmpeg in prepare(). ffmpeg's expression parser fails (ENOMEM) past a few dozen `eq(n,N)`
    terms: select 24 frames per call into PNGs, then encode. Pick the darkest frame within 6 source frames of
    each target, so a half-painted repaint never lands.
  - The last cut must hold its last frame into the ending (draft 7 showed a blank window there).
- Render checks (SKILL.md "Verify a render"): the entropy scan for blank frames (command in TEMPLATES.md,
  onboarding section), and an OCR pass for secrets: `tesseract` on frames (1 fps on the source capture, every
  frame of a timelapse clip, 4 fps on the render), grep `apikey=` and runs of 24+ hex characters, print only
  file names. A timelapse that starts to work can show output a stuck one hid (round 4 found an API key that way).
- Judge-panel recipe (new SKILL.md section): render variants with `renderMedia` at `scale: 0.4`, `muted`,
  `frameRange`; contact sheets at 4 fps with a time label per tile; judges: Codex
  `codex exec -m gpt-6-astra -c 'model_reasoning_effort="xhigh"' -s read-only --skip-git-repo-check -C <dir> -i <img>... -o <out> -`
  and a Fable Agent that reads the images. Judges cannot hear audio. Put the time label outside the frame (a strip
  above each tile): a label in the corner hid the stage chip, and a judge reported it as a clipped word.
- Add `scripts/contact-sheet.py` (python3 + PIL; this ffmpeg build has no drawtext): input mp4, segments, fps,
  columns; output time-labeled sheets. Test it on `final/onboarding/onboarding-readme.mp4`.
- Done when: the docs read clean, `bun run typecheck` passes, the script makes a sheet, committed and pushed.

## Track 2: product issues (agent-swarm)

File one issue per finding with the bug form (`.github/ISSUE_TEMPLATE/bug_report.yml`): `gh issue create` skips
forms, so write each form field label as a `### <label>` heading and apply the form's label. Search for
duplicates first. Reproduce on current main or the latest release where you can (a ui-mode box from the
onboarding-qa skill), else cite the 2026-10-27 takes (v2.7.1, fresh Hetzner box, hosted dashboard).

1. Agents step: the first Continue failed with the toast "A model change did not save". The Lead's
   `PUT /api/agents/<id>/profile` returned 400. Picking Cheap, then Optimal again, made Continue work.
2. A new teammate's first visit to Home says "Welcome back, Sam Chen".
3. After the first task is sent from `/setup`, the session page shows a full-page loading screen (a spinner on
   a blank page) for about 0.35 s before it paints.
4. The install summary ("Your swarm is running!") prints the dashboard URL with `apiKey=<key>` in clear text,
   before the final `/setup` link. Screen shares, recordings and CI logs show it. Check the current `install.sh`
   and onboard CLI first; suggest masking the key in the summary and keeping one link.

Done when: four issues filed (or linked to existing ones), numbers listed in the final report.

## Track 3: codex-exec.sh (ai-toolbox)

`~/Documents/code/ai-toolbox/cc-plugin/base/skills/delegate-work/scripts/codex-exec.sh` cannot run a judge or
review outside a git repo, and cannot attach images:

- Pass `--skip-git-repo-check` when the `-C` directory is not inside a git work tree (or always, if that is
  safe; decide and say why).
- Add a repeatable `-i|--image <file>` flag forwarded to `codex exec -i`.
- Update the usage block in the script and the codex section of `delegate-work/SKILL.md`. Follow the repo's
  version-bump convention for the plugin.
- Prove it: run the script on a temp directory outside git with one image and a one-line prompt, and read the
  output file.
- Done when: a PR on ai-toolbox is open, not merged.

## Track 4: onboarding-qa record mode (agent-swarm)

Fold the hand-run demo recording into `.claude/internal-skills/onboarding-qa` (rule: skillify ad-hoc infra).
Today it lives only in `templates/onboarding/assets/source-notes.md` (videos repo) and the session memory.

- New mode `record` (SKILL.md section plus scripts under `scripts/`):
  - A box with no telemetry: `/etc/hosts` maps `proxy.desplega.sh` to 127.0.0.1, iptables REJECT on the proxy IP
    in `OUTPUT`, `FORWARD` and `DOCKER-USER` (resolve the IP at run time; it was 138.201.124.181), and
    `ANONYMIZED_TELEMETRY=false` in the shell. Check whether the latest release already keeps test swarms out
    of telemetry (#2499) and say what the block still adds.
  - Terminal take: unzip installed off camera (the Hetzner docker-ce image lacks it), the packaged ttyd service
    disabled, ttyd started by hand with the light theme (Menlo 17, amber prompt), a `resize` event after load.
  - Browser takes: agent-browser with `--args "--force-device-scale-factor=2"` and `set viewport 1440 900 2`,
    light mode via `localStorage.setItem('agent-swarm-mode','light')` on app.agent-swarm.dev, clicks with
    `--human`, typing with the videos repo's `scripts/cdp-type.ts`, capture with `scripts/screencast.ts`, marks
    with `window.__onbvidMark('label')`. Secrets go in with `secrets.sh fill`, never typed on camera.
  - Outputs per clip: `capture.mp4`, `capture.json`, and where needed `mask.json` and `link.json` (formats in
    the template's source notes), written into the videos repo's `assets/onboarding/raw/<clip>/`.
- Live-test once: record a short terminal take on a fresh box, check that it sent no telemetry
  (`telemetry.sh`), tear the box down, `box.sh list` empty.
- Done when: a PR on agent-swarm is open (not merged), with the live-test result in Verified.

## Final report

One message: per track, what changed, links (commits, PRs, issues), what was verified, and anything left open.
