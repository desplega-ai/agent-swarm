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
  ],
});
