import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { theme } from "../theme";
import { SceneIntro } from "../scenes/slack-to-pr/SceneIntro";
import { SceneThread } from "../scenes/slack-to-pr/SceneThread";
import { SceneBrainstorm } from "../scenes/slack-to-pr/SceneBrainstorm";
import { SceneSpinUp } from "../scenes/slack-to-pr/SceneSpinUp";
import { SceneRender } from "../scenes/slack-to-pr/SceneRender";
import { ScenePR } from "../scenes/slack-to-pr/ScenePR";
import { SceneOutro } from "../scenes/slack-to-pr/SceneOutro";

// Dramatizes the Slack thread → PR #350 pipeline. Stubbed with placeholder
// avatars/timestamps; swap `props` wiring to feed real transcripts later.
export const SlackToPR: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: theme.sans }}>
      <Audio src={staticFile("audio/bed.mp3")} volume={0.3} />

      <Sequence from={0} durationInFrames={120}>
        <SceneIntro />
      </Sequence>
      <Sequence from={120} durationInFrames={240}>
        <SceneThread />
      </Sequence>
      <Sequence from={360} durationInFrames={210}>
        <SceneBrainstorm />
      </Sequence>
      <Sequence from={570} durationInFrames={210}>
        <SceneSpinUp />
      </Sequence>
      <Sequence from={780} durationInFrames={210}>
        <SceneRender />
      </Sequence>
      <Sequence from={990} durationInFrames={270}>
        <ScenePR />
      </Sequence>
      <Sequence from={1260} durationInFrames={90}>
        <SceneOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
