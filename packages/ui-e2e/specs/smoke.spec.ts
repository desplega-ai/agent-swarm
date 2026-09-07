import { expect, test } from "../fixtures";
import { resolveRoute, routes } from "./routes";

for (const route of routes) {
  const tag = route.tag ? ["@smoke", route.tag] : ["@smoke"];
  test(`smoke ${route.path}`, { tag }, async ({ page, seed, clean }, testInfo) => {
    test.skip(Boolean(route.needs) && !seed, "remote run without seed");
    test.skip(Boolean(route.skip), route.skip);
    await page.goto(route.needs ? resolveRoute(route, seed!) : route.path);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("main").first()).toBeVisible();
    const screenshot = testInfo.outputPath(`${route.name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(route.name, { path: screenshot, contentType: "image/png" });
    await clean.assertClean();
  });
}
