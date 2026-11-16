import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  // Test-level, not file-level: tests of one file spread over the workers. File-level left
  // overflow.spec.ts (206 s) on one worker. Each worker still has its own API and DB, and
  // `mode: "serial"` describes stay together.
  fullyParallel: true,
  // 3 in CI too: a 4-vCPU runner keeps up, and it cuts the 8 shards from about 2.1 min of tests.
  workers: 3,
  // No reruns: a spec that fails once fails the shard, so a flake shows up red instead of
  // passing as "flaky". Fix or quarantine the spec.
  retries: 0,
  timeout: 60_000,
  grepInvert: process.env.E2E_API_URL ? /@local/ : undefined,
  globalSetup: "./global-setup.ts",
  reporter: process.env.CI
    ? [
        // One file name per shard: the report job downloads every shard's blob into one folder.
        [
          "blob",
          { fileName: `report-${(process.env.UI_E2E_SHARD ?? "1/1").replace("/", "-of-")}.zip` },
        ],
        ["./reporter/summary.ts"],
      ]
    : [["list"], ["html", { open: "never" }], ["./reporter/summary.ts"]],
  use: {
    // No retries, so keep the trace of the failed run itself.
    trace: "retain-on-failure",
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
