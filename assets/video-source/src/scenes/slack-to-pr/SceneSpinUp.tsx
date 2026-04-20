import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { theme } from "../../theme";

const STEPS = [
  { at: 0, text: "$ mkdir -p /workspace/personal/remotion-wireframe" },
  { at: 14, text: "$ npm init -y && npm i remotion react react-dom" },
  { at: 32, text: "▸ scaffold Root.tsx, DailyEvolution.tsx, 6 scenes" },
  { at: 58, text: "$ npx remotion render src/index.ts DailyEvolution out.mp4" },
  { at: 86, text: "✗ libnspr4.so: cannot open shared object file" },
  { at: 104, text: "$ sudo apt-get install -y libnspr4 libnss3 libatk1.0-0 …" },
  { at: 128, text: "$ npx remotion render … out.mp4" },
  { at: 150, text: "✓ rendered 900 frames · 2.6MB" },
];

export const SceneSpinUp: React.FC = () => {
  const frame = useCurrentFrame();
  const headerOp = interpolate(frame, [0, 15], [0, 1], {
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
          marginBottom: 20,
          opacity: headerOp,
        }}
      >
        ▸ worker: Lead · task: build wireframe
      </div>
      <div
        style={{
          fontSize: 56,
          fontWeight: 700,
          color: theme.fg,
          marginBottom: 40,
          opacity: headerOp,
        }}
      >
        Spinning up.
      </div>

      <div
        style={{
          backgroundColor: theme.card,
          border: `1px solid ${theme.border}`,
          borderRadius: 8,
          padding: "32px 40px",
          fontFamily: theme.mono,
          fontSize: 22,
          lineHeight: 1.7,
          color: theme.fg,
          minHeight: 500,
        }}
      >
        {STEPS.map((s, i) => {
          const op = interpolate(frame, [s.at, s.at + 10], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const isError = s.text.startsWith("✗");
          const isSuccess = s.text.startsWith("✓");
          const isComment = s.text.startsWith("▸");
          const color = isError
            ? theme.danger
            : isSuccess
              ? theme.success
              : isComment
                ? theme.muted
                : theme.fg;
          return (
            <div key={i} style={{ opacity: op, color }}>
              {s.text}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
