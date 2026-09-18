import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

export const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15, 45, 60], [0, 1, 1, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 22,
          color: theme.muted,
          letterSpacing: 4,
          textTransform: "uppercase",
          opacity,
        }}
      >
        desplega<span style={{ color: theme.accent }}>.ai</span>
      </div>
    </AbsoluteFill>
  );
};
