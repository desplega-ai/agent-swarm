import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

// Pseudo-random but deterministic node positions
const seed = (i: number) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const TOTAL_NODES = 180;
const NODES = Array.from({ length: TOTAL_NODES }, (_, i) => ({
  id: i,
  x: 200 + seed(i) * 1520,
  y: 180 + seed(i + 100) * 620,
  r: 3 + seed(i + 200) * 5,
  addedAtDay: Math.floor(seed(i + 300) * 7),
}));

export const Scene5Graph: React.FC = () => {
  const frame = useCurrentFrame();
  const titleOpacity = interpolate(frame, [0, 22], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Paced to fill ~15s — the scene the whole piece leans on.
  // Map frames 30..400 across 7 days, then hold.
  const dayFloat = interpolate(frame, [30, 400], [0, 7], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const visibleNodes = NODES.filter((n) => n.addedAtDay <= dayFloat);
  const nodeCount = visibleNodes.length;

  const dayLabel = `Day ${Math.min(7, Math.ceil(dayFloat) || 1)}`;

  return (
    <AbsoluteFill style={{ padding: 120, justifyContent: "center" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          marginBottom: 24,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: theme.mono,
              fontSize: 22,
              color: theme.muted,
              letterSpacing: 3,
              textTransform: "uppercase",
              marginBottom: 12,
              opacity: titleOpacity,
            }}
          >
            ▸ memory.graph · 7-day timelapse
          </div>
          <div
            style={{
              fontSize: 64,
              fontWeight: 600,
              color: theme.fg,
              opacity: titleOpacity,
            }}
          >
            Memory compounds.
          </div>
        </div>
        <div
          style={{
            fontFamily: theme.mono,
            textAlign: "right",
            opacity: titleOpacity,
          }}
        >
          <div style={{ fontSize: 20, color: theme.muted }}>{dayLabel}</div>
          <div
            style={{
              fontSize: 56,
              color: theme.accent,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {nodeCount}
          </div>
          <div style={{ fontSize: 18, color: theme.muted }}>memories</div>
        </div>
      </div>

      <div
        style={{
          position: "relative",
          flex: 1,
          border: `1px solid ${theme.border}`,
          borderRadius: 6,
          backgroundColor: "rgba(255,255,255,0.01)",
          overflow: "hidden",
        }}
      >
        <svg
          width="100%"
          height="100%"
          viewBox="0 0 1680 820"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Connections */}
          {visibleNodes.slice(0, 120).map((n, i) => {
            const target = visibleNodes[(i + 7) % visibleNodes.length];
            if (!target) return null;
            return (
              <line
                key={`l-${n.id}`}
                x1={n.x - 200}
                y1={n.y - 180}
                x2={target.x - 200}
                y2={target.y - 180}
                stroke={theme.accentDim}
                strokeOpacity={0.25}
                strokeWidth={1}
              />
            );
          })}
          {/* Nodes */}
          {visibleNodes.map((n) => {
            const appearFrame = 30 + (n.addedAtDay / 7) * 370;
            const scale = interpolate(
              frame,
              [appearFrame, appearFrame + 10],
              [0, 1],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
            );
            return (
              <circle
                key={n.id}
                cx={n.x - 200}
                cy={n.y - 180}
                r={n.r * scale}
                fill={theme.accent}
                fillOpacity={0.75}
              />
            );
          })}
        </svg>
      </div>
    </AbsoluteFill>
  );
};
