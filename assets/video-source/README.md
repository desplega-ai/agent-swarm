# README video source — "Daily Evolution"

Remotion project used to render `../agent-swarm.mp4` (the hero video at the top of the root [README](../../README.md)).

The current render is a **low-fi wireframe** of the "compounding memory" pitch — scanning transcripts, curating new memories, evolving an agent profile, and a 7-day memory-graph timelapse. Placeholders are intentional; swap them for real data when we ship v2.

## Render

```bash
cd assets/video-source
npm install
npx remotion render src/index.ts DailyEvolution ../agent-swarm.mp4
```

Live preview:

```bash
npx remotion studio
```

## System dependencies

On fresh Linux containers you also need:

```bash
sudo apt-get install -y ffmpeg libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0
```

## Layout

- `src/Root.tsx` — composition registration (30s @ 30fps, 1920x1080)
- `src/DailyEvolution.tsx` — stitches the scenes
- `src/scenes/` — six scenes, each a standalone React component
- `src/theme.ts` — colors + typography tokens

## Swapping in real data

The wireframe values (task count, agent names, memory titles, profile diff, graph node count) are stubs. For v2:

1. Pipe real data from `src/be/memory/` into a JSON file.
2. Pass via `--props='{"memories":[...], "profile":{...}, "graphDays":[...]}'`.
3. Scenes already read from props; wire the rest up.
