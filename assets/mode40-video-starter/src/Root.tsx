import { Composition } from "remotion";
import "./fonts";
import { BrandCard } from "./compositions/BrandCard";

// Each Composition is a standalone video. Add your own here — the `id` becomes
// the render target: `npx remotion render src/index.ts <id> out/<name>.mp4`.
// BrandCard is a minimal, on-brand example wiring up every token in theme.ts;
// copy it as a starting point rather than building a composition from scratch.
export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="BrandCard"
        component={BrandCard}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          eyebrow: "MODE40",
          title: "Autonomous operations, made legible.",
          body: "A reusable, on-brand starting point for product video.",
        }}
      />
    </>
  );
};
