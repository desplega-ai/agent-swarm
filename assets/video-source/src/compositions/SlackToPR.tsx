import { AbsoluteFill, Sequence } from "remotion";
import { theme } from "../theme";
import { SceneIntro } from "../scenes/slack-to-pr/SceneIntro";
import { SceneThread } from "../scenes/slack-to-pr/SceneThread";
import { SceneBrainstorm } from "../scenes/slack-to-pr/SceneBrainstorm";
import { SceneSpinUp } from "../scenes/slack-to-pr/SceneSpinUp";
import { SceneRender } from "../scenes/slack-to-pr/SceneRender";
import { ScenePR } from "../scenes/slack-to-pr/ScenePR";
import { SceneOutro } from "../scenes/slack-to-pr/SceneOutro";

// "Honest read" pacing: ScenePR is the payoff — it's the moment the whole
// pipeline lands. Compress setup scenes and let the PR card breathe.
// Total 1350 frames / 45s @ 30fps. No audio here (see DailyEvolution).
export const SlackToPR: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: theme.sans }}>
      <Sequence from={0} durationInFrames={90}>
        <SceneIntro />
      </Sequence>
      <Sequence from={90} durationInFrames={210}>
        <SceneThread />
      </Sequence>
      <Sequence from={300} durationInFrames={180}>
        <SceneBrainstorm />
      </Sequence>
      <Sequence from={480} durationInFrames={180}>
        <SceneSpinUp />
      </Sequence>
      <Sequence from={660} durationInFrames={180}>
        <SceneRender />
      </Sequence>
      <Sequence from={840} durationInFrames={450}>
        <ScenePR />
      </Sequence>
      <Sequence from={1290} durationInFrames={60}>
        <SceneOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
