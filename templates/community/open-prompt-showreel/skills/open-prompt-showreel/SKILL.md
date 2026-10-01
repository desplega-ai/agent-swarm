---
name: open-prompt-showreel
description: Make a design-led motion-graphics video (showreel, eval comparison, feature or bug-hunt story) from one open prompt. Claude Opus at max effort designs, codes and renders the whole thing itself in a scratch dir, with no template and no repo PR. Use for any "make a video for X" / "do a showreel for Y" / "a little comparison video" ask aimed at X, LinkedIn or a launch post. Covers the Lead brief template, grounding every on-screen number in a real source, the real Agent Swarm end logo, CC0/CC BY music with credit, render specs (16:9 + 4:5), the contact-sheet self-critique loop, agent-fs delivery, feedback rounds and crash-safe retries. Not for fixed-template creatives or for replicating a reference clip.
metadata:
  type: procedure
---

# Open-prompt showreel videos

The approach: give a strong model on max effort one open creative prompt plus hard content rules, and let it design, code and render the whole video itself. Template pipelines produce generic cuts. This one produced the showreels and the TLA+ races cuts that the team liked.

## When to use which skill

| Ask | Skill |
|---|---|
| A video that should look designed: showreel, model/eval comparison, "we found N bugs", launch hype | **this skill** |
| A standard on-brand card or clip from a fixed template (release, proof stat, quote, OG image) | a template toolkit, if your swarm has one |
| Rebuild the feel of a reference clip someone linked | `motion-design-video-analysis`, then `motion-design-replication` |
| Repo-committed Remotion video (README hero, landing demo, case-study clip) | `video-generation` |

If the ask says "like the showreel", "your own design" or "go all out", or someone complained a cut looks generic, it is this skill.

## Model, effort, harness

- The maker runs **model `claude-opus-5-5`, effort `max`**, on a **Claude Code harness worker** (`provider: claude`). Set both on the task.
- Other harnesses were not tried for this workflow. Do not route to them without a test run.
- Every brief ends with a gate: "If you are not on claude-opus-5-5, stop and say so instead of rendering." The maker checks this first.
- The worker needs Playwright + Chromium, ffmpeg, python3 with numpy, and write access to agent-fs. The community template's `setup.sh` checks and installs all of them (numpy goes in a venv; the stock image does not ship it).

## Lead brief template

One task, one open prompt. Do not write a storyboard, shot list, palette or template for the maker; that is what made earlier cuts generic.

```
GOAL: <one line: what the video is and where it goes (X / LinkedIn / internal)>.
Made by you on claude-opus-5-5, max effort, ad hoc, your own design.

<Requester>, verbatim: "<the ask>"

Your prompt: make a dynamic <15 | 15-30> second motion graphics video <about SUBJECT>.
Make it your showreel: show what an incredible motion designer you are. Go all out.

Content rule: every number or claim on screen comes from <SOURCE: eval writeup path /
test file on origin/main / PR numbers> and matches it exactly. Anything not in the
source stays off screen. Fewer numbers is fine: design-led, not a table.

How:
- Ad hoc: scratch dir, any tools or code you like. No repo, no PR, no shared template.
- Real brand: Agent Swarm logo = origin/main apps/ui/public/logo.png (verify vs agent-swarm.dev/logo.png). Never draw your own mark.
- Look at a contact sheet at least 3 times, fixing what looks weak each round; in the last round check every on-screen number against the source and look at the end-card frame.
- Music optional; CC0 or CC BY only (no NC, no ND, no SA); short credit on the end card; in your output the full attribution from music/current.json (source link, license link, changes made).
- If you are not on claude-opus-5-5, stop and say so.
- Nothing is owed to a human by you; Lead reviews and relays.

Deliver to agent-fs thoughts/<maker-agent-id>/videos/<slug>/: <1920x1080 [+ 1080x1350]> h264 yuv420p mp4,
contact sheet(s), facts.json.
Output: agent-fs paths, a share-create link per mp4 (url + share id), ffprobe line, model you ran on, each on-screen number with its source, music attribution (source link, license link, changes made).
```

Optional style add-on for a calmer, premium cut (the "Apple framework"): 3 colors, one background, one font, no HUD/grain; one shot = one idea; ~3 s open and ~2 s held end; key object centered; eased, overlapping keyframes; no hard cuts; ~108 BPM, phrase hit on the first product frame; no SFX. Add it only when asked.

