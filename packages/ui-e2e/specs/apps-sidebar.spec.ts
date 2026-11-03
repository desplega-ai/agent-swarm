import { expect, test } from "../fixtures";

const apps = [
  { id: "22222222-2222-4222-8222-222222222222", name: "Alpha workspace" },
  { id: "33333333-3333-4333-8333-333333333333", name: "Zebra workspace" },
].map((app) => ({
  ...app,
  description: "Sidebar flow fixture",
  createdAt: "2026-11-03T12:00:00Z",
  updatedAt: "2026-11-03T12:00:00Z",
}));

test("@local Apps sidebar navigation, selection, persistence and hidden fallback", async ({
  page,
  clean,
}) => {
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps } }));
  await page.route("**/api/apps/*", (route) => {
    const app = apps.find((item) => new URL(route.request().url()).pathname.endsWith(item.id));
    if (!app) return route.fallback();
    return route.fulfill({
      json: {
        app: {
          ...app,
          definition: {
            schemaVersion: 1,
            models: {},
            queries: {},
            actions: {},
            defaultPage: "home",
            pages: {
              home: {
                title: "Overview",
                root: "heading",
                elements: {
                  heading: {
                    type: "Heading",
                    props: { text: app.name, level: "h1" },
                    children: [],
                  },
                },
              },
            },
          },
        },
        values: {},
        schema: {},
      },
    });
  });
  await page.route("**/api/apps/*/user-config", (route) =>
    route.fulfill({ json: { values: {}, schema: {} } }),
  );
  await page.goto("/tasks");
  const sidebar = page.locator('[data-slot="sidebar"]');
  const catalog = sidebar.getByRole("link", { name: "All apps", exact: true });
  await expect(sidebar.getByRole("link", { name: "Apps", exact: true })).toHaveCount(0);
  await catalog.click();
  await expect(page).toHaveURL(/\/apps$/);
  await expect(sidebar.getByRole("link", { name: /workspace$/ })).toHaveText([
    "Alpha workspace",
    "Zebra workspace",
  ]);

  const gear = page.getByRole("button", { name: "Configure apps in sidebar" });
  await gear.click();
  const panel = page.getByRole("dialog", { name: "Apps in sidebar" });
  const mode = panel.getByRole("combobox", { name: "Show apps" });
  await mode.click();
  await page.getByRole("option", { name: "Selected apps", exact: true }).click();
  await panel.getByRole("checkbox", { name: "Alpha workspace" }).check();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sidebar.getByRole("link", { name: "Alpha workspace", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Zebra workspace", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(sidebar.getByRole("link", { name: "Zebra workspace", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "Alpha workspace", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await sidebar.getByRole("link", { name: "Alpha workspace", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${apps[0].id}$`));
  await expect(page.getByRole("heading", { name: "Alpha workspace", exact: true })).toBeVisible();
  await catalog.click();
  await expect(page).toHaveURL(/\/apps$/);

  await gear.click();
  await mode.click();
  await page.getByRole("option", { name: "Hide section", exact: true }).click();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(catalog).toHaveCount(0);
  const original = sidebar.getByRole("link", { name: "Apps", exact: true });
  await expect(original).toBeVisible();
  await page.goto("/tasks");
  await original.click();
  await expect(page).toHaveURL(/\/apps$/);
  await gear.click();
  await mode.click();
  await page.getByRole("option", { name: "All apps", exact: true }).click();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(original).toHaveCount(0);
  await expect(catalog).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /workspace$/ })).toHaveCount(2);
  await clean.assertClean();
});
