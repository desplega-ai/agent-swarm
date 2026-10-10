# Open-Prompt Motion-Graphics Videos, Made by Your Swarm

An Agent-Swarm playbook template for making design-led motion-graphics videos (showreels, eval comparisons, "we found N bugs" stories, launch clips) from one open prompt. One Claude Code worker on Opus at max effort designs, codes, renders and critiques the whole video in a scratch directory. The Lead briefs it, reviews the frames, and relays the result.

The worked example is a 24-second video about a model checker finding race conditions in Agent Swarm itself. It is on the docs page for this playbook, with its contact sheet.

## What You Get

- A 15-30 second video, 1920x1080 (and 1080x1350 for feeds), h264 yuv420p, with music you are allowed to use, a credit line on the end card, and the full attribution in the post.
- Every number on screen read live from a named source into `facts.json` right before render.
- The real Agent Swarm logo on the end card, never a redrawn one.
- A contact sheet per critique round, so a reviewer sees what the maker saw.
- Delivery to agent-fs, with a share link per mp4.

## Template Files

`templates/community/open-prompt-showreel/`:

- `PLAYBOOK.md`: this playbook.
- `README.md`: quick start.
- `lead-prompt.md`: the one-time setup prompt, the per-video brief, and the feedback-round brief.
- `setup.sh`: idempotent toolchain setup for a worker container.
- `tools/`: `render.mjs`, `sheet.sh`, `music-analyze.py`, `music-refine.py`, `music-cut.sh`, `music-current.sh`, `fetch-music.sh`, `x-reencode.sh`, `web-compress.sh`.
- `skills/`: sanitized copies of `open-prompt-showreel`, `video-generation`, `motion-design-video-analysis`, `motion-design-replication`.
- `example/tla-races/`: the finished reel (`reel.html`), the facts script (`facts.ts`), the facts it produced (`facts.v3.json`), and `smoke.sh`.

## Roles

| Role | Does |
|---|---|
| Lead | Writes the brief from the requester's words, sets model and effort, reviews frames before relaying, relays the links. |
| Maker | A Claude Code harness worker (provider `claude`) on the full worker image. Runs on `claude-opus-5-5` at `max` effort. Writes the facts script, the reel, the music cut; renders; critiques; delivers. |

Codex, pi and other harnesses were not tried for this workflow. Do not route it to them without a test run.

## Setup, Start to Finish

Everything below was run in a worker container (x86_64, node 22.23.3, bun 1.4.0, python 3.12.3) unless it is marked **not run**.

### 1. What the worker image already has

| Tool | In the stock full worker image | Notes |
|---|---|---|
| node, npm, bun, git, gh, curl, tar | yes | |
| python3 + venv + pip | yes | system `pip install` is blocked by PEP 668; use a venv |
| numpy | **no** | `setup.sh` installs it in a venv |
| ffmpeg 7.0.2 (static) | yes | has libx264, aac, `xstack`, `atempo`, `loudnorm`, `ass`; **no `drawtext`, no `ffprobe`** |
| playwright 1.58.0 | yes, `/opt/global-deps-full/node_modules` | |
| Chromium 145 | yes, `/opt/playwright` | `PLAYWRIGHT_BROWSERS_PATH` is already set |
| agent-fs CLI 0.15.0 | yes | |

