import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

const ANGLES = [
  { label: "A", title: "Slack → PR pipeline", beat: "the autonomous flex" },
  { label: "B", title: "Dashboard POV", beat: "the spectacle" },
  {
    label: "C",
    title: "Daily evolution",
    beat: "the compounding memory",
    picked: true,
  },
  { label: "D", title: "Agents arguing", beat: "the personalities" },
  { label: "E", title: "One task, one day", beat: "the time-lapse" },
];

export const SceneBrainstorm: React.FC = () => {
  const frame = useCurrentFrame();
  const titleOp = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ padding: 120, justifyContent: "center" }}>
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 22,
          color: theme.muted,
          textTransform: "uppercase",
          letterSpacing: 3,
          marginBottom: 24,
          opacity: titleOp,
        }}
      >
        ▸ brainstorm → 5 angles
      </div>
      <div
        style={{
          fontSize: 60,
          fontWeight: 700,
          color: theme.fg,
          marginBottom: 48,
          opacity: titleOp,
        }}
      >
        Pick a feeling for the README.
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 18,
        }}
      >
        {ANGLES.map((a, i) => {
          const appearAt = 25 + i * 14;
          const op = interpolate(
            frame,
            [appearAt, appearAt + 18],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          const pickedAt = 130;
          const isPicked = a.picked;
          const pickOpacity = isPicked
            ? interpolate(frame, [pickedAt, pickedAt + 20], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })
            : 0;
          const dim = isPicked
            ? 1
            : interpolate(frame, [pickedAt, pickedAt + 20], [1, 0.35], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              });

          return (
            <div
              key={a.label}
              style={{
                opacity: op * dim,
                padding: "28px 24px",
                border: `1px solid ${theme.border}`,
                borderRadius: 6,
                position: "relative",
                backgroundColor: theme.card,
              }}
            >
              <div
                style={{
                  fontFamily: theme.mono,
                  fontSize: 56,
                  fontWeight: 700,
                  color: isPicked ? theme.accent : theme.mutedDim,
                  lineHeight: 1,
                  marginBottom: 16,
                }}
              >
                {a.label}
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  color: theme.fg,
                  marginBottom: 8,
                  lineHeight: 1.25,
                }}
              >
                {a.title}
              </div>
              <div
                style={{
                  fontFamily: theme.mono,
                  fontSize: 16,
                  color: theme.muted,
                }}
              >
                {a.beat}
              </div>
              {isPicked && (
                <div
                  style={{
                    position: "absolute",
                    inset: -2,
                    border: `3px solid ${theme.accent}`,
                    borderRadius: 6,
                    opacity: pickOpacity,
                    pointerEvents: "none",
                  }}
                />
              )}
              {isPicked && (
                <div
                  style={{
                    position: "absolute",
                    top: -12,
                    right: 12,
                    backgroundColor: theme.accent,
                    color: theme.accentFg,
                    fontFamily: theme.mono,
                    fontSize: 14,
                    fontWeight: 700,
                    letterSpacing: 2,
                    padding: "4px 10px",
                    borderRadius: 4,
                    textTransform: "uppercase",
                    opacity: pickOpacity,
                  }}
                >
                  picked
                </div>
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
