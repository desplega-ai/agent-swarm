# mode40 Video Starter (Remotion)

A minimal, **mode40-branded** Remotion scaffold. Copy it, add a composition,
render an `.mp4`. Brand tokens — IBM Plex Sans/Mono, navy/cyan, and the motion
system (easing, stagger, rise, shadow, tint) — live in [`src/theme.ts`](./src/theme.ts)
and are copied verbatim from mode40 Canon (`canon-brand-color`,
`canon-typography-rules`). Start from this template, not from scratch.

This scaffold is **baked into the agent-swarm worker image** at
`/opt/mode40/remotion-starter` so video tasks don't hand-install tooling each
session. `ffmpeg` and Chromium (via Playwright, at `$PLAYWRIGHT_BROWSERS_PATH`)
are already in the image.

## Quick start (inside a worker)

```bash
# 1. Copy the read-only starter into your writable workspace.
cp -r /opt/mode40/remotion-starter ~/video && cd ~/video

# 2. Install project deps (Remotion itself is per-project, not baked).
npm install         # or: bun install

# 3. (Optional) reuse the image's Chromium instead of downloading one.
export REMOTION_BROWSER_EXECUTABLE="$(node -e "console.log(require('playwright').chromium.executablePath())")"

# 4. Render the example composition to an mp4.
npx remotion render src/index.ts BrandCard out/brand-card.mp4
```

Preview interactively with `npm start` (Remotion Studio) when you have a browser.

## Layout

```
src/
  index.ts                  registerRoot entry
  Root.tsx                  composition registry — add your <Composition/> here
  fonts.ts                  IBM Plex Sans/Mono loaded via @remotion/google-fonts
  theme.ts                  mode40 brand + motion tokens (the source of truth)
  compositions/
    BrandCard.tsx           minimal example wiring up every token — copy this
remotion.config.ts          jpeg frames, concurrency, optional browser override
```

## Making a new video

1. Duplicate `src/compositions/BrandCard.tsx` and edit the content/animation.
2. Register it in `src/Root.tsx` with a unique `id`, `durationInFrames`, `fps`,
   and dimensions (1920×1080 @ 30fps is the house default).
3. Render: `npx remotion render src/index.ts <id> out/<name>.mp4`.

## Brand guardrails (from Canon — do not drift)

- **Cyan `#00D4DE` is a signal, not a surface** — eyebrows, marks, numbers,
  single rules. Never a large fill or body text.
- **Navy `#001D25` is the only dark background** — never pure black.
- **Text on navy is white**, with cyan reserved for the eyebrow/label line.
- **Type**: IBM Plex Sans Light (300) titles with slightly tighter kerning,
  Regular (400) body; IBM Plex Mono SemiBold (600) ALL-CAPS cyan eyebrows.
- Need a shade that isn't in `theme.ts`? Tint navy or cyan toward white using
  the ramp in `tint` — never invent a new hue.

Versions are pinned in `package.json`. Bump deliberately with `npm run upgrade`.
