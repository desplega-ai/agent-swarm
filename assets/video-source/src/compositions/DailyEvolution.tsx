import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { theme } from "../theme";
import { Scene1Opening } from "../scenes/daily-evolution/Scene1Opening";
import { Scene2Scanning } from "../scenes/daily-evolution/Scene2Scanning";
import { Scene3Memories } from "../scenes/daily-evolution/Scene3Memories";
import { Scene4Profile } from "../scenes/daily-evolution/Scene4Profile";
import { Scene5Graph } from "../scenes/daily-evolution/Scene5Graph";
import { Scene6Outro } from "../scenes/daily-evolution/Scene6Outro";

// "Honest read" pacing: scene 5 (the memory graph) is the only visual that lands
// instantly for a non-technical viewer, so compress scenes 1–4 and spend ~15s
// on scene 5. Total still 900 frames / 30s @ 30fps.
export const DailyEvolution: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: theme.sans }}>
      <Audio src={staticFile("audio/bed.mp3")} volume={0.5} />

      <Sequence from={0} durationInFrames={60}>
        <Scene1Opening />
      </Sequence>
      <Sequence from={60} durationInFrames={90}>
        <Scene2Scanning />
      </Sequence>
      <Sequence from={150} durationInFrames={120}>
        <Scene3Memories />
      </Sequence>
      <Sequence from={270} durationInFrames={120}>
        <Scene4Profile />
      </Sequence>
      <Sequence from={390} durationInFrames={450}>
        <Scene5Graph />
      </Sequence>
      <Sequence from={840} durationInFrames={60}>
        <Scene6Outro />
      </Sequence>
    </AbsoluteFill>
  );
};
