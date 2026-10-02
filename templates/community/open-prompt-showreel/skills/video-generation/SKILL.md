---
name: video-generation
description: How to generate repo-committed video content (README hero videos, case-study clips, landing demos) with Remotion. Covers project layout, fonts and colors that match the brand, audio sourcing, rendering in a worker container, the full-range yuvj420p gotcha, CI exclusions, and the "honest read" pacing principle. Use whenever you are asked to create a video from a Remotion project, animate a wireframe, or re-render an existing Remotion project. For a design-led one-off showreel use open-prompt-showreel instead.
metadata:
  type: procedure
---

# Video generation (Remotion)

Remotion (React + TypeScript) is the stack for videos that live in a repo: README heroes, landing demos, case-study clips, thread dramatizations. `assets/video-source/` in `desplega-ai/agent-swarm` is the reference implementation; read it before starting a new project.

## Golden rules

1. **Remotion for repo-committed video.** `npx remotion studio` for previews, `remotion render` for mp4s. For a one-off design-led cut with no repo, use `open-prompt-showreel` instead.
2. **Ask for audio, don't pick it.** Music is a brand call. A person on the team chooses the track (CC0 or CC BY 4.0, for example from https://freesound.org). Never grab something yourself; ask. There is no default bed.
3. **Attribute in the video folder's README.** Artist name, source URL, license. Not in the repo root README; in the video project's own README.
4. **Design tokens mirror the product.** Pull colors and fonts from the product's own `globals.css` (Agent Swarm: Space Grotesk + Space Mono, zinc dark palette, amber `#f2a93b` accent). Do not invent new ones.
5. **Honest read pacing.** The first draft always over-packs the opening and under-weights the payoff. Compress setup scenes, expand the one that carries the message. See "Pacing" below.
6. **One Remotion project, many compositions.** Do not spin up a new repo per video. Register additional `<Composition>` entries in `src/Root.tsx` and add a `build:<slug>` script.

## Project layout

```
<project>/
  package.json            # remotion + @remotion/cli + @remotion/google-fonts + react 18
  remotion.config.ts
  tsconfig.json           # isolated: exclude from the root tsconfig (see CI below)
  README.md               # render commands + audio attribution
  src/
    index.ts              # registerRoot(Root)
    Root.tsx              # <Composition> per video
    fonts.ts              # loadFont() for Space Grotesk + Space Mono at module scope
    theme.ts              # brand tokens (bg/fg/accent/sans/mono)
    compositions/         # one per video: stitches scenes + audio
    scenes/<video-slug>/  # per-scene components, one folder per composition
  public/
    audio/bed.mp3         # music bed, referenced via staticFile("audio/bed.mp3")
  out/                    # rendered mp4s (gitignored)
```

## Bootstrapping a new video project

Ran in a worker container (Remotion 4.0.532, 23 s install):

```bash
mkdir -p assets/video-source && cd assets/video-source
npm init -y
npm install remotion @remotion/cli @remotion/google-fonts react@^18.3.1 react-dom@^18.3.1
npm install -D @types/react typescript
npx remotion studio   # scaffolds config + opens preview
```

`npx remotion studio` opens an interactive preview and was not run for this playbook.

## Rendering in a worker container

The worker image already ships Chromium (`/opt/playwright/chromium`) and its system libraries, so no apt install is needed. Point Remotion at it instead of letting it download its own browser:

```bash
npx remotion render src/index.ts <CompositionId> out/<name>.mp4 \
  --browser-executable=/opt/playwright/chromium --color-space=bt709
```

A 30-frame 1280x720 test composition rendered in 14 s this way.

**Color-range gotcha.** Without `--color-space=bt709`, `remotion render` writes `yuvj420p(pc, bt470bg)`: full range, not the limited-range `yuv420p` that social uploaders expect. With the flag it writes `yuv420p(tv, bt709)`. Check with `ffmpeg -hide_banner -i out.mp4 2>&1 | grep Stream`. If a clip is already rendered, re-encode it with the template's `x-reencode.sh`.

For a bare Debian/Ubuntu container that is not a worker image, Chromium needs system libraries and root. **Unverified, not run for this playbook:**

```bash
sudo apt-get install -y ffmpeg libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0
```

## Fonts

Load once at module scope in `src/fonts.ts` and import from `src/Root.tsx`:

```ts
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadSpaceMono } from "@remotion/google-fonts/SpaceMono";

loadSpaceGrotesk("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
loadSpaceMono("normal", { weights: ["400", "700"], subsets: ["latin"] });
```

## Theme tokens (dark palette, amber accent)

```ts
export const theme = {
  bg: "#09090b",
  card: "#18181b",
  fg: "#fafafa",
  muted: "#a1a1aa",
  mutedDim: "#52525b",
  border: "rgba(255,255,255,0.10)",
  borderStrong: "rgba(255,255,255,0.18)",
  accent: "#f2a93b",      // amber: brand primary in dark mode
  accentDim: "#7a4d12",
  accentFg: "#1a1409",
  success: "#4ade80",
  danger: "#f87171",
  sans: "'Space Grotesk', system-ui, -apple-system, sans-serif",
  mono: "'Space Mono', ui-monospace, 'SF Mono', Menlo, monospace",
};
```

