import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadSpaceMono } from "@remotion/google-fonts/SpaceMono";

// Remotion's Google Fonts loader — safe to call at module level. Weights used:
// 400 (body), 500 (emphasis), 600/700 (headings).
loadSpaceGrotesk("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

loadSpaceMono("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});
