import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

export const SceneIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const titleOpacity = interpolate(frame, [0, 18, 100, 120], [0, 1, 1, 1], {
    extrapolateRight: "clamp",
  });
  const subOpacity = interpolate(frame, [30, 50, 100, 120], [0, 1, 1, 0.3], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: 120,
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 24,
            color: theme.muted,
            letterSpacing: 4,
            textTransform: "uppercase",
            opacity: titleOpacity,
            marginBottom: 36,
          }}
        >
          A case study, one Slack thread
        </div>
        <div
          style={{
            fontSize: 104,
            fontWeight: 700,
            color: theme.fg,
            lineHeight: 1.05,
            marginBottom: 28,
          }}
        >
          <span style={{ opacity: titleOpacity }}>Slack → </span>
          <span style={{ color: theme.accent, opacity: titleOpacity }}>
            PR
          </span>
        </div>
        <div
          style={{
            fontSize: 28,
            color: theme.muted,
            fontFamily: theme.mono,
            opacity: subOpacity,
          }}
        >
          How this video got made
        </div>
      </div>
    </AbsoluteFill>
  );
};
