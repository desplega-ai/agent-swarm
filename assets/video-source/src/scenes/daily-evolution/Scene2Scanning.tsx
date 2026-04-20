import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

const AGENTS = [
  "Picateclas",
  "Reviewer",
  "Researcher",
  "Tester",
  "Jackknife",
  "UX-Principles",
];

export const Scene2Scanning: React.FC = () => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [10, 80], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleOpacity = interpolate(frame, [0, 12], [0, 1], {
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
          opacity: titleOpacity,
          marginBottom: 24,
        }}
      >
        ▸ lead.daily_evolution()
      </div>
      <div
        style={{
          fontSize: 72,
          fontWeight: 600,
          color: theme.fg,
          marginBottom: 64,
          opacity: titleOpacity,
        }}
      >
        Scanning{" "}
        <span
          style={{ color: theme.accent, fontFamily: theme.mono }}
        >
          {Math.round(progress * 47)}
        </span>
        /47 transcripts
      </div>

      <div
        style={{
          height: 6,
          width: "100%",
          backgroundColor: theme.border,
          borderRadius: 2,
          overflow: "hidden",
          marginBottom: 56,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${progress * 100}%`,
            backgroundColor: theme.accent,
          }}
        />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        {AGENTS.map((agent, i) => {
          const appearAt = 18 + i * 7;
          const opacity = interpolate(
            frame,
            [appearAt, appearAt + 10],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          const checkAt = appearAt + 18 + i * 3;
          const checked = frame > checkAt;
          return (
            <div
              key={agent}
              style={{
                opacity,
                padding: "14px 22px",
                border: `1px solid ${theme.border}`,
                borderRadius: 6,
                fontFamily: theme.mono,
                fontSize: 22,
                color: checked ? theme.accent : theme.fg,
                backgroundColor: "rgba(255,138,61,0.04)",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ color: checked ? theme.accent : theme.muted }}>
                {checked ? "✓" : "·"}
              </span>
              {agent}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
