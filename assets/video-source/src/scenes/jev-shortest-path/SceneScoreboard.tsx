import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

// Beat 5 — the scoreboard. Numbers only, no browser chrome. Every figure here
// is from jev-position-2026-09-18.md / jev-topk-2026-09-18.md verbatim — see
// graph.ts header for provenance. Nothing implies Jev beat Dijkstra: Dijkstra
// is the reference optimum at zero Jev calls, not a competitor.
const rows: { label: string; score: string; detail: string; accent?: boolean }[] = [
  { label: "Dijkstra", score: "40/40", detail: "0 calls · reference optimum" },
  { label: "Position + decode", score: "22/40", detail: "1.0 call / graph" },
  { label: "Greedy edge-walk", score: "18/40", detail: "1.725 calls / graph" },
  { label: "Top-K rescored (K=13)", score: "40/40", detail: "still 1 call / graph", accent: true },
];

export const SceneScoreboard: React.FC = () => {
  const frame = useCurrentFrame();
  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        padding: 80,
      }}
    >
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 22,
          color: theme.muted,
          letterSpacing: 3,
          textTransform: "uppercase",
          opacity: titleOpacity,
          marginBottom: 44,
        }}
      >
        40 graphs, optimal / 40
      </div>

      <div style={{ width: 860 }}>
        {rows.map((r, i) => {
          const start = 12 + i * 22;
          const rowOpacity = interpolate(frame, [start, start + 14], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const rowY = interpolate(frame, [start, start + 14], [16, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={r.label}
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                padding: "22px 0",
                borderBottom: `1px solid ${theme.border}`,
                opacity: rowOpacity,
                transform: `translateY(${rowY}px)`,
              }}
            >
              <div>
                <div style={{ fontFamily: theme.sans, fontSize: 30, fontWeight: 600, color: theme.fg }}>
                  {r.label}
                </div>
                <div style={{ fontFamily: theme.mono, fontSize: 18, color: theme.muted, marginTop: 4 }}>
                  {r.detail}
                </div>
              </div>
              <div
                style={{
                  fontFamily: theme.mono,
                  fontSize: 48,
                  fontWeight: 700,
                  color: r.accent ? theme.accent : theme.fg,
                }}
              >
                {r.score}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 44,
          fontFamily: theme.mono,
          fontSize: 16,
          color: theme.mutedDim,
          opacity: interpolate(frame, [130, 150], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          textAlign: "center",
          maxWidth: 820,
        }}
      >
        652,128 input + 118,070 output tokens across the series · no dollar figure exposed by the API
      </div>
    </AbsoluteFill>
  );
};
