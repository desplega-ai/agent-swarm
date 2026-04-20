import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

export const Scene6Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const taglineOpacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateRight: "clamp",
  });
  const subOpacity = interpolate(frame, [18, 36], [0, 1], {
    extrapolateRight: "clamp",
  });
  const logoOpacity = interpolate(frame, [30, 50], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", padding: 120 }}
    >
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            fontSize: 88,
            fontWeight: 600,
            color: theme.fg,
            marginBottom: 24,
            opacity: taglineOpacity,
            lineHeight: 1.1,
          }}
        >
          Memory that compounds.
          <br />
          Agents that{" "}
          <span style={{ color: theme.accent }}>learn.</span>
        </div>
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 28,
            color: theme.muted,
            letterSpacing: 4,
            opacity: subOpacity,
            marginTop: 48,
          }}
        >
          agent-swarm · github.com/desplega-ai/agent-swarm
        </div>
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 22,
            color: theme.accent,
            letterSpacing: 3,
            opacity: logoOpacity,
            marginTop: 24,
          }}
        >
          ▸ desplega.sh
        </div>
      </div>
    </AbsoluteFill>
  );
};
