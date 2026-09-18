import { theme } from "../../theme";
import { nodes, edges, nodeById, pathEdges, type NodeId } from "./graph";

const GX = 15;
const GY = 110;

// A few edge midpoints coincide closely enough to overlap their weight labels
// (C-D/A-F, D-B/E-F). Nudge just those four away from each other.
const LABEL_OFFSET: Partial<Record<string, { dx: number; dy: number }>> = {
  "A-F": { dx: 34, dy: 24 },
  "C-D": { dx: -34, dy: -24 },
  "D-B": { dx: 0, dy: -30 },
  "E-F": { dx: 36, dy: 6 },
};

type Props = {
  // Edge weight labels visible
  showWeights?: boolean;
  // Node position badges (jev output), e.g. { A: "1", C: "out", ... }
  badges?: Partial<Record<NodeId, string>>;
  badgeOpacity?: number;
  // Highlighted path (drawn as thick colored line over the base graph)
  highlightPath?: NodeId[];
  highlightColor?: string;
  highlightProgress?: number; // 0..1, how much of the path is drawn
  // Second highlighted path (for compare beat), offset to the side visually via dash
  comparePath?: NodeId[];
  compareColor?: string;
  compareProgress?: number;
  dimBase?: boolean;
};

export const GraphSvg: React.FC<Props> = ({
  showWeights = true,
  badges,
  badgeOpacity = 1,
  highlightPath,
  highlightColor = theme.accent,
  highlightProgress = 1,
  comparePath,
  compareColor = theme.success,
  compareProgress = 1,
  dimBase = false,
}) => {
  const hEdges = highlightPath ? pathEdges(highlightPath) : [];
  const cEdges = comparePath ? pathEdges(comparePath) : [];

  const isInPath = (a: NodeId, b: NodeId, list: [NodeId, NodeId][]) =>
    list.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

  return (
    <svg width={1080} height={1080} style={{ position: "absolute", inset: 0 }}>
      <g transform={`translate(${GX}, ${GY})`}>
        {/* base edges */}
        {edges.map((e) => {
          const a = nodeById[e.from];
          const b = nodeById[e.to];
          const inH = isInPath(e.from, e.to, hEdges);
          const inC = isInPath(e.from, e.to, cEdges);
          const active = inH || inC;
          return (
            <g key={`${e.from}-${e.to}`}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={active ? "transparent" : theme.border}
                strokeWidth={3}
                opacity={dimBase && !active ? 0.35 : 1}
              />
              {showWeights &&
                (() => {
                  const off = LABEL_OFFSET[`${e.from}-${e.to}`] ?? { dx: 0, dy: 0 };
                  const lx = (a.x + b.x) / 2 + off.dx;
                  const ly = (a.y + b.y) / 2 + off.dy;
                  return (
                    <g>
                      <rect
                        x={lx - 16}
                        y={ly - 15}
                        width={32}
                        height={30}
                        rx={6}
                        fill={theme.bg}
                        opacity={dimBase && !active ? 0.5 : 0.92}
                      />
                      <text
                        x={lx}
                        y={ly + 7}
                        fontFamily={theme.mono}
                        fontSize={22}
                        fill={active ? theme.fg : theme.muted}
                        textAnchor="middle"
                        opacity={dimBase && !active ? 0.6 : 1}
                      >
                        {e.weight}
                      </text>
                    </g>
                  );
                })()}
            </g>
          );
        })}

        {/* compare path (drawn under highlight) */}
        {comparePath &&
          cEdges.map(([from, to], i) => {
            const segFrac = 1 / cEdges.length;
            const start = i * segFrac;
            const t = Math.max(0, Math.min(1, (compareProgress - start) / segFrac));
            if (t <= 0) return null;
            const a = nodeById[from];
            const b = nodeById[to];
            const mx = a.x + (b.x - a.x) * t;
            const my = a.y + (b.y - a.y) * t;
            return (
              <line
                key={`cmp-${from}-${to}`}
                x1={a.x}
                y1={a.y}
                x2={mx}
                y2={my}
                stroke={compareColor}
                strokeWidth={10}
                strokeLinecap="round"
              />
            );
          })}

        {/* highlight path (jev decoded) */}
        {highlightPath &&
          hEdges.map(([from, to], i) => {
            const segFrac = 1 / hEdges.length;
            const start = i * segFrac;
            const t = Math.max(0, Math.min(1, (highlightProgress - start) / segFrac));
            if (t <= 0) return null;
            const a = nodeById[from];
            const b = nodeById[to];
            const mx = a.x + (b.x - a.x) * t;
            const my = a.y + (b.y - a.y) * t;
            return (
              <line
                key={`hl-${from}-${to}`}
                x1={a.x}
                y1={a.y}
                x2={mx}
                y2={my}
                stroke={highlightColor}
                strokeWidth={10}
                strokeLinecap="round"
              />
            );
          })}

        {/* nodes */}
        {nodes.map((n) => {
          const isEndpoint = n.id === "A" || n.id === "B";
          return (
            <g key={n.id}>
              <circle
                cx={n.x}
                cy={n.y}
                r={34}
                fill={theme.card}
                stroke={isEndpoint ? theme.accent : theme.borderStrong}
                strokeWidth={isEndpoint ? 4 : 2.5}
              />
              <text
                x={n.x}
                y={n.y + 10}
                fontFamily={theme.sans}
                fontWeight={700}
                fontSize={30}
                fill={theme.fg}
                textAnchor="middle"
              >
                {n.id}
              </text>
              {badges && badges[n.id] !== undefined && (
                <g opacity={badgeOpacity}>
                  <rect
                    x={n.x + 20}
                    y={n.y - 56}
                    width={badges[n.id] === "out" ? 56 : 38}
                    height={34}
                    rx={8}
                    fill={theme.accent}
                  />
                  <text
                    x={n.x + 20 + (badges[n.id] === "out" ? 28 : 19)}
                    y={n.y - 33}
                    fontFamily={theme.mono}
                    fontWeight={700}
                    fontSize={20}
                    fill={theme.accentFg}
                    textAnchor="middle"
                  >
                    {badges[n.id]}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
};
