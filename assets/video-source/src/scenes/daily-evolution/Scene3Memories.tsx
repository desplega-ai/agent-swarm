import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

const MEMORIES = [
  {
    kind: "feedback",
    title: "Don't mock the DB in integration tests",
    why: "prod migration silently diverged from mocks",
  },
  {
    kind: "pattern",
    title: "bun test beats npm test in this repo",
    why: "Bun runtime native, ~12x faster",
  },
  {
    kind: "project",
    title: "Linear DES-140 now blocks discoverability rollout",
    why: "flagged by Ez during retro",
  },
  {
    kind: "reference",
    title: "Grafana api-latency = oncall pager board",
    why: "check before touching request path",
  },
];

const KIND_COLOR: Record<string, string> = {
  feedback: "#f2a93b",
  pattern: "#6ed5ff",
  project: "#b09cff",
  reference: "#8ee58e",
};

export const Scene3Memories: React.FC = () => {
  const frame = useCurrentFrame();
  const titleOpacity = interpolate(frame, [0, 18], [0, 1], {
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
        ▸ memories.curated += 4
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
        New memories indexed.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {MEMORIES.map((m, i) => {
          const appearAt = 20 + i * 20;
          const y = interpolate(frame, [appearAt, appearAt + 18], [24, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const opacity = interpolate(
            frame,
            [appearAt, appearAt + 18],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          return (
            <div
              key={m.title}
              style={{
                opacity,
                transform: `translateY(${y}px)`,
                padding: "22px 28px",
                border: `1px solid ${theme.border}`,
                borderLeft: `3px solid ${KIND_COLOR[m.kind]}`,
                borderRadius: 4,
                fontFamily: theme.sans,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div
                style={{
                  fontFamily: theme.mono,
                  fontSize: 16,
                  color: KIND_COLOR[m.kind],
                  textTransform: "uppercase",
                  letterSpacing: 2,
                }}
              >
                {m.kind}
              </div>
              <div style={{ fontSize: 30, color: theme.fg, fontWeight: 500 }}>
                {m.title}
              </div>
              <div
                style={{
                  fontSize: 20,
                  color: theme.muted,
                  fontFamily: theme.mono,
                }}
              >
                why: {m.why}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