## Maker procedure

### 1. Scratch dir first, and say where it is

`mkdir /workspace/personal/<slug>` and store-progress with the path in the first minute. `/workspace/personal` survives a container restart; the session does not. A retry that found the scratch dir of its crashed predecessor delivered in 8 minutes.

### 2. Facts before design

Write a small script (`facts.ts`, run with `bun facts.ts > facts.json`) that reads every on-screen fact live from its source right before render, and have the reel read `facts.json` instead of hard-coding numbers.

- Code facts: `git fetch origin main`, read the file at `origin/main` (for example count `test.failing` vs `test` in `src/tests/workflow-tla-races.test.ts`), `gh pr view` / `gh pr list` for PR states. Record the short SHA in facts.json.
- Eval facts: the writeup the eval task produced on agent-fs, and the run id. Copy numbers exactly.
- A fact turns "green" only if main says so. Unmerged stays in its old state, even if the brief expects otherwise.
- If the source disagrees with the brief, the source wins; say so in the output (the TLA+ v3 brief listed four merged PRs; main also had a fifth, so the reel said "ALL 10 FIXED ON MAIN").
- Drop any claim the source does not support.
- If the source is not ready yet (eval still running, PRs still merging), build the design on draft facts, then `defer-task` with `wakeOn:{event:"settled",taskIds:[...]}` and re-read the facts on wake. Never ship draft numbers.

### 3. Build: one HTML canvas reel, frame-addressable

A single `reel.html` that draws each frame on a `<canvas>` as a pure function of the frame number, with scenes as `sceneN(f)` functions. It exposes:

```js
window.boot = async (facts, fonts, logo) => { /* load fonts + logo, stash facts */ };
window.frame = (f) => { render(f); return cv.toDataURL("image/png"); };
```

`render.mjs` (Playwright, `chromium.launch({args:["--disable-gpu-vsync"]})`) opens the file at the target viewport, calls `boot` with facts, base64 fonts and the base64 logo, then either grabs a comma list of frames to PNGs (stills mode, for sheets) or grabs every frame and pipes PNGs to ffmpeg over `image2pipe` (video mode). The community template ships a working `tools/render.mjs`.

- Always pass `-pix_fmt yuv420p` to the ffmpeg that encodes the piped PNGs. Without it libx264 keeps the PNG's 4:4:4 and writes `yuv444p` (High 4:4:4 Predictive), which phones and social uploaders handle badly.
- ffmpeg in the worker image has no `drawtext` filter. Draw text on the canvas (this approach does anyway), or burn captions with the `ass` filter.
- Fonts are local TTFs inlined as base64 (Space Grotesk, JetBrains Mono, Instrument Serif Italic in the TLA+ reels; all SIL OFL).
- For long 60 fps cuts, render frames in several parallel Playwright workers and encode once.

### 4. Brand: the real end logo

- Agent Swarm logo = `apps/ui/public/logo.png` on origin/main: a solid gold hexagon inside a lighter gold honeycomb. It is byte-identical to `docs-site/public/logo.png` and `https://agent-swarm.dev/logo.png`. Check the sha256 against the live site; if they differ, the live site wins and you say so.
- Not an old cartoon asset. Not a mark you draw yourself: the first TLA+ cut drew a ring + hex + rays and the requester asked for the correct logo.
- Your own hex motif may morph into the real logo; the last frames must show the real asset, sharp.
- Colors from agent-swarm.dev (ink background, amber/gold accents). Do not invent brand elements.

### 5. Music: CC0 / CC BY, timed to the cut

