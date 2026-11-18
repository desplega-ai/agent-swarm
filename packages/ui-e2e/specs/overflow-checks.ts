import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import { resolveRoute, routes } from "./routes";

// One spec file per viewport (overflow-<name>.spec.ts) so the duration-balanced shards in
// boot/shard.ts can spread the about 160 route checks over several runners. The shard
// planner packs whole files.

/** A phone, a narrow desktop window, and a laptop. */
export const VIEWPORTS = [
  { name: "phone", width: 375, height: 812 },
  { name: "narrow", width: 1024, height: 768 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

/** Page-level horizontal scroll: the document is wider than the window. */
export async function horizontalOverflow(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

/**
 * Chart axis labels (`data-axis-label`) whose boxes intersect a sibling label
 * in the same axis, or the axis's "now" marker (`data-axis-now`).
 */
export async function overlappingAxisLabels(page: Page) {
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

/**
 * Aborts requests that an embedded frame sends to another origin. `networkidle` also waits
 * on child frames, and the /pages/:id iframe loads its scripts and fonts from public CDNs,
 * so one stalled CDN fetch held the wait until the test timeout. The main frame keeps its
 * own requests (fonts included), so page widths stay as a user sees them.
 */
async function abortCrossOriginFrameRequests(page: Page): Promise<void> {
  await page.route("**/*", (route) => {
    const request = route.request();
    const frame = request.frame();
    if (frame === page.mainFrame() || request.isNavigationRequest()) return route.continue();
    if (new URL(request.url()).origin === new URL(frame.url()).origin) return route.continue();
    return route.abort("blockedbyclient");
  });
}

/** Registers one test per route: the page must not scroll sideways at this viewport. */
export function defineOverflowSuite(name: (typeof VIEWPORTS)[number]["name"]) {
  const viewport = VIEWPORTS.find((candidate) => candidate.name === name)!;
  test.describe(`no horizontal overflow at ${viewport.width}px`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    for (const route of routes) {
      test(`${viewport.name} ${route.path}`, { tag: ["@overflow"] }, async ({ page, seed }) => {
        test.skip(Boolean(route.needs) && !seed, "remote run without seed");
        test.skip(Boolean(route.skip), route.skip);
        const path = route.needs ? resolveRoute(route, seed!) : route.path;
        test.skip(path === null, "seed has no entity for this route");
        await abortCrossOriginFrameRequests(page);
        if (route.needs === "page") {
          // The viewer is ready independently of polling and the iframe's background requests.
          await page.goto(path!, { waitUntil: "domcontentloaded" });
          await expect(
            page.frameLocator("main iframe").getByRole("heading", { name: "e2e public page" }),
          ).toBeVisible();
        } else {
          await page.goto(path!);
          await page.waitForLoadState("networkidle");
        }
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
