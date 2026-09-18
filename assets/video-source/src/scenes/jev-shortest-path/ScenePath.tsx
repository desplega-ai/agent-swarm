import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";
import { GraphSvg } from "./GraphSvg";
import { jevPositions, jevPath, jevWeight } from "./graph";

// Beat 3 — the decoded path draws from the landed positions.
export const ScenePath: React.FC = () => {
  const frame = useCurrentFrame();
  const capOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });
  const drawProgress = interpolate(frame, [10, 70], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const weightOpacity = interpolate(frame, [75, 95], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <GraphSvg
        showWeights
        badges={jevPositions}
        highlightPath={jevPath}
        highlightColor={theme.accent}
        highlightProgress={drawProgress}
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
            color: theme.accent,
            letterSpacing: 3,
            textTransform: "uppercase",
          }}
        >
          Decoded path: A → D → F → B
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 70,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: weightOpacity,
        }}
      >
        <span style={{ fontFamily: theme.mono, fontSize: 40, fontWeight: 700, color: theme.fg }}>
          weight {jevWeight}
        </span>
      </div>
    </AbsoluteFill>
  );
};
