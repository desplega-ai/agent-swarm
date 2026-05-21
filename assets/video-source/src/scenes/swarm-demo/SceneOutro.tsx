import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

// 765-900 frames (25.5-30s): outro.
// Hook-first design: ends on a CTA, not just a logo card.
// "Multi-agent AI teams that ship." → "Start free at agent-swarm.dev"
export const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame(); // relative within sequence (0-134)

  // Staggered entrance
  const glowOpacity    = interpolate(frame, [0, 24],    [0, 1], { extrapolateRight: "clamp" });
  const fadeIn         = interpolate(frame, [0, 18],    [0, 1], { extrapolateRight: "clamp" });
  const logoY          = interpolate(frame, [0, 18],    [16, 0], { extrapolateRight: "clamp" });
  const eyebrowOpacity = interpolate(frame, [14, 30],   [0, 1], { extrapolateRight: "clamp" });
  const wordmarkOpacity= interpolate(frame, [22, 40],   [0, 1], { extrapolateRight: "clamp" });
  const wordmarkY      = interpolate(frame, [22, 40],   [12, 0], { extrapolateRight: "clamp" });
  const taglineOpacity = interpolate(frame, [36, 54],   [0, 1], { extrapolateRight: "clamp" });
  const dividerW       = interpolate(frame, [48, 70],   [0, 260], { extrapolateRight: "clamp" });
  const ctaOpacity     = interpolate(frame, [56, 74],   [0, 1], { extrapolateRight: "clamp" });
  const ctaY           = interpolate(frame, [56, 74],   [8, 0],  { extrapolateRight: "clamp" });
  const linkOpacity    = interpolate(frame, [70, 88],   [0, 1], { extrapolateRight: "clamp" });
  const accentLineW    = interpolate(frame, [0, 28],    [0, 280], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        overflow: "hidden",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Grid overlay */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.45) 1px, transparent 1px), " +
            "linear-gradient(90deg, rgba(255,255,255,0.45) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
          opacity: 0.05,
        }}
      />

      {/* Amber radial glow from bottom-centre */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 65% 45% at 50% 100%, rgba(180,83,9,0.28) 0%, transparent 65%)",
          opacity: glowOpacity,
        }}
      />

      {/* Amber accent line above wordmark */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: accentLineW,
          height: 1,
          background: theme.gradientText,
          opacity: 0.32,
          marginTop: -130,
        }}
      />

      {/* Main content */}
      <div
        style={{
          textAlign: "center",
          opacity: fadeIn,
          transform: `translateY(${logoY}px)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0,
        }}
      >
        {/* Eyebrow */}
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 12,
            fontWeight: 400,
            color: theme.accent,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            marginBottom: 24,
            opacity: eyebrowOpacity,
          }}
        >
          / open source · mit
        </div>

        {/* Wordmark */}
        <div
          style={{
            opacity: wordmarkOpacity,
            transform: `translateY(${wordmarkY}px)`,
          }}
        >
          <div
            style={{
              fontFamily: theme.sans,
              fontSize: 96,
              fontWeight: 700,
              color: theme.fg,
              letterSpacing: "-0.045em",
              lineHeight: 0.95,
              marginBottom: 26,
            }}
          >
            Agent Swarm
          </div>
        </div>

        {/* Tagline — the hook */}
        <div
          style={{
            fontFamily: theme.sans,
            fontSize: 28,
            fontWeight: 400,
            color: theme.muted,
            letterSpacing: "-0.02em",
            marginBottom: 32,
            opacity: taglineOpacity,
          }}
        >
          Multi-agent AI teams that ship.
        </div>

        {/* Divider */}
        <div
          style={{
            width: dividerW,
            height: 1,
            background: "rgba(255,255,255,0.10)",
            marginBottom: 28,
          }}
        />

        {/* CTA */}
        <div
          style={{
            opacity: ctaOpacity,
            transform: `translateY(${ctaY}px)`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              background: "rgba(180,83,9,0.14)",
              border: `1px solid rgba(180,83,9,0.40)`,
              borderRadius: 12,
              padding: "10px 28px",
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
                fontFamily: theme.sans,
                fontSize: 22,
                fontWeight: 600,
                color: theme.accentLight,
                letterSpacing: "-0.01em",
              }}
            >
              Start free — it&rsquo;s open source
            </span>
          </div>
        </div>

        {/* Link */}
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 18,
            fontWeight: 400,
            color: "rgba(255,255,255,0.38)",
            letterSpacing: "0.04em",
            marginTop: 20,
            opacity: linkOpacity,
          }}
        >
          agent-swarm.dev
        </div>
      </div>
    </AbsoluteFill>
  );
};
