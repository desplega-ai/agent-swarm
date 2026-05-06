import { useId } from "react";

type Props = {
  size?: number;
  tone?: "light" | "dark" | "bold" | "darkBold";
  labels?: boolean;
  density?: "sparse" | "dense";
  workers?: { label: string }[];
  connectors?: boolean;
};

const HEX_POINTS = "36,0 18,-31.18 -18,-31.18 -36,0 -18,31.18 18,31.18";

const RING_1 = [
  { x: 54, y: -31.18, label: "frontend" },
  { x: 54, y: 31.18, label: "backend" },
  { x: 0, y: 62.35, label: "devops" },
  { x: -54, y: 31.18, label: "qa" },
  { x: -54, y: -31.18, label: "docs" },
  { x: 0, y: -62.35, label: "pm" },
];

const RING_2 = [
  { x: 108, y: 0, label: "sre" },
  { x: 54, y: 93.53, label: "release" },
  { x: -54, y: 93.53, label: "data" },
  { x: -108, y: 0, label: "sec" },
  { x: -54, y: -93.53, label: "design" },
  { x: 54, y: -93.53, label: "eng" },
];

export function Hive({
  size = 320,
  tone = "light",
  labels = true,
  density = "sparse",
  workers,
  connectors = true,
}: Props) {
  const isBold = tone === "bold" || tone === "darkBold";
  const isDark = tone === "dark" || tone === "darkBold";
  const amber = isBold ? "oklch(0.769 0.188 70.08)" : "oklch(0.555 0.163 48.998)";
  const amberSoft = "oklch(0.769 0.188 70.08)";
  const inkLabel = isDark ? "oklch(0.705 0.015 286.067)" : "oklch(0.552 0.016 285.938)";
  const cellFill = isDark ? "oklch(1 0 0 / 0.02)" : "#fff";
  const baseStrokeOpacity = isBold ? 0.85 : 0.4;
  const lineStrokeOpacity = isBold ? 0.5 : 0.18;

  const cells = density === "dense" ? [...RING_1, ...RING_2] : RING_1;
  const labeled =
    workers && workers.length
      ? cells.map((c, i) => ({ ...c, label: workers[i % workers.length]?.label || c.label }))
      : cells;

  const half = density === "dense" ? 160 : 100;
  const halfY = density === "dense" ? 140 : 80;

  const reactId = useId();
  const id = reactId.replace(/:/g, "");

  return (
    <svg
      viewBox={`-${half} -${halfY} ${half * 2} ${halfY * 2}`}
      width={size}
      className="block"
      style={{ overflow: "visible" }}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={`leadGrad-${id}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={amberSoft} stopOpacity="0.25" />
          <stop offset="100%" stopColor={amberSoft} stopOpacity="0" />
        </radialGradient>
      </defs>
      <style>{`
        @keyframes hexLead-${id} { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .85; transform: scale(0.985); } }
        @keyframes hexFlick-${id} { 0%,15%,100% { stroke-opacity: ${baseStrokeOpacity}; fill-opacity: 0; } 25%,42% { stroke-opacity: 1; fill-opacity: .12; } }
        @keyframes hexLine-${id} { 0%,100% { stroke-dashoffset: 0; opacity: .25; } 50% { opacity: .8; } }
        .hl-${id} { animation: hexLead-${id} 2.6s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
      `}</style>

      {connectors &&
        labeled.map((c, i) => (
          <line
            key={`l-${i}`}
            x1="0"
            y1="0"
            x2={c.x}
            y2={c.y}
            stroke={amber}
            strokeWidth="0.8"
            strokeOpacity={lineStrokeOpacity}
            strokeDasharray="2 4"
            style={{ animation: `hexLine-${id} 4s ease-in-out infinite`, animationDelay: `${i * 0.3}s` }}
          />
        ))}

      {labeled.map((c, i) => (
        <g key={i} transform={`translate(${c.x}, ${c.y})`}>
          <polygon
            points={HEX_POINTS}
            fill={cellFill}
            stroke={amber}
            strokeWidth="1.4"
            style={{
              animation: `hexFlick-${id} ${3 + (i % 3) * 0.4}s ease-in-out infinite`,
              animationDelay: `${i * 0.35}s`,
              transformOrigin: "center",
              transformBox: "fill-box",
            }}
          />
          {labels && (
            <text
              textAnchor="middle"
              y="3"
              fontFamily="Space Mono, monospace"
              fontSize="8"
              fill={inkLabel}
              letterSpacing="0.04em"
            >
              {c.label}
            </text>
          )}
        </g>
      ))}

      <circle r="58" fill={`url(#leadGrad-${id})`} className={`hl-${id}`} />

      <g className={`hl-${id}`}>
        <polygon
          points={HEX_POINTS}
          fill={amber}
          fillOpacity="0.10"
          stroke={amber}
          strokeWidth="2.2"
        />
        {labels && (
          <text
            textAnchor="middle"
            y="3"
            fontFamily="Space Mono, monospace"
            fontSize="9.5"
            fontWeight="700"
            fill={amber}
            letterSpacing="0.06em"
          >
            LEAD
          </text>
        )}
      </g>
    </svg>
  );
}
