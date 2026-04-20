import { Composition } from "remotion";
import { DailyEvolution } from "./DailyEvolution";

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
    </>
  );
};
