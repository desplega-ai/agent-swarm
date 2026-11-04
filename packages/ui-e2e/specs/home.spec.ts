import { expect, test } from "../fixtures";

test("home renders", async ({ page, clean }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await clean.assertClean();
});

test("home shows the post-onboarding checklist defaults", async ({ page, clean }) => {
  await page.goto("/");
  const card = page.getByRole("region", { name: "Get the swarm working" });
  await expect(card).toBeVisible();
  for (const label of [
    "Connect a chat channel",
    "Connect work tools",
    "Plan your first use case",
  ]) {
    await expect(card.getByText(label, { exact: true })).toBeVisible();
  }
  await clean.assertClean();
});
