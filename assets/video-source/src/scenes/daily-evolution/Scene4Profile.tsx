import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

const BEFORE_LINES = [
  "## Working Style",
  "- Direct, terse commits",
  "- Biome for linting",
  "- Jest for testing",
];

const ADDED_LINES = [
  "- bun test, not jest (12x faster)",
  "- integration tests must hit real DB",
];

export const Scene4Profile: React.FC = () => {
  const frame = useCurrentFrame();
  const titleOpacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateRight: "clamp",
  });
  const strikeLine3 = interpolate(frame, [40, 55], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ padding: 120, justifyContent: "center" }}>
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 22,
          color: theme.muted,
          letterSpacing: 3,
          textTransform: "uppercase",
          marginBottom: 24,
          opacity: titleOpacity,
        }}
      >
        ▸ profile.update("Picateclas")
      </div>
      <div
        style={{
          fontSize: 64,
          fontWeight: 600,
          color: theme.fg,
          marginBottom: 48,
          opacity: titleOpacity,
        }}
      >
        Agent profile evolved.
      </div>

      <div
        style={{
          padding: "32px 40px",
          border: `1px solid ${theme.border}`,
          borderRadius: 6,
          fontFamily: theme.mono,
          fontSize: 28,
          lineHeight: 1.7,
          color: theme.fg,
          backgroundColor: "rgba(255,138,61,0.03)",
        }}
      >
        <div style={{ color: theme.muted, fontSize: 22, marginBottom: 16 }}>
          # IDENTITY.md — Picateclas
        </div>
        {BEFORE_LINES.map((line, i) => {
          const isStriken = i === 3;
          return (
            <div
              key={line}
              style={{
                position: "relative",
                textDecoration: isStriken && strikeLine3 > 0.5 ? "line-through" : "none",
                opacity: isStriken && strikeLine3 > 0.5 ? 0.4 : 1,
                color: isStriken && strikeLine3 > 0.5 ? theme.muted : theme.fg,
              }}
            >
              {line}
            </div>
          );
        })}
        {ADDED_LINES.map((line, i) => {
          const appearAt = 60 + i * 20;
          const opacity = interpolate(
            frame,
            [appearAt, appearAt + 18],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          const x = interpolate(frame, [appearAt, appearAt + 18], [-20, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={line}
              style={{
                opacity,
                transform: `translateX(${x}px)`,
                color: theme.accent,
                borderLeft: `2px solid ${theme.accent}`,
                paddingLeft: 12,
                marginLeft: -14,
              }}
            >
              {line}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
