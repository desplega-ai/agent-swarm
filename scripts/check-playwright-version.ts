#!/usr/bin/env bun
/**
 * Keep the worker package and UI E2E container on the test package's Playwright
 * version. Each release expects its own browser revision; a drift makes every
 * spec fail with "Executable doesn't exist".
 *
 * Usage: bun scripts/check-playwright-version.ts
 * Exit 1 with a report when the pins differ or either pin is missing.
 */

export const DOCKERFILE = "Dockerfile.worker";
export const UI_E2E_PACKAGE_JSON = "packages/ui-e2e/package.json";
export const UI_E2E_WORKFLOW = ".github/workflows/ui-e2e.yml";

const DOCKERFILE_PIN = /^\s*"playwright":\s*"([^"]+)"/gm;
const UI_E2E_IMAGE_PIN =
  /image:\s*mcr\.microsoft\.com\/playwright:v([^\s@]+)-noble(?:@sha256:[a-f0-9]+)?/g;

export function checkPlaywrightPins(
  dockerfileText: string,
  uiE2ePackageJson: unknown,
  workflowText: string,
): string[] {
  const pkg = uiE2ePackageJson as { devDependencies?: Record<string, unknown> };
  const expected = pkg.devDependencies?.["@playwright/test"];
  if (typeof expected !== "string") {
    return [`${UI_E2E_PACKAGE_JSON}: no devDependencies["@playwright/test"] pin found`];
  }
  const found = [...dockerfileText.matchAll(DOCKERFILE_PIN)].map((match) => match[1]);
  if (found.length === 0) return [`${DOCKERFILE}: no "playwright" global-deps pin found`];
  const problems = found
    .filter((version) => version !== expected)
    .map(
      (version) =>
        `${DOCKERFILE}: global playwright is ${version}, ${UI_E2E_PACKAGE_JSON} @playwright/test is ${expected}`,
    );
  const images = [...workflowText.matchAll(UI_E2E_IMAGE_PIN)].map((match) => match[1]);
  if (images.length === 0) {
    problems.push(`${UI_E2E_WORKFLOW}: no Playwright container image pin found`);
  }
  for (const version of images) {
    if (version !== expected) {
      problems.push(
        `${UI_E2E_WORKFLOW}: image playwright is ${version}, ${UI_E2E_PACKAGE_JSON} @playwright/test is ${expected}`,
      );
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkPlaywrightPins(
    await Bun.file(DOCKERFILE).text(),
    await Bun.file(UI_E2E_PACKAGE_JSON).json(),
    await Bun.file(UI_E2E_WORKFLOW).text(),
  );
  if (problems.length > 0) {
    console.error(
      [
        "Playwright pins are out of sync:",
        ...problems.map((problem) => `  - ${problem}`),
        "Set all pins to the same exact version so the worker and CI image contain the browser revision the UI suite launches.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`Worker and UI E2E image match ${UI_E2E_PACKAGE_JSON} @playwright/test`);
}
