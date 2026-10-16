# QA loom

A QA loom is a short screen recording of a real UI QA pass, with a voice-over and small one-line subtitles, embedded in the PR. The narrated mp4 plays inline on GitHub with audio. An optional subtitled GIF gives a silent preview.

Two bundled files ship next to this skill:

- `run-qa.sh` records the QA pass with `agent-browser` and writes `steps.json`.
- `build-loom.mjs` turns `steps.json` and the raw recording into `qa-loom.mp4`.

Copy both into your working directory before you edit them.

## When to use

- On every PR that changes visible UI, and on every UI QA pass.
- Run your normal QA with the `qa` skill. Drive the browser with the `agent-browser` skill. This skill adds recording, narration and delivery on top.
- Skip it when a PR has no visible UI change.

## Requirements

Check these first. If one is missing, use the fallback in section 7.

| Requirement | Check |
|---|---|
| `ELEVENLABS_API_KEY` env var | `test -n "$ELEVENLABS_API_KEY"` (never echo the value) |
| `agent-browser` with recording | `command -v agent-browser`; on errors, `agent-browser doctor` |
| `ffmpeg` built with libass | `ffmpeg -hide_banner -filters 2>/dev/null \| grep -w ass` |
| Node 18+ or Bun | `node --version` (the script needs global `fetch` and top-level await) |
| `jq` and GNU `date` | `jq --version`; `date +%N` prints digits, not `N` |
| A subtitle font | `fc-list \| grep -i "DejaVu Sans"`, or set `FONT` to an installed font |
| `GITHUB_TOKEN` for delivery | a token that can upload user attachments to the repo (section 6) |

Portability gotchas:

- Some ffmpeg builds ship without `ffprobe`. Probe with `ffmpeg -hide_banner -i f.mp4 2>&1 | grep -E "Duration|Stream"`.
- Some ffmpeg builds have no `drawtext` filter. Burn subtitles with the libass `ass` filter, as `build-loom.mjs` does.
- libass ignores the alpha byte of `BackColour` for `BorderStyle=3`. The subtitle box is solid dark grey, not translucent.
- Minimal containers may lack `bc`. Do time arithmetic in `jq`, as `run-qa.sh` does.

## Style rules

- **Speed 1.33x** on the raw footage (`SPEED=1.33`). 2x is too fast to follow.
- **One short sentence per step**, present tense, describing what the viewer sees: "The editor opens a shared file." Aim for 6 to 12 words.
- **Subtitles: one line, small, bottom centre.** 38 px on a 1080p frame, dark box, `MarginV 30`. Cues hold at most 6 words, split on punctuation, with no orphan cue under 3 words.
- **Voice and subtitles start when the screen renders**, not when the click fires. That is why the step log carries `visualAt`.
- **Letterbox, never stretch.** Mobile-viewport steps are fitted into 1920x1080 with padding.
- **Keep it short.** 4 to 6 steps that prove the change, about 20 to 30 seconds final.

## Context hygiene

The pipeline handles large binary payloads. Keep them out of your context:

- Run every ffmpeg call with `-loglevel error`, or send its stderr to a file and `tail -3` it only on failure.
- Never print an ElevenLabs response. `audio_base64` is hundreds of KB. `build-loom.mjs` writes it straight to disk.
- Never `cat` or read an mp4 or GIF. To look at the result, extract one PNG frame and view that.

## 1. Record the QA pass with a step log

Each step logs:

- `start`: just before the action fires (`act`).
- `visualAt`: after the resulting screen has rendered, following an `agent-browser wait <selector>` (`step`).
- `verdict` and one `narration` sentence.
- `end`: the next step's `start`. The last step ends when recording stops.

All times are seconds from recording start. Replace the example steps in `run-qa.sh` with your QA steps, then run it:

```bash
BASE_URL=http://localhost:5274 OUT=./loom bash run-qa.sh
```

Notes:

- Log in and seed data **before** `record start`, so the loom shows only the change.
- For a mobile check, run `agent-browser set viewport 390 844` inside a step. The build letterboxes it.
- After each step, wait about 800 ms so the viewer sees the result before the next action.
- Take your normal QA screenshots as well. They are the fallback.

## 2. Build the narrated mp4

`build-loom.mjs` reads `steps.json` and the raw recording. For each step it:

1. Calls ElevenLabs `POST /v1/text-to-speech/{voice}/with-timestamps` once and caches the mp3 and character alignment under `work/`. A re-run after a style tweak costs no characters.
2. Cuts the step's segment, speeds it up, and letterboxes it to 1920x1080 at 30 fps.
3. Freezes the last frame when the narration outlasts the segment.
4. Builds subtitle cues from the same character alignment, offset by `visualAt`, so voice and subtitles cannot drift.

Then it concatenates the segments with the concat demuxer, delays each step's audio to where its screen renders, mixes with `amix normalize=0`, burns the ASS subtitles, and writes `qa-loom.mp4` and `qa-loom.ass`.

```bash
node build-loom.mjs loom/steps.json loom/raw.webm loom/out > loom/build.log 2>&1 || tail -5 loom/build.log
cat loom/build.log   # one JSON line: {"durationS":..,"steps":..,"cues":..,"chars":..}
```

