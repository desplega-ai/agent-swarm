import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

export const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const op = interpolate(frame, [0, 15, 45, 60], [0, 1, 1, 0.4], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", padding: 120 }}
    >
      <div style={{ textAlign: "center", opacity: op }}>
        <div
          style={{
            fontSize: 96,
            fontWeight: 700,
            color: theme.fg,
            lineHeight: 1.1,
            marginBottom: 28,
          }}
        >
          <span style={{ color: theme.accent }}>~40 min.</span>{" "}
          <span style={{ color: theme.muted }}>Slack → merged PR.</span>
        </div>
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 28,
            color: theme.muted,
            letterSpacing: 2,
          }}
        >
          agent-swarm.dev
        </div>
      </div>
    </AbsoluteFill>
  );
};
