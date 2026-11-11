import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  // Test-level, not file-level: `--shard=i/4` then splits by test count. File-level left
  // overflow.spec.ts (206 s) on one worker. Each worker still has its own API and DB, and
  // `mode: "serial"` describes stay together.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  // One rerun. A pass on it reports as flaky (comment and tracker) and exits 0.
  retries: 1,
  timeout: 60_000,
  grepInvert: process.env.E2E_API_URL ? /@local/ : undefined,
  globalSetup: "./global-setup.ts",
  reporter: process.env.CI
    ? [["blob"], ["./reporter/summary.ts"]]
    : [["list"], ["html", { open: "never" }], ["./reporter/summary.ts"]],
  use: {
    trace: "on-first-retry",
    screenshot: "on",
    video: "off",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // iOS soft-keyboard emulation for the composer Enter-key behavior
      // (`pointer: coarse` under `isMobile`/`hasTouch`), and the sessions v2
      // phone layout (390 px, below the 768 px breakpoint). Scoped to those
      // two specs: every other spec assumes the desktop chrome layout. Both
      // specs skip their desktop tests on this project. Forces Chromium
      // (the device descriptor defaults to WebKit, which the `swarm` fixture
      // doesn't support). Chromium's own mobile/touch emulation is what flips
      // `pointer: coarse`, the same signal a real iOS Safari/Chrome tab reports.
      name: "mobile-iphone",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
      testMatch: /(composer-enter-key|sessions-v2)\.spec\.ts/,
    },
  ],
});
