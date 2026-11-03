/**
 * The page share card: the agent-swarm.dev `/api/og` look (agent-swarm-landing
 * src/lib/og/yolo-card.tsx, dark tone) at 1200x630. Text column on the left,
 * the lead mascot on the right, the honeycomb behind both, the title tail in
 * amber.
 *
 * Built as plain Satori element objects instead of JSX, so the Vercel function
 * compiles without a JSX setup. Satori reads only inline styles and sRGB hex.
 */
import { OG_SIZE, type OgCardInput } from "./page-share";

export const SANS = "Space Grotesk";
export const MONO = "Space Mono";

const W = OG_SIZE.width;
const H = OG_SIZE.height;
const R = 46;

const TONE = {
  bg: "#09090B", // zinc-950
  cell: "245, 158, 11",
  fill: [0.03, 0.1],
  stroke: 0.1,
  ink: "#FFFFFF",
  accent: "#FFD230", // amber-300
  body: "#D4D4D8", // zinc-300
  meta: "#9F9FA9", // zinc-400
  chipBg: "#FFFFFF",
  chipInk: "#09090B",
} as const;

/** A Satori element: the `{ type, props }` shape React elements have. */
export interface OgNode {
  type: string;
  key?: string | number | null;
  props: Record<string, unknown> & { children?: OgChild | OgChild[] };
}
type OgChild = OgNode | string | null;

function h(type: string, props: Record<string, unknown> | null, ...children: OgChild[]): OgNode {
  const kids = children.filter((c) => c !== null);
  const key = (props?.key as string | number | undefined) ?? null;
  return {
    type,
    key,
    props: { ...props, children: kids.length === 1 ? kids[0] : kids },
  };
}

/** Pick the largest step whose length budget fits the text. */
export function fitSize(text: string, steps: { max: number; size: number }[]): number {
  for (const step of steps) if (text.length <= step.max) return step.size;
  return steps[steps.length - 1]?.size ?? 48;
}

/** Cut at a word boundary. Satori ignores `lineClamp` in a flex box. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.\s]+$/, "")}…`;
}

function hash(col: number, row: number): number {
  let x = Math.imul(col, 0x9e3779b1) ^ Math.imul(row, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 0x100000000;
}

/** Flat-top hexagon, the same lattice as the site background. */
function hex(cx: number, cy: number, r: number): string {
  const y = 0.866 * r;
  return `${cx + r},${cy} ${cx + r / 2},${cy - y} ${cx - r / 2},${cy - y} ${cx - r},${cy} ${cx - r / 2},${cy + y} ${cx + r / 2},${cy + y}`;
}

/** 0.35 under the text column, rising smoothly to 1 around the mascot. */
function dim(x: number): number {
  const t = Math.min(1, Math.max(0, (x - 640) / 260));
  return 0.35 + 0.65 * t * t * (3 - 2 * t);
}

function cells(): OgNode {
  const colStep = R * 1.5;
  const rowStep = Math.sqrt(3) * R;
  const polygons: OgNode[] = [];
  const [low, high] = TONE.fill;
  for (let col = -1; col * colStep < W + R; col++) {
    for (let row = -1; row * rowStep < H + R; row++) {
      const cx = col * colStep;
      const cy = row * rowStep + (col % 2 ? rowStep / 2 : 0);
      const k = dim(cx);
      polygons.push(
        h("polygon", {
          key: `${col}:${row}`,
          points: hex(cx, cy, R),
          fill: `rgb(${TONE.cell})`,
          fillOpacity: (low + hash(col + 7, row + 3) * high) * k,
          stroke: `rgb(${TONE.cell})`,
          strokeOpacity: TONE.stroke * k,
          strokeWidth: 1.5,
        }),
      );
    }
  }
  return h(
    "svg",
    {
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      style: { position: "absolute", top: 0, left: 0 },
    },
    ...polygons,
  );
}

/** Satori takes a URL, a data URL or the raw image bytes. */
export type OgImageSource = string | ArrayBuffer;

export function pageOgCard({
  input,
  logo,
  mascot,
}: {
  input: OgCardInput;
  logo: OgImageSource | null;
  mascot: OgImageSource | null;
}): OgNode {
  const size = fitSize(input.title, [
    { max: 26, size: 80 },
    { max: 48, size: 66 },
    { max: 75, size: 56 },
    { max: 999, size: 48 },
  ]);

  const chip = h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: logo ? "9px 20px 9px 12px" : "9px 20px",
        borderRadius: 999,
        backgroundColor: TONE.chipBg,
        color: TONE.chipInk,
        fontSize: 22,
        fontWeight: 500,
        letterSpacing: "-0.01em",
      },
    },
    logo ? h("img", { src: logo, alt: "", width: 30, height: 30 }) : null,
    "Agent Swarm",
  );

  const title = h(
    "div",
    {
      style: {
        display: "flex",
        flexWrap: "wrap",
        columnGap: Math.round(size * 0.24),
        fontWeight: 500,
        fontSize: size,
        lineHeight: 1.02,
        letterSpacing: "-0.04em",
        color: TONE.ink,
      },
    },
    ...input.lead.map((w, i) => h("span", { key: `l${i}` }, w)),
    ...input.accent.map((w, i) => h("span", { key: `a${i}`, style: { color: TONE.accent } }, w)),
  );

  const subtitle = input.subtitle
    ? h(
        "div",
        {
          style: {
            display: "flex",
            maxWidth: 620,
            fontSize: 23,
            lineHeight: 1.4,
            color: TONE.body,
          },
        },
        clip(input.subtitle, size >= 56 ? 150 : 100),
      )
    : null;

  return h(
    "div",
    {
      style: {
        width: W,
        height: H,
        display: "flex",
        position: "relative",
        backgroundColor: TONE.bg,
        fontFamily: SANS,
      },
    },
    cells(),
    mascot
      ? h("img", {
          src: mascot,
          alt: "",
          width: 560,
          height: 560,
          style: { position: "absolute", right: -6, bottom: -24 },
        })
      : null,
    h(
      "div",
      {
        style: {
          position: "relative",
          width: 720,
          height: H,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "52px 0 48px 64px",
        },
      },
      h("div", { style: { display: "flex" } }, chip),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 18 } },
        h(
          "span",
          {
            style: {
              fontFamily: MONO,
              fontSize: 18,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: TONE.meta,
            },
          },
          "/ page",
        ),
        title,
        subtitle,
      ),
      h(
        "span",
        {
          style: {
            fontFamily: MONO,
            fontSize: 16,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: TONE.meta,
          },
        },
        "Open source · MIT · Self-hosted",
      ),
    ),
  );
}
