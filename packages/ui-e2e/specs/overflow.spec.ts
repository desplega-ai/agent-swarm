import { expect, test } from "../fixtures";
import { horizontalOverflow, overlappingAxisLabels } from "./overflow-checks";

// The per-route checks live in overflow-<viewport>.spec.ts.

test("home activity axes keep labels apart at every width", { tag: ["@overflow"] }, async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  for (const width of [320, 375, 414, 640, 768, 1024, 1280, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ["Density", "Detail"]) {
      const toggle = page.getByRole("radio", { name: view, exact: true });
      if (await toggle.isVisible().catch(() => false)) await toggle.click();
      await page.waitForTimeout(150);
      // Positive control: the seed has recent tasks, so the axis has labels to check.
      await expect(
        page.locator("[data-axis-label]").first(),
        `${view} axis at ${width}px`,
      ).toBeVisible();
      expect(await overlappingAxisLabels(page), `${view} axis at ${width}px`).toEqual([]);
      const { scrollWidth, innerWidth } = await horizontalOverflow(page);
      expect(scrollWidth, `${view} at ${width}px`).toBeLessThanOrEqual(innerWidth);
    }
  }
});

// Before/after evidence for the PR: `UIOV_SHOT_DIR=/tmp/x bun run e2e:ui -- --grep @shots`.
test("home phone screenshots", { tag: ["@shots"] }, async ({ page }) => {
  const dir = process.env.UIOV_SHOT_DIR;
  test.skip(!dir, "set UIOV_SHOT_DIR to capture");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/home-375.png`, fullPage: true });
  const activity = page.locator("section", {
    has: page.getByRole("heading", { name: "Activity" }),
  });
  for (const view of ["Density", "Detail"]) {
    await page.getByRole("radio", { name: view, exact: true }).click();
    await page.waitForTimeout(500);
    await activity.first().screenshot({ path: `${dir}/activity-${view.toLowerCase()}-375.png` });
  }
  const needsYou = page.locator("section", {
    has: page.getByRole("heading", { name: "Needs you" }),
  });
  await needsYou.first().screenshot({ path: `${dir}/needs-you-375.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("radio", { name: "Density", exact: true }).click();
  await page.waitForTimeout(500);
  await activity.first().screenshot({ path: `${dir}/activity-density-1280.png` });
});

test("chart pages phone screenshots", { tag: ["@shots"] }, async ({ page }) => {
  const dir = process.env.UIOV_SHOT_DIR;
  test.skip(!dir, "set UIOV_SHOT_DIR to capture");
  await page.setViewportSize({ width: 375, height: 2400 });
  for (const path of ["/metrics", "/memory", "/usage", "/budgets"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${dir}/page${path.replaceAll("/", "-")}-375.png` });
  }
});
