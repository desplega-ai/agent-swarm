/**
 * Renders the dashboard Open Graph card to a static PNG.
 *
 *   bun run og:render                  -> public/og-image.png (TEXT_OPTIONS[CHOSEN])
 *   bun run og:render --all <out-dir>  -> one PNG per text option, for review
 *
 * The dashboard is a static SPA, so the card is generated once and
 * committed rather than rendered per request.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { HiveFieldCard, MONO, OG_SIZE, type OgText, SANS } from "./card";

/** Candidate copy, pending a pick. The PR keeps only the chosen one. */
export const TEXT_OPTIONS: Record<"a" | "b" | "c", OgText> = {
  a: {
    eyebrow: "/ dashboard",
    lead: "Watch your swarm",
    accent: "do the work.",
    subtitle:
      "Tasks, sessions, agents, workflows and memory for the swarm you run. Point it at your own API.",
    footnote: "Open source. Self-hosted. Your model keys.",
  },
  b: {
    eyebrow: "/ open source",
    lead: "An engine to make your company",
    accent: "AI native.",
    subtitle:
      "A lead agent delegates goals to workers like Claude Code or Codex, in isolated containers with shared memory, tools and schedules.",
    footnote: "MIT licensed. github.com/desplega-ai/agent-swarm",
  },
  c: {
    eyebrow: "/ agent swarm dashboard",
    lead: "Direct the work.",
    accent: "See what agents did.",
    subtitle:
      "Create and steer tasks, approve what ships, and read every session log and cost, across Claude Code, Codex, pi and more.",
    footnote: "Open source. Self-hosted. Your model keys.",
  },
};

export const CHOSEN: keyof typeof TEXT_OPTIONS = "a";

const here = import.meta.dir;
const font = (file: string) => readFile(join(here, "fonts", file));

async function render(text: OgText) {
  const [g400, g500, g700, m400, logo] = await Promise.all([
    font("space-grotesk-400.ttf"),
    font("space-grotesk-500.ttf"),
    font("space-grotesk-700.ttf"),
    font("space-mono-400.ttf"),
    readFile(join(here, "../public/logo.png")),
  ]);
  const svg = await satori(
    <HiveFieldCard text={text} logo={`data:image/png;base64,${logo.toString("base64")}`} />,
    {
      ...OG_SIZE,
      fonts: [
        { name: SANS, data: g400, weight: 400, style: "normal" },
        { name: SANS, data: g500, weight: 500, style: "normal" },
        { name: SANS, data: g700, weight: 700, style: "normal" },
        { name: MONO, data: m400, weight: 400, style: "normal" },
      ],
    },
  );
  return new Resvg(svg, { fitTo: { mode: "width", value: OG_SIZE.width } }).render().asPng();
}

const [flag, outDir] = process.argv.slice(2);
if (flag === "--all") {
  const dir = outDir ?? join(here, "out");
  await mkdir(dir, { recursive: true });
  for (const [key, text] of Object.entries(TEXT_OPTIONS)) {
    await writeFile(join(dir, `og-${key}.png`), await render(text));
    console.log(join(dir, `og-${key}.png`));
  }
} else {
  const out = join(here, "../public/og-image.png");
  await writeFile(out, await render(TEXT_OPTIONS[CHOSEN]));
  console.log(out);
}