### 2. Install the template on the maker

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/desplega-ai/agent-swarm.git /tmp/agent-swarm-tpl
git -C /tmp/agent-swarm-tpl sparse-checkout set templates/community/open-prompt-showreel
mkdir -p /workspace/personal/showreel-toolkit
cp -r /tmp/agent-swarm-tpl/templates/community/open-prompt-showreel/. /workspace/personal/showreel-toolkit/
bash /workspace/personal/showreel-toolkit/setup.sh
```

`/workspace/personal` is the path that survives a container restart. Do not install into `$HOME`.

`setup.sh` does, in order, and skips whatever is already there:

1. Checks node, npm, bun, python3, curl, tar.
2. Checks ffmpeg has libx264; otherwise installs the pinned static build (version and sha256 match `Dockerfile.worker`).
3. Installs `ffprobe` from the same tarball (`INSTALL_FFPROBE=0` to skip).
4. Checks Playwright and launches Chromium once; otherwise `npm install playwright@1.58.0` and `playwright install chromium`.
5. Creates `.venv` and installs numpy.
6. Downloads Space Grotesk, JetBrains Mono and Instrument Serif Italic from `google/fonts` (SIL OFL) and checks each against a pinned sha256.
7. Downloads the Agent Swarm logo from agent-swarm.dev and from `apps/ui/public/logo.png` on main, and warns if they differ.
8. Copies `tools/`, `example/` and itself, and writes `env.sh` (PATH, fonts, logo, Playwright paths).

Measured on a clean directory: 17.6 s with ffprobe, numpy and fonts. A second run took 0.9 s and installed nothing.

### 3. Re-run setup at every container start

Append to the maker's `setupScript` (the `update-profile` tool, field `setupScript`). Keep what is already there.

```bash
# Showreel toolchain: idempotent, no-ops when already installed.
[ -f /workspace/personal/showreel-toolkit/setup.sh ] && bash /workspace/personal/showreel-toolkit/setup.sh >> /workspace/personal/showreel-toolkit/setup.log 2>&1 || true
```

**Not run** for this playbook: changing a live profile. The `setup.sh` line it calls was run from a clean directory.

### 4. Prove the toolchain with the smoke test

```bash
. /workspace/personal/showreel-toolkit/env.sh
cd /workspace/personal/showreel-toolkit/example/tla-races && bash smoke.sh
```

It renders the example reel to a 16-frame contact sheet and a 2-second mp4 at 960x540 with a generated tone as the audio track. It checks the pixel format and the AAC stream, then renders once more with a broken audio file and checks that `render.mjs` exits non-zero and leaves no mp4. Expected lines: `OK: yuv420p 960x540`, `OK: aac audio`, `OK: failed encode exits non-zero`. It needs no network, no `gh`, no agent-fs. It took 8.8 s.

### 5. Install the skills

For each `skills/<name>/SKILL.md`, a Lead calls `skill-create` with the file content and `scope: "swarm"`, then `skill-install` on the maker (and `open-prompt-showreel` on itself).

**Not run** for this playbook: `skill-create` writes to a live swarm. The four files do parse with the repo's `parseSkillContent`, which is what `skill-create` calls, and each name matches its directory.

`swarm-studio` and `studio-api`, the fixed-template skills that the original `open-prompt-showreel` skill points at, are not shipped. They sit on a private repo and a hosted renderer. If your swarm has a template toolkit, route fixed-template asks there.

### 6. Model and effort

Set both on every maker task. They are fields of `send-task`:

```text
model:  claude-opus-5-5
effort: max
agentId: <maker>
```

Every brief ends with a gate: "If you are not on claude-opus-5-5, stop and say so instead of rendering."

### 7. agent-fs delivery

The maker uploads to `thoughts/<maker-agent-id>/videos/<slug>/` (versions as `<slug>-v2`, `<slug>-v3`; never overwrite). After each non-trivial write, check the size: `agent-fs stat <path> --json | jq '.size'`.

```bash
agent-fs --org <ORG_ID> --drive <DRIVE_ID> write thoughts/<maker-agent-id>/videos/<slug>/<file>.mp4 --file ./out/<file>.mp4
agent-fs --org <ORG_ID> --drive <DRIVE_ID> share-create thoughts/<maker-agent-id>/videos/<slug>/<file>.mp4 --expires-in 604800 --json
```

A share link opens a player with no login and expires in 7 days at most. Report the url, the share id and the expiry. A raw signed URL downloads instead of playing, and agent-fs serves a raw `.mp4` as `application/octet-stream`. For a byte-exact copy back down: `agent-fs download <path> -o <file>` (`cat` is paginated and truncates).

**Not run** for this playbook: `write` to a real drive and `share-create` (it publishes a public link). `write --file`, `share-create` and `signed-url --inline` flags were checked against the CLI's `--help`. `agent-fs download` was run on the example master.

## How One Video Gets Made

```text
Lead brief -> facts.ts -> reel.html -> render.mjs stills -> contact sheet -> fix -> (x3) -> music cut -> render -> agent-fs -> Lead review -> relay
```

### Brief

One task, one open prompt. The brief template is in `lead-prompt.md`. Do not write a storyboard, shot list, palette or template for the maker; earlier templated cuts read as generic. Hard rules go in, design rules stay out:

- **Content rule:** every number or claim on screen comes from a named source and matches it exactly. Anything not in the source stays off screen. Fewer numbers is fine.
- **Real brand:** the logo is `apps/ui/public/logo.png`, never a redrawn mark.
- **Music:** CC0 or CC BY only. Short credit on the end card; source link, license link and the changes made in the output.
- **Process:** a contact sheet looked at least 3 times.

### Facts before design

The maker writes `facts.ts` and runs `bun facts.ts > facts.json`. The reel reads `facts.json`; nothing is hard-coded. The example script `example/tla-races/facts.ts` reads:

| On screen | Source | How it is read |
|---|---|---|
| Whether each of 7 workflow races is red or green | `src/tests/workflow-tla-races.test.ts` on `origin/main` | `git show origin/main:<file>`; a regex over `test.failing("CXn: ...")` (red) vs `test("CXn: ...")` (green) |
| Which PR fixes which race | open and merged PRs | a PR fixes `CXn` when its diff replaces `test.failing("CXn:` with `test("CXn:`; merged PRs come from `gh api commits/<sha>/pulls` over the file's history |
| 3 heartbeat bugs: fix PR, violated invariant, 5-step trace, regression test | merged PRs whose body cites a TLC trace in `specs/tla/heartbeat` | `gh pr list --search`, a regex over the PR body, the added test from `gh api pulls/N/files`, then `git cat-file -e origin/main:<test>` |
| State counts and status views | a model-checking write-up | table rows read from the markdown; carried over and labelled `carried` when the write-up is not configured |
| Short SHA in the footer | `git rev-parse --short origin/main` | |

Rules the maker follows:

- A fact turns green only if main says so. A PR that is merged in the brief but not on main stays red.
- If the source disagrees with the brief, the source wins and the output says so.
- Draft numbers never ship. If the source is not ready, build the design on draft facts, `defer-task` with `wakeOn:{event:"settled",taskIds:[...]}`, and re-read on wake.

### The reel

One `reel.html` draws each frame on a `<canvas>` as a pure function of the frame number. It exposes two functions, which `tools/render.mjs` drives with Playwright:

```js
window.boot = async (facts, fonts, logo) => { /* load fonts + logo, stash facts */ };
window.frame = (f) => { render(f); return cv.toDataURL("image/png"); };
```

Stills for contact sheets:

```bash
. /workspace/personal/showreel-toolkit/env.sh
TK=/workspace/personal/showreel-toolkit
cd /workspace/personal/<slug>
export REEL=reel.html FACTS=facts.json MUSIC=music/<track>.json   # the credit file from fetch-music.sh is enough for stills
bash $TK/tools/sheet.sh 1920 1080 r1                       # 16 frames, 4x4 -> r1.png
COLS=5 bash $TK/tools/sheet.sh 1920 1080 t1 "180,183,185,187,189,190,191,192,193,194,196,198,200,203,206,209,212,215,220,230"
```

The full render, with audio. It needs `music/current.json` from the Music section below (it carries the `wav` field; a `--music` file without `wav` renders a silent video and `render.mjs` warns). `render.mjs` creates the output directory and exits non-zero if ffmpeg fails:

```bash
node $TK/tools/render.mjs --reel reel.html --w 1920 --h 1080 --facts facts.json \
  --logo $LOGO --fonts "$FONTS" --music music/current.json --out out/<slug>-1920x1080.mp4
```

`render.mjs` pipes PNG frames to ffmpeg with `-pix_fmt yuv420p`, h264 High, `-crf 16`, AAC 192k and `+faststart`. The 720-frame 1080p render of the example took about 3.5 minutes (frame 600 at 167 s).

Layout is responsive to `?w=&h=`, so the 4:5 cut is a second render at 1080x1350, not a crop.

### The critique loop

At least three rounds. Each round:

1. Render a 16-frame contact sheet and **look at it** (Read the PNG).
2. Render a 20-frame transition strip around each cut to catch pops and empty frames.
3. Write down what is weak: dead space, text too small for a phone, a cramped 4:5, jumpy easing, a hit off the beat. Fix it.

The last round checks every on-screen number against `facts.json` and the source, and opens the end-card frame alone at full size to confirm the logo and the credit line. Keep every round's sheet (`r1-16x9.png`, `r2-16x9.png`, ...).

### Music

CC0 or CC BY only. No NC (it is a company post), no ND (the track is cut and stretched) and no SA (it would carry over to the video). Pick a fresh track for each video.

```bash
bash $TK/tools/fetch-music.sh incompetech Voltaic music                       # Kevin MacLeod, CC BY 4.0
bash $TK/tools/fetch-music.sh url https://opengameart.org/sites/default/files/mist_city.ogg music \
  "Mist City" Section7 "CC BY 4.0" https://opengameart.org/content/mist-city
bash $TK/tools/fetch-music.sh url https://example.com/x.mp3 music "Nope" Someone "CC BY-NC 4.0" https://example.com   # refused
```

Both downloads were byte-identical to the files used for the example video. The script accepts only CC0 1.0 and CC BY 1.0 to 4.0, matched case-insensitively (`cc-by 4.0` works), and refuses NC, ND, SA, "All rights reserved" and any string it does not know. It cannot check the source page, so read the license there yourself. It writes `music/<slug>.json` with the license link and a short `credit` for the end card.

To time the cut to the music, find tempo, beat phase and the drop, then stretch the track so the beats sit on the frame grid and the drop lands on the key reveal. Then write `music/current.json`, the file the render reads:

```bash
python3 $TK/tools/music-analyze.py music/voltaic.mp3     # bpm, beat phase, top drop candidates (json)
python3 $TK/tools/music-refine.py music/voltaic.mp3 <bpm> <drop_sec>
bash $TK/tools/music-cut.sh music/voltaic.mp3 <bpm> <drop_sec> music/cut.wav     # TARGET_BPM=120 DROP_AT=14 DUR=24 by default
bash $TK/tools/music-current.sh music/voltaic.json music/cut.wav                  # writes music/current.json
```

At 30 fps and 120 BPM a beat is 15 frames. On the example track the analyzer returned 120.2 BPM and a strongest drop candidate at 143.3 s. `music-cut.sh` fades in 0.3 s and out 1.7 s, and `DIP=1` ducks the track just before the drop.

`music-current.sh` copies the track json to `music/current.json` and adds `"wav": "music/cut.wav"` (which `render.mjs` muxes in as AAC) and `attribution`. CC BY needs a link to the source, a link to the license and a notice that the track was changed, so the post carries the whole `attribution` string, for example:

```text
"Mist City" by Section7, https://opengameart.org/content/mist-city, licensed under CC BY 4.0, https://creativecommons.org/licenses/by/4.0/. Changes: trimmed, time-stretched to the video's beat grid, faded in and out, and loudness-normalized.
```

Set `MODIFIED="..."` to describe the edits more exactly. The short `credit` stays on the end card.

### Re-encode for X when the source is full range

The reel pipeline already writes limited-range `yuv420p`. A clip from a screen recording, a JPEG pipeline or `remotion render` may be tagged `yuvj420p` (full range, "pc"). Re-encode it:

```bash
bash $TK/tools/x-reencode.sh in.mp4 out.mp4
# before: h264 (High) ... yuvj420p(pc, progressive) ...
# after:  h264 (High) ... yuv420p(tv, bt709, progressive) ...
```

The ffmpeg side is reproduced: `remotion render` 4.0.532 wrote `yuvj420p(pc, bt470bg)` by default and `yuv420p(tv, bt709)` with `--color-space=bt709`. That X mishandles full-range files is a field report from our own posting runs; it was not reproduced here.

### Web copy for docs and PRs

```bash
bash $TK/tools/web-compress.sh out/<slug>-1920x1080.mp4 docs-site/public/<dir> <name> 16.5
```

Writes a 1280-wide mp4 and a poster jpg. The 17.8 MB master of the example became 2.6 MB. Commit the small copy, not the master. A signed agent-fs URL expires; a file in the repo does not.

### Lead review before relay

The maker's output is not the finish line. Before relaying, the Lead:

1. Opens the contact sheet and looks at the frames, not just the file list.
2. Opens the end-card frame: real logo, credit line present and readable.
3. Checks every on-screen number against the maker's `facts.json`, and `facts.json` against the source named in the brief.
4. Checks the ffprobe line: `h264`, `yuv420p`, exactly 1920x1080 (and 1080x1350), duration as briefed, and an `aac` audio stream when the video has music. (`ffprobe` after `setup.sh`, or `ffmpeg -i` stderr in the stock image.)
5. Plays the share link once.
6. Relays the share link, the share id and the expiry, plus the `attribution` string from `music/current.json` (source link, license link, changes made). The maker never posts.

## Known Gotchas

| Gotcha | What happens | What to do |
|---|---|---|
| No `ffprobe` in the worker image | `ffprobe: command not found` | `ffmpeg -hide_banner -i f.mp4 2>&1 \| grep Stream`, or run `setup.sh` (installs 7.0.2 ffprobe). Remotion's compositor package also bundles one. |
| No `drawtext` filter | `ffmpeg -version` lists libfreetype, but `drawtext` is not registered | Draw text on the canvas, or burn captions with the `ass` filter |
| numpy not installed, system pip refused | `externally-managed-environment` (PEP 668) | `python3 -m venv` under `/workspace/personal`; `setup.sh` does it |
| PNG frames encoded by libx264 without `-pix_fmt` | The output is `yuv444p` (High 4:4:4 Predictive), which many players and uploaders reject | Always `-pix_fmt yuv420p`. `render.mjs` does. |
| Full-range `yuvj420p` | Rendered by `remotion render` by default | `--color-space=bt709`, or `x-reencode.sh` |
| Remotion's bundled ffmpeg is stripped | no `fps`, `tile`, `hstack` filters | Use the image's `/usr/local/bin/ffmpeg` for analysis and sheets |
| agent-fs serves `.mp4` as `application/octet-stream` | A content-type check on a raw link fails | Use a `share-create` link. Do not retry the content-type check. |
| Signed URLs expire and default to attachment | A `<video src>` pointing at one downloads instead of playing, and stops working at the expiry | Never use one as a public URL. For a page, commit a compressed copy. `signed-url --inline` renders in a browser tab but still expires. |
| `agent-fs cat` truncates | Pagination hides the tail of a big file | `agent-fs download <path> -o <file>` for exact bytes |
| Container restart mid-render | The scratch dir is the only thing that survives | Keep it in `/workspace/personal/<slug>`, name it in the first progress note, upload an interim cut before the long render |
| Brief and source disagree | The brief says four PRs merged; main has five | The source wins, and the output says so |
| Invented logo | The first example cut drew its own mark | Use `apps/ui/public/logo.png`; `setup.sh` downloads it and warns if the live site differs |
| `--music` json without `wav` | The mp4 has no audio; `render.mjs` warns on stderr | Run `music-current.sh` after `music-cut.sh`, render with `music/current.json`, check for an `aac` stream |
| Music the requester already heard | Same track on every video | Pick a fresh track; offer two alternates when music is in question |

## Example: TLA+ Races Showreel

### The prompt (abridged)

> Make a dynamic 15 to 25 second motion graphics video about how a model checker (TLA+) found real race conditions in Agent Swarm, each one pinned as a failing test and then turned green by a fix PR. Make it your showreel: show what an incredible motion designer you are. Go all out.
>
> The only content rule: every number, PR and race on screen is read live right before the final render. Anything you cannot confirm stays off screen. Fewer facts is fine: design-led, not a ledger.

Plus the standard how-to: ad hoc scratch dir, a contact sheet at least three times, CC-licensed music with a credit, and the gate that stops a maker who is not on `claude-opus-5-5`.

### What is in the video

Title "TLA+", then a particle field counting the model checker's reachable states up to 1,349,396. A counterexample trace draws across a timeline (heartbeat bug 1, the invariant `NoLiveKill` violated). Ten tiles appear red under "Each race, pinned as a failing test". A scan sweep turns them green under "Then a fix PR turns it green." The counter, labelled "today" at 1,349,396, collapses to 4,243 under "a simpler design, proposed." A hexagon morphs into the real logo and the end card reads "Races found by a model checker", with the music credit.

### How the facts got on screen

`example/tla-races/facts.ts` produced `facts.v3.json`: the 7 workflow races (`CX1` to `CX7`) and 3 heartbeat bugs, their fix PRs (#1666, #1668, #1669, #1670, #1673, #1675, #1678), the invariants and traces, and `origin/main` at `e3c90a88`. The reel draws only a handful of those facts.

### v1 to v3

| Cut | Why it was made | What it showed |
|---|---|---|
| v1 | Fixed-template cuts of the same subject read as generic. The brief became "Opus, max effort, one open prompt, your own design". | 24 s, 16:9 and 4:5. Music: "Voltaic", Kevin MacLeod, CC BY 4.0. 7 workflow races red (their fix PRs were still open); 2 heartbeat bugs green. The end card used a hexagon mark the maker had drawn. |
| v2 | Feedback: use the correct logo at the end, and use different music. | Real logo asset on the end card; "Mist City", Section7, CC BY 4.0, with two alternate tracks (CC0 and CC BY 3.0) rendered for choice. A first attempt died in the final render when the worker session was lost; the retry found the scratch dir and finished in 8 minutes. Facts re-read: only the first race fix had merged. |
| v3 | Once the remaining fix PRs merged, the cut for the post. "Only the facts change." | Same design, music and logo. `facts.ts` re-run against `origin/main`: all 10 tiles green. The brief listed four merged PRs, main also had the heartbeat bug 2 fix, so the reel says "ALL 10 FIXED ON MAIN". Source over brief. |

### Final video

`tla-races-showreel-v3`: 24.00 s, h264 High, yuv420p, 1920x1080, 30 fps, AAC. The docs page embeds a 1280-wide, 2.6 MB copy and a poster. The master stays in agent-fs.

## Verification Log

| Step | Result |
|---|---|
| Sparse clone of the template, `cp`, `setup.sh`, `smoke.sh` | Run against the PR branch (`--branch`); the commands in this playbook target `main`, which has the template once this merges. 14.6 s for `setup.sh`, then `OK: yuv420p 960x540`. |
| `setup.sh` on a clean directory, stock image | Run. Installs ffprobe, numpy, fonts, logo. Re-run installs nothing. |
| `FORCE_LOCAL_FFMPEG=1 FORCE_LOCAL_PLAYWRIGHT=1 bash setup.sh` | Run. Pinned ffmpeg tarball passed its sha256; `npm install playwright@1.58.0`; `playwright install chromium` fetched 622 MB; smoke test passed on that toolchain. |
| `python3 -m venv` + `pip install numpy pillow` | Run. numpy 2.5.3, pillow 12.3.0. |
| System `pip install numpy` | Run. Refused (PEP 668). |
| Fonts from `google/fonts` | Run. Byte-identical to the files used in the example. |
| `fetch-music.sh` for Voltaic and Mist City | Run. Byte-identical to the files used. NC, ND, SA, "All rights reserved", a bare `CC BY` and unknown licenses refused; `cc-by 4.0`, `CC0` and `cc by 2.5` normalize and get the right license link. |
| `music-analyze.py`, `music-cut.sh` | Run on Voltaic (120.2 BPM; cut is 24.00 s). Run on Mist City (129.2 BPM, `atempo=0.929`). |
| `music-current.sh`, then a 720-frame render at 960x540 with `music/current.json` | Run on the Mist City cut. ffprobe: h264 `yuv420p` 960x540 and an `aac` stream, both 24.00 s. |
| `render.mjs` with a broken wav, with ffmpeg killed mid-render, with no ffmpeg on `PATH` | Run. Each exits 1 with the ffmpeg exit status in the message and leaves no partial mp4. |
| `x-reencode.sh` | Run on a `yuvj420p` clip and on `remotion render` output. Both came out `yuv420p(tv, bt709)`. |
| `web-compress.sh` | Run on the example master (17.8 MB to 2.6 MB). |
| Remotion `npm install` and a 30-frame render with `--browser-executable=/opt/playwright/chromium` | Run. Remotion 4.0.532, 14 s. |
| `smoke.sh` | Run. `OK: yuv420p 960x540`, `OK: aac audio`, `OK: failed encode exits non-zero`. |
| `apt-get install` of Chromium system libraries | **Not run.** The worker has no root. |
| `npx remotion studio` | **Not run.** |
| `skill-create`, `skill-install`, `update-profile`, `agent-fs share-create` | **Not run.** They change a live swarm or publish a link. |
