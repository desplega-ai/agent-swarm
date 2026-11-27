import { expect, test } from "../fixtures";
import { resolveRoute, routes } from "./routes";

for (const route of routes) {
  const tag = route.tag ? ["@smoke", route.tag] : ["@smoke"];
  test(`smoke ${route.path}`, { tag }, async ({ page, seed, clean }, testInfo) => {
    test.skip(Boolean(route.needs) && !seed, "remote run without seed");
    test.skip(Boolean(route.skip), route.skip);
    const path = route.needs ? resolveRoute(route, seed!) : route.path;
    test.skip(path === null, "seed has no entity for this route");
    if (route.needs === "page") {
      // networkidle also waits on the iframe's CDN fetches; one stalled fetch held it to the
      // test timeout. The viewer is ready once the embedded page has rendered.
      await page.goto(path!, { waitUntil: "domcontentloaded" });
      await expect(
        page.frameLocator("main iframe").getByRole("heading", { name: "e2e public page" }),
      ).toBeVisible();
    } else {
      await page.goto(path!);
      await page.waitForLoadState("networkidle");
    }
    await expect(page.locator("main").first()).toBeVisible();
    const screenshot = testInfo.outputPath(`${route.name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(route.name, { path: screenshot, contentType: "image/png" });
    await clean.assertClean();
  });
}
