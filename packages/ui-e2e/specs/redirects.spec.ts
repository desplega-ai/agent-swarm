import { expect, test } from "../fixtures";

/** Old dashboard URLs and where they land now: the query and the hash survive. */
const REDIRECTS: Array<[string, string]> = [
  ["/connections?tab=oauth-apps&search=gh", "/integrations/tools?tab=oauth-apps&search=gh"],
  ["/connections?kind=mcp", "/integrations/tools?tab=connections&kind=mcp"],
  ["/connections?tab=playground", "/settings/connection-playground"],
  ["/connections?tab=bindings", "/settings/fetch-credentials"],
  ["/settings/integrations/slack?search=x", "/integrations/slack?search=x"],
  ["/settings/integrations?category=llm", "/integrations/ai"],
  ["/settings/integrations?category=comm", "/integrations/channels"],
  [
    "/mcp-servers?new=1&name=foo&url=https%3A%2F%2Fx",
    "/integrations/tools?tab=mcp&new=1&name=foo&url=https%3A%2F%2Fx",
  ],
  ["/mcp-servers/m1?oauth=success#top", "/integrations/tools/mcp-servers/m1?oauth=success#top"],
  ["/settings/api-keys", "/integrations/ai"],
  ["/integrations", "/integrations/tools"],
];

for (const [from, to] of REDIRECTS) {
  test(`redirect ${from}`, { tag: ["@smoke"] }, async ({ page }) => {
    await page.goto(from);
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}${url.hash}`;
      })
      .toBe(to);
  });
}

test("sidebar groups: BUILD starts collapsed, AUTOMATE holds the jobs", {
  tag: ["@smoke"],
}, async ({ page, clean }) => {
  await page.goto("/");
  const sidebar = page.locator('[data-slot="sidebar-container"]');
  for (const label of ["WORK", "AUTOMATE", "CONNECT", "BUILD"]) {
    await expect(sidebar.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await expect(sidebar.getByRole("button", { name: "BUILD", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(sidebar.getByRole("link", { name: "Agents", exact: true })).toBeHidden();

  // The AUTOMATE section lists Schedules then Workflows.
  const automate = sidebar
    .getByRole("button", { name: "AUTOMATE", exact: true })
    .locator("xpath=..");
  await expect(automate.getByRole("link")).toHaveText(["Schedules", "Workflows"]);
  for (const name of ["Channels", "Tools", "AI providers"]) {
    await expect(sidebar.getByRole("link", { name, exact: true })).toBeVisible();
  }

  await sidebar.getByRole("button", { name: "BUILD", exact: true }).click();
  await expect(sidebar.getByRole("link", { name: "Agents", exact: true })).toBeVisible();
  await clean.assertClean();
});

test("Settings flyout lists People, Templates and Secrets", { tag: ["@smoke"] }, async ({
  page,
  clean,
}) => {
  await page.goto("/");
  await page
    .locator('[data-slot="sidebar-container"]')
    .getByRole("link", { name: "Settings", exact: true })
    .hover();
  const flyout = page.locator('[data-slot="popover-content"]');
  await expect(flyout.getByText("Advanced", { exact: true })).toBeVisible();
  // People carries the users count, so its name starts with "People".
  await expect(flyout.getByRole("link", { name: /^People/ })).toBeVisible();
  for (const name of ["Servers", "Secrets", "Templates", "Fetch credentials"]) {
    await expect(flyout.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(flyout.getByRole("link", { name: "Provider keys" })).toHaveCount(0);
  await clean.assertClean();
});