Optional env: `SPEED` (default `1.33`), `VOICE` (default `21m00Tcm4TlvDq8ikWAM`, an ElevenLabs premade voice), `MODEL` (default `eleven_turbo_v2_5`), `FONT` (default `DejaVu Sans`).

## 3. Check the result

Look at one frame per cue, as PNG:

```bash
cd loom/out
ffmpeg -hide_banner -i qa-loom.mp4 2>&1 | grep -E "Duration|Stream"          # 1920x1080, 30 fps, h264 + aac
grep Dialogue qa-loom.ass                                                     # one short line per cue
ffmpeg -hide_banner -i qa-loom.mp4 -vn -af volumedetect -f null - 2>&1 | grep mean_volume   # about -91 dB means silent
ffmpeg -y -loglevel error -ss 2 -i qa-loom.mp4 -frames:v 1 check-2s.png       # view it: the subtitle matches the screen
```

If the loom feels slow or fast, change `SPEED` and re-run. TTS is cached, so the re-run is free.

## 4. Optional GIF preview

GitHub plays an mp4 inline only when it is a GitHub user attachment (section 6). The GIF is an optional silent preview with the subtitles already burned in.

```bash
ffmpeg -y -loglevel error -i qa-loom.mp4 \
  -vf "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 qa-loom.gif 2>gif.err || tail -3 gif.err
ffmpeg -hide_banner -i qa-loom.gif 2>&1 | grep -E "Duration|Stream"   # 960x540, 10 fps
head -c 6 qa-loom.gif; echo                                           # GIF89a
ffmpeg -y -loglevel error -ss 5 -i qa-loom.gif -frames:v 1 gif-check.png   # view it: subtitle readable
```

At these settings a GIF costs about 30 KB per second of loom. Keep it under 5 MB. If it is bigger, drop to `fps=8`, then to `scale=720:-1`. Below 720 px wide the subtitles become unreadable.

## 5. Keep the originals

Store `qa-loom.mp4` and `qa-loom.gif` wherever your team keeps QA evidence, next to the QA screenshots, under the same topic name. The GitHub attachment is the embed; your store is the durable original.

## 6. Attach to the PR

Upload both files to GitHub as user attachments. This uses GitHub's user-attachments upload endpoint, the one the web editor uses. It is not part of the documented REST API.

```bash
REPO=<owner>/<repo>
REPO_ID=$(gh api "repos/$REPO" --jq .id)
attach() {  # $1 local file, $2 content type; prints https://github.com/user-attachments/assets/<uuid>
  q=$(jq -rn --arg name "$(basename "$1")" --arg content_type "$2" --arg repository_id "$REPO_ID" \
    '$ARGS.named | to_entries | map("\(.key)=\(.value | @uri)") | join("&")')
  curl --fail-with-body -sS -X POST "https://uploads.github.com/user-attachments/assets?$q" \
    -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Content-Type: application/octet-stream' \
    --data-binary "@$1" | jq -er .url
}
MP4_URL=$(attach qa-loom.mp4 video/mp4)
GIF_URL=$(attach qa-loom.gif image/gif)
echo "$MP4_URL $GIF_URL"
```

Verification rules:

- Both URLs must match `https://github.com/user-attachments/assets/<uuid>`.
- A 401 means the token type is not accepted (GitHub App installation tokens are rejected; a personal access token works). A 404 means a wrong repository ID or a token without write access to the repo.
- Do not embed presigned storage URLs. A presigned mp4 usually downloads instead of playing, and it expires.

Put the loom in the PR body's `## Before / after` section. Write the section to a file:

```bash
cat > loom-section.md <<EOF
QA loom: <one-line summary>. <n> steps, <verdicts>.

$MP4_URL

![QA loom preview (silent, subtitled)]($GIF_URL)
EOF
```

`$MP4_URL` must sit on its own line, so GitHub renders a player with audio. The GIF line is optional. Merge the section into the body (`gh pr view <n> --json body`, then `gh pr edit <n> --body-file <file>`) and leave every other line unchanged.

Then open the PR and confirm that the mp4 player and the GIF render. A successful upload response does not prove that the embed renders.

## 7. Fallback: never block the PR

If ElevenLabs fails (401, 429, quota, or a 5xx after one retry with backoff), ffmpeg fails, or a requirement is missing:

1. Post the QA screenshots in the PR as GitHub user attachments.
2. Add one line to the PR that says why there is no loom, for example "QA loom skipped: ElevenLabs 429 quota exceeded."
3. Ship the PR. The loom is evidence, never a merge gate.

A 4xx validation error is deterministic. Do not loop on it. Fix the input or fall back.

## Deliverable checklist

- [ ] `steps.json` has `start`, `visualAt`, `end`, `verdict` and `narration` for every step
- [ ] `qa-loom.mp4` is 1920x1080 at 30 fps with h264 and aac, is not silent, and shows one short subtitle line at the bottom
- [ ] `qa-loom.gif`, if made, is 960 px wide at 10 fps, under 5 MB, and starts with `GIF89a`
- [ ] The originals are stored with the QA screenshots
- [ ] The PR body's `## Before / after` section has `$MP4_URL` on its own line, and every URL is `https://github.com/user-attachments/assets/<uuid>`
- [ ] You opened the PR and saw the player render
