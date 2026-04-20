import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

export const Scene1Opening: React.FC = () => {
  const frame = useCurrentFrame();
  const line1Opacity = interpolate(frame, [0, 15, 90, 110], [0, 1, 1, 1], {
    extrapolateRight: "clamp",
  });
  const line2Opacity = interpolate(frame, [40, 55, 110, 120], [0, 1, 1, 0.2], {
    extrapolateRight: "clamp",
  });
  const countdownValue = Math.round(
    interpolate(frame, [55, 100], [0, 47], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );

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
            fontSize: 28,
            color: theme.muted,
            letterSpacing: 4,
            textTransform: "uppercase",
            opacity: line1Opacity,
            marginBottom: 40,
          }}
        >
          End of day — 18:42 UTC
        </div>
        <div
          style={{
            fontSize: 96,
            fontWeight: 600,
            color: theme.fg,
            lineHeight: 1.1,
            opacity: line2Opacity,
          }}
        >
          The swarm shipped{" "}
          <span
            style={{
              color: theme.accent,
              fontFamily: theme.mono,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {countdownValue}
          </span>{" "}
          tasks.
        </div>
      </div>
    </AbsoluteFill>
  );
};
