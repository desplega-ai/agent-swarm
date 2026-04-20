import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

type Msg = {
  author: "user" | "agent";
  name: string;
  time: string;
  body: string;
  appearAt: number;
};

const MSGS: Msg[] = [
  {
    author: "user",
    name: "Taras",
    time: "14:02",
    body: "hey, im thinking to change the video in the agent-swarm repo, let's brainstorm some ideas for it",
    appearAt: 0,
  },
  {
    author: "agent",
    name: "Lead",
    time: "14:02",
    body: "yo — quick brainstorm. the real q is _what feeling do we want on first load of the README_. a few angles: pipeline flex, dashboard POV, agents arguing…",
    appearAt: 50,
  },
  {
    author: "user",
    name: "Taras",
    time: "14:05",
    body: "curious, could you do a wireframe draft of C using remotion.dev?",
    appearAt: 130,
  },
  {
    author: "agent",
    name: "Lead",
    time: "14:05",
    body: "yessir — spinning up a Remotion project now. 6 scenes, 30s, low-fi wireframe. ~5-10min.",
    appearAt: 150,
  },
];

export const SceneThread: React.FC = () => {
  const frame = useCurrentFrame();
  const headerOp = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ padding: 96, justifyContent: "flex-start" }}>
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 20,
          color: theme.muted,
          textTransform: "uppercase",
          letterSpacing: 3,
          marginBottom: 12,
          opacity: headerOp,
        }}
      >
        # swarm-dev-2
      </div>
      <div
        style={{
          fontSize: 44,
          fontWeight: 600,
          color: theme.fg,
          marginBottom: 40,
          opacity: headerOp,
        }}
      >
        change the video in the agent-swarm repo
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {MSGS.map((m, i) => {
          const opacity = interpolate(
            frame,
            [m.appearAt, m.appearAt + 18],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          const y = interpolate(
            frame,
            [m.appearAt, m.appearAt + 18],
            [20, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          const isAgent = m.author === "agent";
          return (
            <div
              key={i}
              style={{
                opacity,
                transform: `translateY(${y}px)`,
                display: "flex",
                gap: 20,
                alignItems: "flex-start",
              }}
            >
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 8,
                  backgroundColor: isAgent ? theme.accent : theme.card,
                  border: `1px solid ${theme.border}`,
                  color: isAgent ? theme.accentFg : theme.fg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: theme.mono,
                  fontSize: 20,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {m.name[0]}
              </div>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "baseline",
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: theme.fg,
                    }}
                  >
                    {m.name}
                  </span>
                  {isAgent && (
                    <span
                      style={{
                        fontFamily: theme.mono,
                        fontSize: 14,
                        color: theme.accent,
                        padding: "2px 8px",
                        border: `1px solid ${theme.accentDim}`,
                        borderRadius: 4,
                        textTransform: "uppercase",
                        letterSpacing: 1.5,
                      }}
                    >
                      agent
                    </span>
                  )}
                  <span
                    style={{
                      fontFamily: theme.mono,
                      fontSize: 16,
                      color: theme.mutedDim,
                    }}
                  >
                    {m.time}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 24,
                    color: theme.fg,
                    lineHeight: 1.5,
                    maxWidth: 1400,
                  }}
                >
                  {m.body}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
