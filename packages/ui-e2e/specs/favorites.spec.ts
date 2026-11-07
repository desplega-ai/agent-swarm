import { expect, test } from "../fixtures";

type FavoriteIds = { favoriteIds: string[] };

test("starring a page in the list stays on the list and is stored for the picked user", async ({
  page,
  seed,
  swarm,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const pageId = seed!.pages.public.id;
  const favoritesFor = async (userId?: string) => {
    const response = await fetch(`${swarm.apiUrl}/api/favorites?itemType=page`, {
      headers: {
        Authorization: `Bearer ${swarm.apiKey}`,
        ...(userId ? { "X-Swarm-User-Id": userId } : {}),
      },
    });
    return ((await response.json()) as FavoriteIds).favoriteIds;
  };

  await page.goto("/pages");
  const row = page.getByRole("row").filter({ hasText: "e2e public page" });
  await row.getByRole("button", { name: "Add favorite" }).click();

  // The star toggles; it does not open the page.
  await expect(row.getByRole("button", { name: "Remove favorite" })).toBeVisible();
  await expect(page).toHaveURL("/pages");

  // Stored under the dashboard's picked user, not the shared operator set.
  await expect.poll(() => favoritesFor(seed!.user.id)).toContain(pageId);
  expect(await favoritesFor()).not.toContain(pageId);

  // Still starred after a reload.
  await page.reload();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "e2e public page" })
      .getByRole("button", { name: "Remove favorite" }),
  ).toBeVisible();

  // Leave the worker's seeded state as found.
  await page
    .getByRole("row")
    .filter({ hasText: "e2e public page" })
    .getByRole("button", { name: "Remove favorite" })
    .click();
  await expect.poll(() => favoritesFor(seed!.user.id)).not.toContain(pageId);
  await expect(page).toHaveURL("/pages");

  await clean.assertClean();
});

test("starring a sessions group in its title row stays on after a reload", async ({
  page,
  seed,
  swarm,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const { groupKey, groupName } = seed!.sessionChain;
  const keyFavorites = async () => {
    const response = await fetch(`${swarm.apiUrl}/api/favorites?itemType=key`, {
      headers: { Authorization: `Bearer ${swarm.apiKey}`, "X-Swarm-User-Id": seed!.user.id },
    });
    return ((await response.json()) as FavoriteIds).favoriteIds;
  };
  // The title row, not the sidebar row's hover star with the same name.
  const titleRow = () =>
    page.getByRole("heading", { level: 2, name: groupName }).locator("xpath=..");

  await page.goto(`/sessions?view=${groupKey}`);
  await titleRow().getByRole("button", { name: "Star this use case" }).click();
  await expect(titleRow().getByRole("button", { name: "Unstar" })).toBeVisible();
  await expect.poll(keyFavorites).toContain(groupKey);

  await page.reload();
  await expect(titleRow().getByRole("button", { name: "Unstar" })).toBeVisible();

  // Leave the worker's seeded state as found.
  await titleRow().getByRole("button", { name: "Unstar" }).click();
  await expect(titleRow().getByRole("button", { name: "Star this use case" })).toBeVisible();
  await expect.poll(keyFavorites).not.toContain(groupKey);

  await clean.assertClean();
});
