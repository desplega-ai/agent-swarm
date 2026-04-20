import { AbsoluteFill, Sequence } from "remotion";
import { theme } from "./theme";
import { Scene1Opening } from "./scenes/Scene1Opening";
import { Scene2Scanning } from "./scenes/Scene2Scanning";
import { Scene3Memories } from "./scenes/Scene3Memories";
import { Scene4Profile } from "./scenes/Scene4Profile";
import { Scene5Graph } from "./scenes/Scene5Graph";
import { Scene6Outro } from "./scenes/Scene6Outro";

export const DailyEvolution: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: theme.sans }}>
      <Sequence from={0} durationInFrames={120}>
        <Scene1Opening />
      </Sequence>
      <Sequence from={120} durationInFrames={180}>
        <Scene2Scanning />
      </Sequence>
      <Sequence from={300} durationInFrames={180}>
        <Scene3Memories />
      </Sequence>
      <Sequence from={480} durationInFrames={180}>
        <Scene4Profile />
      </Sequence>
      <Sequence from={660} durationInFrames={180}>
        <Scene5Graph />
      </Sequence>
      <Sequence from={840} durationInFrames={60}>
        <Scene6Outro />
      </Sequence>
    </AbsoluteFill>
  );
};
