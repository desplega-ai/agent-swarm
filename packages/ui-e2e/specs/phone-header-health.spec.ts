import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";

// Swarm health on the phone bar (below md). `/status` is rewritten per test so
// each health state is deterministic; every other request reaches the seeded API.
test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

async function forceHealth(page: Page, apiUrl: string, health: "ok" | "broken") {
  await page.route(`${apiUrl}/status`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, health } });
  });
}

test("a healthy phone reaches the health details and Stuck? Ask us from the menu", async ({
  page,
  swarm,
}, testInfo) => {
  await forceHealth(page, swarm.apiUrl, "ok");
  await page.goto("/tasks");
  // Healthy: the bar keeps no health control of its own.
  await expect(page.getByRole("button", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Swarm health/ })).toHaveCount(0);

  await page.getByRole("button", { name: /^Menu/ }).tap();
  await page.getByRole("button", { name: "Swarm health: All systems go" }).tap();
  const sheet = page.getByRole("dialog", { name: "Swarm health" });
  await expect(sheet.getByText("All checks pass.")).toBeVisible();
  const ask = sheet.getByRole("button", { name: "Stuck? Ask us" });
  await expect(ask).toBeVisible();
  await ask.tap();
  await expect(ask).toHaveAttribute("aria-expanded", "true");

  await page.waitForTimeout(300);
  const screenshot = testInfo.outputPath("phone-health-sheet.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("phone-health-sheet", { path: screenshot, contentType: "image/png" });
});

test("an unhealthy swarm keeps a 44px health button in the phone bar", async ({ page, swarm }) => {
  await forceHealth(page, swarm.apiUrl, "broken");
  await page.goto("/tasks");
  const badge = page.getByRole("button", { name: "Swarm health: Setup required" });
  await expect(badge).toBeVisible();
  const box = await badge.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await badge.tap();
  await expect(page.getByRole("dialog", { name: "Swarm health" })).toBeVisible();
});

test("an unreachable API shows a disconnected dot in the phone bar", async ({ page, swarm }) => {
  await page.route(`${swarm.apiUrl}/status`, (route) => route.abort("connectionrefused"));
  await page.route(`${swarm.apiUrl}/health`, (route) => route.abort("connectionrefused"));
  await page.goto("/tasks");
  const dot = page.getByRole("button", { name: "Swarm health: Disconnected" });
  // `/health` retries twice, a second apart, before it reports the failure.
  await expect(dot).toBeVisible({ timeout: 15_000 });
  const box = await dot.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await dot.tap();
  await expect(page.getByText(/^Connection failed: /)).toBeVisible();
});

test("an API that drops after a healthy load turns the phone bar's dot red", async ({
  page,
  swarm,
}) => {
  await forceHealth(page, swarm.apiUrl, "ok");
  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Swarm health/ })).toHaveCount(0);

  // The healthy `/status` snapshot stays cached; the `/health` poll (10 s)
  // and its two retries are what notice the outage.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route(`${swarm.apiUrl}/status`, (route) => route.abort("connectionrefused"));
  await page.route(`${swarm.apiUrl}/health`, (route) => route.abort("connectionrefused"));
  await expect(page.getByRole("button", { name: "Swarm health: Disconnected" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: /^Menu/ }).tap();
  // The menu's health row says the same, and no longer opens stale details.
  await expect(page.getByRole("dialog").getByText("Disconnected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Swarm health: All systems go" })).toHaveCount(0);
});
