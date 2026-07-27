import { loadFont as loadIBMPlexSans } from "@remotion/google-fonts/IBMPlexSans";
import { loadFont as loadIBMPlexMono } from "@remotion/google-fonts/IBMPlexMono";

// Remotion's Google Fonts loader — safe to call at module level. Weights match
// the mode40 Canon type rules: Sans Light (300) titles, Regular (400) body,
// Medium (500) emphasis; Mono SemiBold (600) eyebrows.
loadIBMPlexSans("normal", {
  weights: ["300", "400", "500"],
  subsets: ["latin"],
});

loadIBMPlexMono("normal", {
  weights: ["600"],
  subsets: ["latin"],
});
