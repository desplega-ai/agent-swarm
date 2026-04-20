# Video source

Remotion project used to render the videos under `assets/`:

- `DailyEvolution` → `../agent-swarm.mp4` (README hero) — the "compounding memory" pitch
- `SlackToPR` → `../agent-swarm-slack-to-pr.mp4` — dramatizes how a Slack thread became [PR #350](https://github.com/desplega-ai/agent-swarm/pull/350)

Both are low-fi wireframes with stubbed data. Design tokens mirror `new-ui/` and `landing/` (Space Grotesk + Space Mono, shadcn Zinc dark palette, amber primary).

## Render

```bash
cd assets/video-source
npm install
npm run build:all                # both compositions
npm run build:daily-evolution    # just the hero
npm run build:slack-to-pr        # just the case study
```

Live preview:

```bash
npm start        # remotion studio — picks composition from the sidebar
```

## System dependencies

Fresh Linux containers need these for the headless Chromium renderer:

```bash
sudo apt-get install -y ffmpeg libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0
```

## Layout

```
src/
  Root.tsx                  # registers all compositions
  index.ts                  # registerRoot(Root)
  fonts.ts                  # loads Google Fonts (Space Grotesk, Space Mono)
  theme.ts                  # brand tokens (mirrors new-ui/landing)
  compositions/
    DailyEvolution.tsx      # composition root — stitches scenes + audio
    SlackToPR.tsx
  scenes/
    daily-evolution/        # 6 scenes for DailyEvolution
    slack-to-pr/            # 7 scenes for SlackToPR
public/
  audio/bed.mp3             # music bed (see Audio credits below)
```

## Adding a new video

1. Drop scenes under `src/scenes/<your-slug>/`.
2. Create `src/compositions/YourVideo.tsx` stitching them together (see existing examples).
3. Register it in `src/Root.tsx` with a unique `id`, `durationInFrames`, and dimensions.
4. Add a `build:your-video` script in `package.json`.

## Audio

`public/audio/bed.mp3` is only used by `DailyEvolution` (the `SlackToPR` composition runs without audio). Referenced via `<Audio src={staticFile("audio/bed.mp3")} />`.

### Credits

> _Cool Chill Beat Loop_ by **monkeyman535** — https://freesound.org/s/351717/ — License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## CI

`assets/video-source/` is excluded from the root `tsconfig.json` — the project has its own deps (React, Remotion) that the main swarm doesn't resolve. It also has its own `tsconfig.json`; run `npx tsc --noEmit` inside this folder if you want type coverage here.

## Swapping in real data

Scene data (task counts, memory titles, profile diffs, Slack messages) is stubbed inline. For v2:

1. Pipe real data from `src/be/memory/` into a JSON file.
2. Pass via `--props='{...}'` on the `remotion render` command.
3. Read from `useProps()` inside scenes.