- License: CC0 or CC BY only. No NC (company post), no ND (we cut and stretch it), no SA (it would carry over to the video). `fetch-music.sh` enforces an allowlist (CC0 1.0, CC BY 1.0-4.0); read the license on the source page yourself. Sources that worked: incompetech.com (Kevin MacLeod, CC BY 4.0), OpenGameArt (filter by license).
- Pick a fresh track per video; the requester asked for different music on the first TLA+ cut. Offer two alternates when music is in question.
- `fetch-music.sh` writes `music/<track>.json` (`{title, artist, license, license_url, source, credit}`). After `music-cut.sh`, run `music-current.sh music/<track>.json music/cut.wav`: it writes `music/current.json` with `wav` (without it `render.mjs` renders silent) and `attribution`. Render with `--music music/current.json` and check the mp4 has an `aac` stream. `credit` is the short end-card line; CC BY also needs the source link, the license link and the changes made in the post, which is what `attribution` carries.
- Time the cut to the music: find tempo, beat phase and the drop (numpy spectral-flux + low-end energy: `music-analyze.py`, `music-refine.py`), then time-stretch so the beats sit on the reel's frame grid (120 BPM = 15 frames per beat at 30 fps) and the drop lands on the key reveal (`music-cut.sh`: `atempo` + trim, fade in 0.3 s, fade out ~1.7 s).
- When the music is the feedback, also render the 16:9 with two runner-up tracks (audio swap only).

### 6. Render specs

- Container: h264 High, `yuv420p`, AAC 192k, `-movflags +faststart`, `libx264 -preset slow -crf 16`.
- 16:9: 1920x1080, stream at exactly that size. Add 4:5 1080x1350 for LinkedIn/X feeds. Build the layout responsive to `?w=&h=` rather than cropping.
- 30 fps by default; 60 fps for heavy motion.
- Length: 15 s for a brand showreel; 20-30 s when the story carries data.
- The worker image has no `ffprobe`. Read stream lines from `ffmpeg -i` stderr, or install ffprobe with the template's `setup.sh`.
- A clip from a screen recording, a JPEG pipeline or `remotion render` can be tagged `yuvj420p` (full range). Re-encode it with `x-reencode.sh` before posting to X.

### 7. Self-critique loop (minimum 3 rounds)

- Contact sheet: render 16 stills across the timeline and tile them 4x4 with ffmpeg `xstack` (`sheet.sh`); look at it with Read. Keep sheets per round (`r1-16x9.png`, `r2-...`).
- Transition strip: 20 stills densely around each cut (5x4 grid) to catch pops and empty frames.
- Each round, write down what looks weak (dead space, text too small for a phone, cramped 4:5, jumpy easing, off-beat hit) and fix it.
- Final round: check every on-screen number against facts.json and the source, and open the end-card frame on its own at full size to confirm the logo and credit.

### 8. Deliver

- agent-fs: `thoughts/<maker-agent-id>/videos/<slug>/` (versions as `<slug>-v2`, `<slug>-v3`, never overwrite an earlier version).
- Upload the mp4s, contact sheet(s), `facts.json`, the music json, and `reel.html` so the next round can start from it. After every non-trivial write, `agent-fs stat <path> --json` and check the size.
- Share link for each final mp4: `agent-fs --org <ORG_ID> --drive <DRIVE_ID> share-create <path> --expires-in 604800 --json`. The share page plays the video inline with no login. Max 7 days; report the url, the share id and the expiry. Do not hand out raw signed URLs or viewer URLs for video.
- agent-fs serves a raw `.mp4` download as `application/octet-stream`; the share page's player gets `video/mp4`. Mention it rather than retrying.
- Output (short): paths, share links, ffprobe line, model, each on-screen fact with its source and SHA/run id, music attribution (source link, license link, changes made), logo source. No Slack post by the maker; Lead relays.

## Feedback rounds (v2, v3)

- Lead writes a new task per round that quotes the requester verbatim and maps each point to a concrete change.
- The maker copies the previous scratch dir to `<slug>-vN`, changes only what the feedback names, and keeps design, music and logo otherwise identical.
- Always re-run `facts.ts` against current origin/main or the latest writeup; never carry numbers over.
- If a point depends on other work (PRs merging), do the rest now, deliver an interim, then `defer-task` on the blocking task with a ceiling.

## Failures to avoid

- **Dying mid final render.** Two runs were failed by a reboot sweep during the last render. Keep everything under `/workspace/personal/<slug>`, name it in progress early, upload an interim cut before the long render, and on a retry look for the prior working dir before starting over.
- **Pipeline cuts read as generic.** Fixed-template cuts of the same subjects were rejected as "too meh". Ad hoc scratch dir, no PR.
- **Invented logo** on the end card. Use the real asset.
- **Stock music the requester already heard.** Pick a fresh track each time.
- **Numbers ahead of the source.** Draft or expected states on screen before main or the eval says so.
