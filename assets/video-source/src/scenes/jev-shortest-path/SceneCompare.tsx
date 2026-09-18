import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";
import { GraphSvg } from "./GraphSvg";
import { jevPath, jevWeight, dijkstraPath, dijkstraWeight, excess } from "./graph";

// Beat 4 — Dijkstra's optimum draws beside the Jev path so the gap is visible.
// Nothing here may imply Jev "beat" Dijkstra — Dijkstra is zero-call, zero-excess
// by construction; this beat shows the cost of one call vs the true optimum.
export const SceneCompare: React.FC = () => {
  const frame = useCurrentFrame();
  const capOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });
  const drawProgress = interpolate(frame, [15, 65], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rowsOpacity = interpolate(frame, [80, 105], [0, 1], { extrapolateRight: "clamp" });
  const excessOpacity = interpolate(frame, [120, 140], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <GraphSvg
        showWeights
        highlightPath={jevPath}
        highlightColor={theme.accent}
        highlightProgress={1}
        comparePath={dijkstraPath}
        compareColor={theme.success}
        compareProgress={drawProgress}
        dimBase
      />
      <div
        style={{
          position: "absolute",
          top: 90,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: capOpacity,
        }}
      >
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 24,
            color: theme.muted,
            letterSpacing: 3,
            textTransform: "uppercase",
          }}
        >
          Same graph, true optimum
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 56,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          gap: 64,
          opacity: rowsOpacity,
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: theme.mono, fontSize: 18, color: theme.accent, letterSpacing: 2 }}>
            JEV · 1 CALL
          </div>
          <div style={{ fontFamily: theme.mono, fontSize: 44, fontWeight: 700, color: theme.fg }}>
            {jevWeight}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: theme.mono, fontSize: 18, color: theme.success, letterSpacing: 2 }}>
            DIJKSTRA · 0 CALLS
          </div>
          <div style={{ fontFamily: theme.mono, fontSize: 44, fontWeight: 700, color: theme.fg }}>
            {dijkstraWeight}
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 10,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: excessOpacity,
        }}
      >
        <span style={{ fontFamily: theme.mono, fontSize: 20, color: theme.danger }}>
          +{excess} over optimal
        </span>
      </div>
    </AbsoluteFill>
  );
};
