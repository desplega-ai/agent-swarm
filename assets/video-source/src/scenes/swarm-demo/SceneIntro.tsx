import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

// 0-90 frames (0-3s): intro title card.
// Visual: zinc-950 bg + subtle grid overlay + amber top glow (landing-hero pattern).
// Version badge: amber pulse dot + "v1.81.0" eyebrow in Space Mono.
// Wordmark: "Agent Swarm" large in Space Grotesk 700.
// Features: "People tab · Linked identities · Activity timeline".
export const SceneIntro: React.FC = () => {
  const frame = useCurrentFrame();

  // Staggered entrance animations
  const glowOpacity   = interpolate(frame, [0, 20],    [0, 1], { extrapolateRight: "clamp" });
  const logoOpacity   = interpolate(frame, [0, 18],    [0, 1], { extrapolateRight: "clamp" });
  const logoScale     = interpolate(frame, [0, 18],    [0.82, 1], { extrapolateRight: "clamp" });
  const eyebrowOpacity= interpolate(frame, [16, 32],   [0, 1], { extrapolateRight: "clamp" });
  const wordmarkOpacity=interpolate(frame, [22, 40],   [0, 1], { extrapolateRight: "clamp" });
  const wordmarkY     = interpolate(frame, [22, 40],   [14, 0], { extrapolateRight: "clamp" });
  const badgeOpacity  = interpolate(frame, [36, 52],   [0, 1], { extrapolateRight: "clamp" });
  const featureOpacity= interpolate(frame, [48, 64],   [0, 1], { extrapolateRight: "clamp" });
  const fadeOut       = interpolate(frame, [72, 90],   [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const masterOpacity = fadeOut;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        overflow: "hidden",
        opacity: masterOpacity,
      }}
    >
      {/* Grid overlay — 60px mesh, same pattern as landing hero */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.45) 1px, transparent 1px), " +
            "linear-gradient(90deg, rgba(255,255,255,0.45) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
          opacity: 0.06,
        }}
      />

      {/* Amber radial glow from top-centre */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 70% 50% at 50% 0%, rgba(180,83,9,0.32) 0%, transparent 65%)",
          opacity: glowOpacity,
        }}
      />

      {/* Content — vertically centred */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 0,
        }}
      >
        {/* Logo */}
        <div
          style={{
            opacity: logoOpacity,
            transform: `scale(${logoScale})`,
            marginBottom: 28,
          }}
        >
          <Img
            src={staticFile("brand/logo.png")}
            style={{
              width: 80,
              height: 80,
              objectFit: "contain",
              borderRadius: 18,
              boxShadow: "0 6px 32px -4px rgba(245,158,11,0.55)",
            }}
          />
        </div>

        {/* Version badge — amber pulse dot + "/ agent swarm · v1.81.0" */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 20,
            opacity: eyebrowOpacity * badgeOpacity,
          }}
        >
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: theme.accentMid,
              boxShadow: `0 0 8px 2px ${theme.accentMid}`,
            }}
          />
          <span
            style={{
              fontFamily: theme.mono,
              fontSize: 12,
              fontWeight: 400,
              color: theme.accent,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            / agent swarm · v1.81.0
          </span>
        </div>

        {/* Wordmark */}
        <div
          style={{
            opacity: wordmarkOpacity,
            transform: `translateY(${wordmarkY}px)`,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: theme.sans,
              fontSize: 100,
              fontWeight: 700,
              color: theme.fg,
              letterSpacing: "-0.045em",
              lineHeight: 0.95,
              marginBottom: 32,
            }}
          >
            Agent Swarm
          </div>

          {/* Shipping-in label */}
          <div
            style={{
              fontFamily: theme.sans,
              fontSize: 22,
              fontWeight: 400,
              color: theme.muted,
              letterSpacing: "-0.01em",
              marginBottom: 20,
            }}
          >
            Your AI engineering team
          </div>
        </div>

        {/* Feature chips */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            opacity: featureOpacity,
            marginTop: 4,
          }}
        >
          {["People tab", "Linked identities", "Activity timeline"].map((feat) => (
            <div
              key={feat}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.10)",
                borderRadius: 20,
                padding: "5px 14px",
              }}
            >
              <div
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: theme.accentMid,
                }}
              />
              <span
                style={{
                  fontFamily: theme.mono,
                  fontSize: 11,
                  fontWeight: 400,
                  color: "rgba(255,255,255,0.60)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
              >
                {feat}
              </span>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
