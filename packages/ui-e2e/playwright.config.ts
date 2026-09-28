import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 2 : 1,
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
      // (`pointer: coarse` under `isMobile`/`hasTouch`). Scoped to that one
      // spec — every other spec assumes the desktop chrome layout. Forces
      // Chromium (the device descriptor defaults to WebKit, which the
      // `swarm` fixture doesn't support) — Chromium's own mobile/touch
      // emulation is what flips `pointer: coarse`, the same signal a real
      // iOS Safari/Chrome tab reports.
      name: "mobile-iphone",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
      testMatch: /composer-enter-key\.spec\.ts/,
    },
  ],
});
