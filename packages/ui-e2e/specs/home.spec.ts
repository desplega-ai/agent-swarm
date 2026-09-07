import { expect, test } from "../fixtures";

test("home renders", async ({ page, clean }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Tasks", exact: true })).toBeVisible();
  await clean.assertClean();
});
