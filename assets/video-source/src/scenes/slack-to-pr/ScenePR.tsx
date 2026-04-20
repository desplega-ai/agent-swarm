import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

const FILES = [
  "assets/agent-swarm.mp4                   | Bin 10043920 -> 2645312 bytes",
  "assets/video-source/package.json         | +19",
  "assets/video-source/src/Root.tsx         | +27",
  "assets/video-source/src/DailyEvolution…  | +33",
  "assets/video-source/src/scenes/*.tsx     | +512",
  "README.md                                | +6 -0",
];

export const ScenePR: React.FC = () => {
  const frame = useCurrentFrame();
  const cardOp = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: "clamp",
  });
  const cardY = interpolate(frame, [0, 20], [30, 0], {
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
          opacity: cardOp,
        }}
      >
        ▸ gh pr create --head lead/readme-video-wireframe
      </div>

      <div
        style={{
          opacity: cardOp,
          transform: `translateY(${cardY}px)`,
          backgroundColor: theme.card,
          border: `1px solid ${theme.border}`,
          borderRadius: 10,
          padding: 40,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 20,
          }}
        >
          <span
            style={{
              backgroundColor: theme.success,
              color: "#052e16",
              fontFamily: theme.mono,
              fontSize: 16,
              fontWeight: 700,
              padding: "6px 14px",
              borderRadius: 100,
              textTransform: "uppercase",
              letterSpacing: 2,
            }}
          >
            open
          </span>
          <span
            style={{
              fontFamily: theme.mono,
              fontSize: 22,
              color: theme.muted,
            }}
          >
            desplega-ai/agent-swarm
          </span>
          <span
            style={{
              fontFamily: theme.mono,
              fontSize: 22,
              color: theme.accent,
              marginLeft: "auto",
            }}
          >
            #350
          </span>
        </div>

        <div
          style={{
            fontSize: 52,
            fontWeight: 700,
            color: theme.fg,
            marginBottom: 12,
            lineHeight: 1.1,
          }}
        >
          readme: add wireframe video + Remotion source
        </div>

        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 20,
            color: theme.muted,
            marginBottom: 32,
          }}
        >
          lead wants to merge 9 commits into <span style={{ color: theme.fg }}>main</span>{" "}
          from <span style={{ color: theme.accent }}>lead/readme-video-wireframe</span>
        </div>

        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 18,
            color: theme.fg,
            backgroundColor: "rgba(0,0,0,0.4)",
            borderRadius: 6,
            padding: "18px 24px",
            lineHeight: 1.8,
          }}
        >
          {FILES.map((f, i) => {
            const appearAt = 30 + i * 12;
            const op = interpolate(frame, [appearAt, appearAt + 10], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            return (
              <div key={i} style={{ opacity: op, whiteSpace: "pre" }}>
                {f}
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            gap: 20,
            marginTop: 32,
            fontFamily: theme.mono,
            fontSize: 18,
          }}
        >
          {[
            { label: "CI", value: "passing", color: theme.success, at: 150 },
            { label: "reviews", value: "0 required", color: theme.muted, at: 165 },
            { label: "conflicts", value: "none", color: theme.success, at: 180 },
          ].map((c) => {
            const op = interpolate(frame, [c.at, c.at + 15], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            return (
              <div key={c.label} style={{ opacity: op }}>
                <span style={{ color: theme.muted }}>{c.label}: </span>
                <span style={{ color: c.color }}>{c.value}</span>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
