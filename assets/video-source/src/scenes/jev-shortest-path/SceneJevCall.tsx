import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";
import { GraphSvg } from "./GraphSvg";
import { jevPositions } from "./graph";

// Beat 2 — one Jev call fires, the whole node-position assignment lands at once.
// This is the beat that kills the "one pick per second" metronome: badges
// appear together on a single pulse, not one-by-one.
export const SceneJevCall: React.FC = () => {
  const frame = useCurrentFrame();
  const capOpacity = interpolate(frame, [0, 15, 100, 120], [0, 1, 1, 0], {
    extrapolateRight: "clamp",
  });
  const pulse = interpolate(frame, [40, 46, 60], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const badgeOpacity = interpolate(frame, [44, 58], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <GraphSvg showWeights badges={frame >= 44 ? jevPositions : undefined} badgeOpacity={badgeOpacity} />
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
          {frame < 44 ? "One Jev call" : "All six node positions, one response"}
        </div>
      </div>
      {/* flash ring to sell "fires" without a spinner */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: theme.accent,
          opacity: pulse * 0.08,
        }}
      />
    </AbsoluteFill>
  );
};
