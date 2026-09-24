/**
 * Renders the dashboard Open Graph card to a static PNG.
 *
 *   bun run og:render  -> public/og-image.png
 *
 * The dashboard is a static SPA, so the card is generated once and
 * committed rather than rendered per request.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { HiveFieldCard, MONO, OG_SIZE, type OgText, SANS } from "./card";

const TEXT: OgText = {
  eyebrow: "/ dashboard",
  lead: "Watch your swarm",
  accent: "do the work.",
  subtitle:
    "Tasks, sessions, agents, workflows and memory for the swarm you run. Point it at your own API.",
  footnote: "Open source. Self-hosted. Your model keys.",
};

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

const out = join(here, "../public/og-image.png");
await writeFile(out, await render(TEXT));
console.log(out);
