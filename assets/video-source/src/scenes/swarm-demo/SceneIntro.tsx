import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

// 0-90 frames (0-3s): intro title card.
// Brand: zinc-950 bg, amber-700 primary, Space Grotesk wordmark.
// Logo: logo.png (orange "AS" square icon, rounded-md).
// Pattern: slash-prefixed eyebrow in Space Mono amber-700.
export const SceneIntro: React.FC = () => {
  const frame = useCurrentFrame();

  const logoOpacity = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });
  const logoScale = interpolate(frame, [0, 18], [0.85, 1], { extrapolateRight: "clamp" });
  const eyebrowOpacity = interpolate(frame, [14, 30], [0, 1], { extrapolateRight: "clamp" });
  const wordmarkOpacity = interpolate(frame, [20, 38], [0, 1], { extrapolateRight: "clamp" });
  const wordmarkY = interpolate(frame, [20, 38], [12, 0], { extrapolateRight: "clamp" });
  const taglineOpacity = interpolate(frame, [38, 56], [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [72, 90], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        justifyContent: "center",
        alignItems: "center",
        opacity: fadeOut,
      }}
    >
      {/* Subtle amber horizontal accent line */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: interpolate(frame, [5, 25], [0, 140], { extrapolateRight: "clamp" }),
          height: 1,
          background: theme.gradientText,
          opacity: 0.35,
          marginTop: -108,
        }}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 20,
        }}
      >
        {/* Logo — logo.png (orange "AS" square icon) */}
        <div
          style={{
            opacity: logoOpacity,
            transform: `scale(${logoScale})`,
          }}
        >
          <Img
            src={staticFile("brand/logo.png")}
            style={{
              width: 64,
              height: 64,
              objectFit: "contain",
              borderRadius: 14,
              boxShadow: "0 4px 24px -4px rgba(245,158,11,0.45)",
            }}
          />
        </div>

        <div
          style={{
            opacity: wordmarkOpacity,
            transform: `translateY(${wordmarkY}px)`,
            textAlign: "center",
          }}
        >
          {/* Slash-prefixed eyebrow — amber-700 Space Mono */}
          <div
            style={{
              fontFamily: theme.mono,
              fontSize: 11,
              fontWeight: 400,
              color: theme.accent,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              marginBottom: 16,
              opacity: eyebrowOpacity,
            }}
          >
            / agent swarm
          </div>

          {/* Wordmark — Space Grotesk 600 */}
          <div
            style={{
              fontFamily: theme.sans,
              fontSize: 64,
              fontWeight: 600,
              color: theme.fg,
              letterSpacing: "-0.04em",
              lineHeight: 1,
            }}
          >
            Agent Swarm
          </div>

          {/* Tagline */}
          <div
            style={{
              fontFamily: theme.sans,
              fontSize: 19,
              fontWeight: 400,
              color: theme.muted,
              letterSpacing: "-0.02em",
              marginTop: 16,
              opacity: taglineOpacity,
            }}
          >
            Your AI engineering team
          </div>
        </div>
      </div>

    </AbsoluteFill>
  );
};
