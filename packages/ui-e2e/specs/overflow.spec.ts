import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import { resolveRoute, routes } from "./routes";

/** A phone, a narrow desktop window, and a laptop. */
const VIEWPORTS = [
  { name: "phone", width: 375, height: 812 },
  { name: "narrow", width: 1024, height: 768 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

/** Page-level horizontal scroll: the document is wider than the window. */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

/**
 * Chart axis labels (`data-axis-label`) whose boxes intersect a sibling label
 * in the same axis, or the axis's "now" marker (`data-axis-now`).
 */
async function overlappingAxisLabels(page: Page) {
  return page.evaluate(() => {
    const hits: string[] = [];
    const axes = new Set<Element>();
    for (const label of Array.from(document.querySelectorAll("[data-axis-label]"))) {
      if (label.parentElement) axes.add(label.parentElement);
    }
    for (const axis of axes) {
      const boxes = Array.from(axis.querySelectorAll(":scope > [data-axis-label], [data-axis-now]"))
        .map((el) => ({ text: el.textContent ?? "", rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!.rect;
          const b = boxes[j]!.rect;
          const apart =
            a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
          if (!apart) hits.push(`${boxes[i]!.text} x ${boxes[j]!.text}`);
        }
      }
    }
    return hits;
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(`no horizontal overflow at ${viewport.width}px`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    for (const route of routes) {
      test(`${viewport.name} ${route.path}`, { tag: ["@overflow"] }, async ({ page, seed }) => {
        test.skip(Boolean(route.needs) && !seed, "remote run without seed");
        test.skip(Boolean(route.skip), route.skip);
        const path = route.needs ? resolveRoute(route, seed!) : route.path;
        test.skip(path === null, "seed has no entity for this route");
        await page.goto(path!);
        await page.waitForLoadState("networkidle");
        await expect(page.locator("main").first()).toBeVisible();
        const { scrollWidth, innerWidth } = await horizontalOverflow(page);
        expect(scrollWidth, `${path} scrolls sideways at ${innerWidth}px`).toBeLessThanOrEqual(
          innerWidth,
        );
        expect(await overlappingAxisLabels(page), `${path} axis labels overlap`).toEqual([]);
      });
    }
  });
}

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
