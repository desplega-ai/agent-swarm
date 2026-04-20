import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

const SCENES = [
  "opening · 18:42 UTC",
  "scanning 47 transcripts",
  "4 memories indexed",
  "IDENTITY.md diff · Picateclas",
  "7-day memory graph",
  "outro · the swarm learns",
];

export const SceneRender: React.FC = () => {
  const frame = useCurrentFrame();
  const headerOp = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });
  const progressWidth = interpolate(frame, [20, 150], [0, 100], {
    extrapolateRight: "clamp",
  });
  const percent = Math.round(progressWidth);

  return (
    <AbsoluteFill style={{ padding: 120, justifyContent: "center" }}>
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 22,
          color: theme.muted,
          textTransform: "uppercase",
          letterSpacing: 3,
          marginBottom: 20,
          opacity: headerOp,
        }}
      >
        ▸ remotion render · 1920×1080 @ 30fps
      </div>
      <div
        style={{
          fontSize: 64,
          fontWeight: 700,
          color: theme.fg,
          marginBottom: 48,
          opacity: headerOp,
        }}
      >
        Rendering the 6 scenes.
      </div>

      <div
        style={{
          backgroundColor: theme.card,
          border: `1px solid ${theme.border}`,
          borderRadius: 8,
          padding: 32,
          marginBottom: 32,
        }}
      >
        <div
          style={{
            height: 14,
            backgroundColor: "rgba(255,255,255,0.04)",
            borderRadius: 100,
            overflow: "hidden",
            marginBottom: 20,
          }}
        >
          <div
            style={{
              width: `${progressWidth}%`,
              height: "100%",
              backgroundColor: theme.accent,
              borderRadius: 100,
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: theme.mono,
            fontSize: 20,
            color: theme.muted,
          }}
        >
          <span>
            frame{" "}
            <span style={{ color: theme.fg }}>
              {Math.round((progressWidth / 100) * 900)}
            </span>{" "}
            / 900
          </span>
          <span style={{ color: theme.accent }}>{percent}%</span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 14,
        }}
      >
        {SCENES.map((s, i) => {
          const appearAt = 24 + i * 18;
          const op = interpolate(frame, [appearAt, appearAt + 14], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={s}
              style={{
                opacity: op,
                padding: "16px 20px",
                border: `1px solid ${theme.border}`,
                borderRadius: 6,
                fontFamily: theme.mono,
                fontSize: 18,
                color: theme.fg,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ color: theme.accent }}>✓</span>
              {s}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
