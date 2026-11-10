#!/usr/bin/env bun
/**
 * Asserts that the global `playwright` pin in Dockerfile.worker equals the
 * `@playwright/test` pin in packages/ui-e2e/package.json. The worker image runs
 * `playwright install chromium` into PLAYWRIGHT_BROWSERS_PATH=/opt/playwright,
 * and each Playwright release expects its own browser revision there. A drift
 * makes `bun run e2e:ui` fail every spec on workers ("Executable doesn't exist").
 *
 * Usage: bun scripts/check-playwright-version.ts
 * Exit 1 with a report when the pins differ or either pin is missing.
 */

export const DOCKERFILE = "Dockerfile.worker";
export const UI_E2E_PACKAGE_JSON = "packages/ui-e2e/package.json";

const DOCKERFILE_PIN = /^\s*"playwright":\s*"([^"]+)"/gm;

export function checkPlaywrightPins(dockerfileText: string, uiE2ePackageJson: unknown): string[] {
  const pkg = uiE2ePackageJson as { devDependencies?: Record<string, unknown> };
  const expected = pkg.devDependencies?.["@playwright/test"];
  if (typeof expected !== "string") {
    return [`${UI_E2E_PACKAGE_JSON}: no devDependencies["@playwright/test"] pin found`];
  }
  const found = [...dockerfileText.matchAll(DOCKERFILE_PIN)].map((match) => match[1]);
  if (found.length === 0) return [`${DOCKERFILE}: no "playwright" global-deps pin found`];
  return found
    .filter((version) => version !== expected)
    .map(
      (version) =>
        `${DOCKERFILE}: global playwright is ${version}, ${UI_E2E_PACKAGE_JSON} @playwright/test is ${expected}`,
    );
}

if (import.meta.main) {
  const problems = checkPlaywrightPins(
    await Bun.file(DOCKERFILE).text(),
    await Bun.file(UI_E2E_PACKAGE_JSON).json(),
  );
  if (problems.length > 0) {
    console.error(
      [
        "Playwright pins are out of sync:",
        ...problems.map((problem) => `  - ${problem}`),
        "Set both to the same exact version so /opt/playwright holds the browser revision the UI suite launches.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`Dockerfile.worker playwright matches ${UI_E2E_PACKAGE_JSON} @playwright/test`);
}
