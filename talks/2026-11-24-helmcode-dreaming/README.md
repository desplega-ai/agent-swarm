# Café Helmcode deck (2026-11-24)

"On building agents that actually learn": memory (loop 1) and dreaming (loop 2), 15 minutes.
It reuses the zero-dependency slide engine of `talks/2026-09-21-ai-builders-memory`.

## Run it

```bash
bun talks/2026-11-24-helmcode-dreaming/serve.ts   # http://localhost:4747/
```

- `→` / `←` move. `n` shows the speaker notes. `?debug=1` (or key `c`) opens review mode and saves `comments.json`.
- `t` starts the rehearsal timer and saves `timings.json`.
- Slides 19 to 23 are an appendix for questions.

## Where the numbers come from

| Slide | Source |
| --- | --- |
| 1 | Public telemetry and GitHub stars, read 2026-11-24 |
| 3 to 7, 19 | The AI Builders deck (September 2026 numbers) |
| 10, 12, 15 | The dreaming blog post: `agent-swarm.dev/blog/our-agents-dream-every-night` |
| 13 | The dreaming run report of 2026-11-24 |
| 14 | Blog post series (2026-09-01 to 2026-10-27) plus one live point for 2026-11-24 (`DREAM_TODAY` in `deck.js`) |
| 16 | The cost and speed analysis of 2026-10-29 |

## Deploy

https://hcc.agent-swarm.dev (short link: `swar.am/helmcafe`), Vercel project `agent-swarm-hcc` in team
`desplega-labs`, root directory = this folder. `vercel.json` makes it a static site with no build.
The AI Builders deck stays on https://aib.agent-swarm.dev/ and is not changed by this folder.
