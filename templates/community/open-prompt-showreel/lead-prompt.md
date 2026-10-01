# Lead Kickoff Prompts

Two prompts. The first sets the swarm up once. The second is the per-video brief the Lead sends to the maker.

## 1. One-time setup prompt

Copy this into your agent-swarm Lead.

```text
Set my swarm up to make open-prompt motion-graphics videos.

Parameters:
- Maker worker: <MAKER_AGENT_NAME>. It must be a Claude Code harness worker (provider claude) on the full worker image.
- agent-fs org and drive for deliveries: <ORG_ID> / <DRIVE_ID>
- Template source: templates/community/open-prompt-showreel in desplega-ai/agent-swarm (branch main).

Steps:
1. On the maker worker, copy the template to /workspace/personal/showreel-toolkit:
     git clone --depth 1 --filter=blob:none --sparse https://github.com/desplega-ai/agent-swarm.git /tmp/agent-swarm-tpl
     git -C /tmp/agent-swarm-tpl sparse-checkout set templates/community/open-prompt-showreel
     mkdir -p /workspace/personal/showreel-toolkit
     cp -r /tmp/agent-swarm-tpl/templates/community/open-prompt-showreel/. /workspace/personal/showreel-toolkit/
     bash /workspace/personal/showreel-toolkit/setup.sh
2. Set the maker's setupScript (update-profile, setupScript) so the toolchain is rechecked at every container start. Keep whatever is already in the script and append:
     # Showreel toolchain: idempotent, no-ops when already installed.
     [ -f /workspace/personal/showreel-toolkit/setup.sh ] && bash /workspace/personal/showreel-toolkit/setup.sh >> /workspace/personal/showreel-toolkit/setup.log 2>&1 || true
3. Create the four skills from /workspace/personal/showreel-toolkit/skills/*/SKILL.md with skill-create (scope swarm), then skill-install open-prompt-showreel on yourself and all four on the maker:
     open-prompt-showreel, video-generation, motion-design-video-analysis, motion-design-replication
4. Run the smoke test on the maker and report its output:
     . /workspace/personal/showreel-toolkit/env.sh && cd /workspace/personal/showreel-toolkit/example/tla-races && bash smoke.sh
   It must print "OK: yuv420p 960x540". If it does not, stop and report the failing line.
5. Do not render a real video yet.

Deliver back:
- The maker's name and the output of setup.sh and smoke.sh.
- The four skill names as they appear in the skills list.
- Anything you could not do automatically (for example a Chromium system library that needs root).
```

## 2. Per-video brief (Lead to maker)

One task, one open prompt. Do not write a storyboard, shot list, palette or template for the maker. Fill the angle brackets and send it with `model: claude-opus-5-5` and `effort: max`, assigned to the maker.

```text
GOAL: <one line: what the video is and where it goes (X / LinkedIn / internal)>.
Made by you on claude-opus-5-5, max effort, ad hoc, your own design. Use the open-prompt-showreel skill.

<Requester>, verbatim: "<the ask>"

Your prompt: make a dynamic <15 | 15-30> second motion graphics video <about SUBJECT>.
Make it your showreel: show what an incredible motion designer you are. Go all out.

Content rule: every number or claim on screen comes from <SOURCE: eval writeup path /
test file on origin/main / PR numbers> and matches it exactly. Anything not in the
source stays off screen. Fewer numbers is fine: design-led, not a table.

How:
- Ad hoc: scratch dir under /workspace/personal, any tools or code you like. No repo, no PR, no shared template.
- Tools are in /workspace/personal/showreel-toolkit (source env.sh). Real fonts and the real logo are in assets/.
- Real brand: Agent Swarm logo = origin/main apps/ui/public/logo.png (verify vs agent-swarm.dev/logo.png). Never draw your own mark.
- Look at a contact sheet at least 3 times, fixing what looks weak each round; in the last round check every on-screen number against the source and look at the end-card frame.
- Music optional; CC0 or CC BY only (no NC, no ND, no SA); short credit on the end card; in your output the full attribution from music/current.json (source link, license link, changes made).
- If you are not on claude-opus-5-5, stop and say so instead of rendering.
- Nothing is owed to a human by you; Lead reviews and relays.

Deliver to agent-fs thoughts/<maker-agent-id>/videos/<slug>/: <1920x1080 [+ 1080x1350]> h264 yuv420p mp4,
contact sheet(s), facts.json, reel.html.
Output: agent-fs paths, a share-create link per mp4 (url + share id), ffprobe line, model you ran on,
each on-screen number with its source, music attribution (source link, license link, changes made).
```

Optional style add-on for a calmer, premium cut: 3 colors, one background, one font, no HUD or grain; one shot = one idea; about 3 s open and 2 s held end; key object centered; eased, overlapping keyframes; no hard cuts; about 108 BPM with the phrase hit on the first product frame; no SFX.

## 3. Feedback round brief (v2, v3)

```text
GOAL: v<N> of <slug>. Base it on your v<N-1> in agent-fs <path>: same design, same music, same logo unless listed below.

<Requester>, verbatim: "<the feedback>"

Changes, one per point of feedback:
- <point> -> <concrete change>

Re-read every on-screen number from the source yourself and update facts.json. If the source disagrees with
this brief, trust the source and say so. Copy your scratch dir to <slug>-v<N> first; do not overwrite v<N-1>.
Deliver to thoughts/<maker-agent-id>/videos/<slug>-v<N>/ and report what changed vs v<N-1> in one line.
```

If a point depends on other work (PRs still merging, an eval still running), tell the maker to deliver the rest as an interim and `defer-task` on the blocking task. Never ship draft numbers.
