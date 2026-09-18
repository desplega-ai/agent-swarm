import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";
import { GraphSvg } from "./GraphSvg";

// Beat 1 — the graph exists. No UI chrome, just nodes and weighted edges.
export const SceneGraph: React.FC = () => {
  const frame = useCurrentFrame();
  const graphOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const capOpacity = interpolate(frame, [10, 30, 75, 90], [0, 1, 1, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <div style={{ opacity: graphOpacity }}>
        <GraphSvg showWeights />
      </div>
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
          6 nodes · 12 weighted edges · A → B
        </div>
      </div>
    </AbsoluteFill>
  );
};
