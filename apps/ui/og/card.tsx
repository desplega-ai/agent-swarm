/* ============================================================
   Dashboard Open Graph card: the "Hive field" look from the
   agent-swarm.dev /api/og card (agent-swarm-landing
   src/lib/og/hive-field.tsx), with dashboard copy.

   Satori cannot read the dashboard CSS, OKLCH, or Google Fonts,
   so tokens are sRGB hex copies of src/styles/globals.css and the
   brand fonts ship as local TTFs in ./fonts.
   ============================================================ */

export const OG_SIZE = { width: 1200, height: 630 } as const;

const W = OG_SIZE.width;
const H = OG_SIZE.height;
const R = 46;

const C = {
  primary: "#BB4D00", // amber-700 / --primary (light)
  amber500: "#FE9A00", // amber-500 / --primary (dark), the gradient-text midpoint
  gold: "#D0930F", // logo hexagon
  zinc950: "#09090B",
  zinc600: "#52525C",
} as const;

export const SANS = "Space Grotesk";
export const MONO = "Space Mono";

export type OgText = {
  eyebrow: string;
  /** First headline line, plain. */
  lead: string;
  /** Second headline line, gradient accent. */
  accent: string;
  subtitle: string;
  footnote: string;
};

function hash(col: number, row: number) {
  let h = Math.imul(col, 0x9e3779b1) ^ Math.imul(row, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

function hex(cx: number, cy: number, r: number) {
  const h = 0.866 * r;
  return `${cx + r},${cy} ${cx + r / 2},${cy - h} ${cx - r / 2},${cy - h} ${cx - r},${cy} ${cx - r / 2},${cy + h} ${cx + r / 2},${cy + h}`;
}

function HexField() {
  const cells: { points: string; fill: number }[] = [];
  const colStep = R * 1.5;
  const rowStep = Math.sqrt(3) * R;
  for (let col = -1; col * colStep < W + R; col++) {
    for (let row = -1; row * rowStep < H + R; row++) {
      const cx = col * colStep;
      const cy = row * rowStep + (col % 2 ? rowStep / 2 : 0);
      cells.push({ points: hex(cx, cy, R - 2), fill: hash(col + 7, row + 3) });
    }
  }
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, and Satori would paint a <title> as text.
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      style={{ position: "absolute", top: 0, left: 0 }}
    >
      {cells.map((c, i) => (
        <polygon
          key={i}
          points={c.points}
          fill={C.amber500}
          fillOpacity={c.fill > 0.72 ? 0.16 : c.fill > 0.4 ? 0.07 : 0.025}
          stroke={C.gold}
          strokeOpacity={0.18}
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}

export function HiveFieldCard({ text, logo }: { text: OgText; logo: string }) {
  const longest = Math.max(text.lead.length, text.accent.length);
  const size = longest <= 22 ? 84 : longest <= 28 ? 72 : 64;
  const accentStyle = {
    backgroundImage: `linear-gradient(135deg, ${C.primary}, ${C.amber500})`,
    backgroundClip: "text",
    color: "transparent",
  };

  return (
    <div
      style={{
        width: W,
        height: H,
        display: "flex",
        position: "relative",
        backgroundColor: "#FFFCF7",
        fontFamily: SANS,
      }}
    >
      <HexField />
      {/* Wash: keeps the hive at the edges and clears a reading field in the middle. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: W,
          height: H,
          backgroundImage:
            "radial-gradient(ellipse 62% 58% at 50% 54%, rgba(255,252,247,0.97) 0%, rgba(255,252,247,0.9) 55%, rgba(255,252,247,0) 100%)",
        }}
      />
      <div
        style={{
          position: "relative",
          width: W,
          height: H,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "44px 80px 44px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img src={logo} alt="" width={40} height={40} />
          <span
            style={{ fontSize: 26, fontWeight: 700, color: C.zinc950, letterSpacing: "-0.02em" }}
          >
            Agent Swarm
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 20,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: C.primary,
            }}
          >
            {text.eyebrow}
          </span>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              maxWidth: 1040,
              fontWeight: 500,
              fontSize: size,
              lineHeight: 1.04,
              letterSpacing: "-0.035em",
              color: C.zinc950,
            }}
          >
            <span>{text.lead}</span>
            <span style={accentStyle}>{text.accent}</span>
          </div>
          <div
            style={{
              display: "flex",
              textAlign: "center",
              justifyContent: "center",
              maxWidth: 900,
              fontSize: text.subtitle.length > 110 ? 24 : 26,
              lineHeight: 1.4,
              color: C.zinc600,
              textWrap: "balance",
            }}
          >
            {text.subtitle}
          </div>
        </div>

        <span style={{ fontFamily: MONO, fontSize: 19, color: C.zinc600 }}>{text.footnote}</span>
      </div>
    </div>
  );
}
