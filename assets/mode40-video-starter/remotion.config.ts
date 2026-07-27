import { Config } from "@remotion/cli/config";

// JPEG frames keep intermediate size down; concurrency 1 is the safe default
// inside a constrained worker container. Bump concurrency locally if you have
// the cores. `angle` is the most reliable GL renderer in headless Linux.
Config.setVideoImageFormat("jpeg");
Config.setConcurrency(1);
Config.setChromiumOpenGlRenderer("angle");

// Optional: reuse a browser already baked into the worker image instead of
// letting Remotion download its own Chrome Headless Shell on first render.
// The worker image ships Playwright's Chromium at $PLAYWRIGHT_BROWSERS_PATH
// (/opt/playwright). Point REMOTION_BROWSER_EXECUTABLE at that binary — or any
// Chrome/Chromium — to skip the download. Left unset, Remotion manages its own.
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
if (browserExecutable) {
  Config.setBrowserExecutable(browserExecutable);
}
