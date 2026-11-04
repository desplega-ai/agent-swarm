import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures";

/**
 * The use-case Overview tab (step-10, `apps/ui/src/components/sessions-v2/overview/`).
 * A group with a schedule under its key opens on a pinned Overview tab next to its
 * list tab. A plain thread group (no schedule, no files) opens on its list, as before.
 *
 * Files is off in this suite (no agent-fs), so a schedule is what qualifies a group.
 * Each test makes its own group key, so a worker's API can run the spec more than once.
 */

test.describe("sessions overview", () => {
  test.beforeEach(({ seed, isMobile }) => {
    test.skip(!seed, "remote run without seed");
    test.skip(isMobile, "desktop tab strip");
  });

  test("a use-case group opens on its pinned overview; Run now adds a run to the list", async ({
    page,
    api,
    seed,
    clean,
  }) => {
    const slug = `e2e-usecase-${randomUUID().slice(0, 8)}`;
    const groupKey = `shared/${slug}/`;
    await api.post("/api/tasks", {
      task: `e2e overview planning ${slug}`,
      key: groupKey,
      source: "ui",
      requestedByUserId: seed!.user.id,
    });
    await api.post("/api/schedules", {
      key: groupKey,
      name: `e2e scan ${slug}`,
      cronExpression: "0 9 * * 1,4",
      taskTemplate: "e2e overview scan",
    });
    await api.post("/api/schedules", {
      key: groupKey,
      name: `e2e digest ${slug}`,
      cronExpression: "0 16 * * 5",
      taskTemplate: "e2e overview digest",
      enabled: false,
    });

    await page.goto(`/sessions?view=${groupKey}`);
    const tabs = page.getByRole("tablist", { name: "Tabs" });
    const overview = tabs.getByRole("tab", { name: "Overview" });
    await expect(overview).toHaveAttribute("aria-selected", "true");
    // Pinned: no close button on the Overview, one on the list tab.
    await expect(overview.getByRole("button", { name: /^Close tab/ })).toHaveCount(0);
    const listTab = tabs.getByRole("tab", { name: slug });
    await expect(listTab.getByRole("button", { name: `Close tab ${slug}` })).toHaveCount(1);

    const schedules = page.getByRole("list", { name: "Schedules in this group" });
    await expect(schedules.getByText(`e2e scan ${slug}`)).toBeVisible();
    await expect(schedules.getByText(`e2e digest ${slug}`)).toBeVisible();
    await expect(page.getByText("1 enabled · 1 paused")).toBeVisible();

    await page
      .getByRole("region", { name: "Next run" })
      .getByRole("button", { name: "Run now" })
      .click();
    await expect(page.getByText(`Started a run of e2e scan ${slug}.`)).toBeVisible();

    await listTab.click();
    await expect(page).toHaveURL(/tab=list/);
    await expect(page.getByRole("tabpanel").getByText("e2e overview scan")).toBeVisible({
      timeout: 15_000,
    });

    await clean.assertClean();
  });

  test("a plain thread group opens on its list with no overview tab", async ({
    page,
    api,
    seed,
    clean,
  }) => {
    const slug = `e2e-thread-${randomUUID().slice(0, 8)}`;
    await api.post("/api/tasks", {
      task: `e2e plain thread ${slug}`,
      key: `shared/${slug}/`,
      source: "ui",
      requestedByUserId: seed!.user.id,
    });

    await page.goto(`/sessions?view=shared/${slug}/`);
    const tabs = page.getByRole("tablist", { name: "Tabs" });
    await expect(tabs.getByRole("tab", { name: slug })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel").getByText(`e2e plain thread ${slug}`)).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveCount(0);

    await clean.assertClean();
  });
});
