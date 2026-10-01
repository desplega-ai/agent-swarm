# Open-Prompt Motion-Graphics Videos, Made by Your Swarm

Community template for making design-led motion-graphics videos with an agent swarm: one Claude Code worker on `claude-opus-5-5` at `max` effort designs, codes, renders and critiques the video from one open prompt. The worked example is a 24-second TLA+ races showreel.

Files:

- `PLAYBOOK.md`: end-to-end setup, the per-video procedure, gotchas, the TLA+ example and the verification log.
- `lead-prompt.md`: the one-time setup prompt, the per-video brief, and the feedback-round brief.
- `setup.sh`: idempotent toolchain setup for a worker container (ffmpeg/ffprobe, Playwright + Chromium, numpy venv, fonts, logo).
- `tools/`: `render.mjs` (canvas reel to stills or mp4), `sheet.sh` (contact sheet and transition strip), `music-analyze.py`, `music-refine.py`, `music-cut.sh`, `music-current.sh`, `fetch-music.sh`, `x-reencode.sh`, `web-compress.sh`.
- `skills/`: sanitized copies of `open-prompt-showreel`, `video-generation`, `motion-design-video-analysis`, `motion-design-replication`. Install them with `skill-create` and `skill-install`.
- `example/tla-races/`: `reel.html` (the finished reel), `facts.ts` and `facts.v3.json` (the live facts), `smoke.sh` (toolchain test).

Quick start, on the maker worker:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/desplega-ai/agent-swarm.git /tmp/agent-swarm-tpl
git -C /tmp/agent-swarm-tpl sparse-checkout set templates/community/open-prompt-showreel
mkdir -p /workspace/personal/showreel-toolkit
cp -r /tmp/agent-swarm-tpl/templates/community/open-prompt-showreel/. /workspace/personal/showreel-toolkit/
bash /workspace/personal/showreel-toolkit/setup.sh

. /workspace/personal/showreel-toolkit/env.sh
cd /workspace/personal/showreel-toolkit/example/tla-races && bash smoke.sh   # expect: OK: yuv420p 960x540
```

Then send the maker a task built from the brief in `lead-prompt.md`, with `model: claude-opus-5-5` and `effort: max`.

The docs page is [Open-Prompt Showreel Videos](https://docs.agent-swarm.dev/docs/playbooks/open-prompt-showreel).

Not shipped: `swarm-studio` and `studio-api`. The original skill points at them for fixed-template creatives; they depend on a private repository and a hosted renderer.

Music: use CC0 or CC BY tracks only. Put a short credit on the end card and the full attribution in the output: source link, license link and the changes made (`tools/music-current.sh` writes it to `music/current.json`, next to the `wav` the render needs). The TLA+ example credits ["Mist City"](https://opengameart.org/content/mist-city) by Section7 ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), trimmed and time-stretched.
