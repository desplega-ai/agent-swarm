import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

// 765-900 frames (25.5-30s): outro title card.
// Brand: zinc-950 bg, amber-700 primary, Space Grotesk wordmark, agent-swarm.dev.
// Pattern: slash-prefixed eyebrow in Space Mono amber-700.
export const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame(); // relative within sequence (0-134)

  const fadeIn = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });
  const logoY = interpolate(frame, [0, 18], [14, 0], { extrapolateRight: "clamp" });
  const eyebrowOpacity = interpolate(frame, [16, 32], [0, 1], { extrapolateRight: "clamp" });
  const linkOpacity = interpolate(frame, [24, 42], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Amber accent line */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: interpolate(frame, [0, 24], [0, 240], { extrapolateRight: "clamp" }),
          height: 1,
          background: theme.gradientText,
          opacity: 0.30,
          marginTop: -92,
        }}
      />

      <div style={{ textAlign: "center", opacity: fadeIn, transform: `translateY(${logoY}px)` }}>
        {/* Slash-prefixed eyebrow — amber-700 Space Mono */}
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 11,
            fontWeight: 400,
            color: theme.accent,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            marginBottom: 20,
            opacity: eyebrowOpacity,
          }}
        >
          / open source · mit
        </div>

        {/* "Agent Swarm" wordmark — Space Grotesk 600 */}
        <div
          style={{
            fontFamily: theme.sans,
            fontSize: 76,
            fontWeight: 600,
            color: theme.fg,
            letterSpacing: "-0.04em",
            lineHeight: 1,
          }}
        >
          Agent Swarm
        </div>

        {/* agent-swarm.dev */}
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 17,
            fontWeight: 400,
            color: "rgba(255,255,255,0.40)",
            letterSpacing: "0.04em",
            marginTop: 22,
            opacity: linkOpacity,
          }}
        >
          agent-swarm.dev
        </div>
      </div>
    </AbsoluteFill>
  );
};
