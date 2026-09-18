import { AbsoluteFill, Sequence } from "remotion";
import { theme } from "../theme";
import { SceneGraph } from "../scenes/jev-shortest-path/SceneGraph";
import { SceneJevCall } from "../scenes/jev-shortest-path/SceneJevCall";
import { ScenePath } from "../scenes/jev-shortest-path/ScenePath";
import { SceneCompare } from "../scenes/jev-shortest-path/SceneCompare";
import { SceneScoreboard } from "../scenes/jev-shortest-path/SceneScoreboard";
import { SceneOutro } from "../scenes/jev-shortest-path/SceneOutro";

// Square 1080x1080, 25s @ 30fps = 750 frames. Hard cuts between beats — no
// crossfade — per Taras's rejection of the "robotic" screen-recorded version.
// Silent: music is a brand call Taras hasn't made yet.
export const JevShortestPath: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: theme.sans }}>
      <Sequence from={0} durationInFrames={90}>
        <SceneGraph />
      </Sequence>
      <Sequence from={90} durationInFrames={120}>
        <SceneJevCall />
      </Sequence>
      <Sequence from={210} durationInFrames={120}>
        <ScenePath />
      </Sequence>
      <Sequence from={330} durationInFrames={150}>
        <SceneCompare />
      </Sequence>
      <Sequence from={480} durationInFrames={210}>
        <SceneScoreboard />
      </Sequence>
      <Sequence from={690} durationInFrames={60}>
        <SceneOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
