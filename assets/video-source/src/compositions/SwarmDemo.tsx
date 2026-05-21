import { AbsoluteFill, Sequence, staticFile } from "remotion";
import { theme } from "../theme";
import { SceneIntro } from "../scenes/swarm-demo/SceneIntro";
import { SceneDemo } from "../scenes/swarm-demo/SceneDemo";
import { SceneOutro } from "../scenes/swarm-demo/SceneOutro";
import type { CursorTrack } from "../cursor-track";

// Load the cursor-track fixture.  When running a real recording pipeline:
//   1. record-e2e.ts captures real cursor events via `agent-browser get box` + `mouse move`
//   2. It emits cursor-track.json alongside the beat clip
//   3. Drop the generated file here as cursor-track.json and import it instead
//
// The sample-cursor-track.json covers a 1920×1080 light-mode recording (22.5s).
import sampleCursorTrack from "../fixtures/sample-cursor-track.json";

// 30s @ 30fps = 900 frames.
// Structure:
//   0-90    (0-3s)    Intro — logo.png + "Agent Swarm" wordmark in Space Grotesk
//   90-765  (3-25.5s) E2E demo footage + real cursor from cursor-track.json
//   765-900 (25.5-30s) Outro — wordmark + agent-swarm.dev
//
// Music: disabled by default (Researcher gathering candidates separately).
// Add: <Audio src={staticFile("audio/bed.mp3")} volume={0.12} /> once music is picked.
export const SwarmDemo: React.FC = () => {
  const cursorTrack = sampleCursorTrack as CursorTrack;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: theme.sans }}>
      <Sequence from={0} durationInFrames={90}>
        <SceneIntro />
      </Sequence>

      <Sequence from={90} durationInFrames={675}>
        <SceneDemo cursorTrack={cursorTrack} />
      </Sequence>

      <Sequence from={765} durationInFrames={135}>
        <SceneOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
