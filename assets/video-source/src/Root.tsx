import { Composition } from "remotion";
import "./fonts";
import { DailyEvolution } from "./compositions/DailyEvolution";
import { SlackToPR } from "./compositions/SlackToPR";

// Each composition is a standalone video. Add new ones here — they become
// render targets via `npx remotion render src/index.ts <id> out/<name>.mp4`.
export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="DailyEvolution"
        component={DailyEvolution}
        durationInFrames={900}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="SlackToPR"
        component={SlackToPR}
        durationInFrames={1350}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