## Multiple compositions

Register each video as its own `<Composition>` in `src/Root.tsx`. `durationInFrames` is at 30 fps unless you raise the fps:

```tsx
<Composition id="DailyEvolution" component={DailyEvolution}
  durationInFrames={900} fps={30} width={1920} height={1080} />
<Composition id="SlackToPR" component={SlackToPR}
  durationInFrames={1350} fps={30} width={1920} height={1080} />
```

Add a `build:<slug>` script per composition in `package.json`:

```json
"build:daily-evolution": "remotion render src/index.ts DailyEvolution out/daily-evolution.mp4",
"build:slack-to-pr":     "remotion render src/index.ts SlackToPR     out/slack-to-pr.mp4",
"build:all":             "npm run build:daily-evolution && npm run build:slack-to-pr"
```

## Audio

```tsx
import { Audio, staticFile } from "remotion";

// Inside a composition, per composition, so some can ship silent:
<Audio src={staticFile("audio/bed.mp3")} volume={0.4} />
```

- Put attribution in `<video-project>/README.md` with artist, source URL and license, for example:
  > _Track title_ by **Artist** (https://freesound.org/s/<id>/), License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Not every composition needs music. A case-study clip that pairs with a written thread can ship silent on purpose.
- If someone says "I can't hear the audio", first check the actual bytes of the mp3 (`file public/audio/bed.mp3`, `ls -lh`); stub or broken files are the usual cause. Then verify `<Audio>` is mounted inside the composition that is being rendered, not a sibling. Verify the render has an audio stream with `ffmpeg -i out.mp4`.

## Pacing: the "honest read"

First drafts always front-load setup and shortchange the payoff. After the first render, do an honest read:

1. **Which single scene carries the message?** That one gets the most frames.
2. **Which scenes are setup or framing?** Compress them, usually 60-120 frames (2-4 s at 30 fps).
3. **Does the payoff have room to breathe?** 450+ frames (about 15 s) is typical for a scene the viewer needs to absorb.
4. **Do the beats spread across the available time, or cluster at the start?** If they cluster, spread the `delay` / `spring` staggers across the full scene duration.

Example distribution for a 30 s composition (900 frames at 30 fps): scenes 1-4 (setup) 60 / 90 / 120 / 120 frames, scene 5 (payoff) 450 frames, scene 6 (tagline) 60 frames.

## CI and repo integration

A Remotion project lives inside the repo but must be isolated from its build tooling:

1. **Exclude from the root `tsconfig.json`.** The project has its own deps (React, Remotion) that the parent repo does not resolve. Add `"assets/video-source"` (or wherever it lives) to the root tsconfig `exclude`.
2. **Scope the linter.** If Biome or ESLint is scoped to `src/`, no change is needed. If it scans the whole repo, add an ignore pattern.
3. **Keep its own `tsconfig.json`** inside the video folder. Run `npx tsc --noEmit` there for type coverage.
4. **`out/` and `node_modules/` must be gitignored.** Commit `public/audio/bed.mp3` and source, not render outputs.
5. **Do not install Remotion's heavy deps at the repo root.** They belong only in the video project's `package.json`.

## README video embed (GitHub renderer gotchas)

For README hero videos, use a raw-URL `<video>` tag:

```html
<video src="https://github.com/<org>/<repo>/raw/main/assets/<name>.mp4"
  autoplay muted loop playsinline></video>
```

- GitHub's markdown renderer is strict about `<video>` attributes. Keep it simple.
- Prefer `raw/main/...` over `blob/main/...`; the latter serves the HTML page, not the mp4 bytes.
- Target file size: under 3 MB if possible.
- If the embed does not render, fall back to a link preview: `[![demo](thumbnail.png)](video-url)`.

## When to use what

| Need | Approach |
|---|---|
| README hero (the "what is this?") | 30 s, 1080p, one composition, audio bed, low-fi wireframe tokens |
| Case study or thread dramatization | 45 s, multiple short scenes, typically silent |
| Landing demo (product in action) | Remotion scaffolding + real screen recordings composited in |
| Design-led one-off (showreel, eval comparison) | `open-prompt-showreel`, not this skill |
| Audio-first asset (podcast clip, TTS demo) | A text-to-speech service, not Remotion |

## Common mistakes

- Picking music without asking.
- Inventing colors or fonts instead of pulling them from the product.
- Cramming 6 scenes into the first 10 s. That is the drift the honest read fixes.
- Forgetting to exclude the video folder from the root tsconfig: CI fails on React/Remotion types the root repo does not have.
- Shipping a silent video where audio was expected, or the reverse.
- Dropping attribution. CC BY 4.0 requires credit.
- Posting a `remotion render` output to X without checking its pixel format.
