import { expect, test } from "../fixtures";

const TASK_PROMPT = "e2e in-progress task";
const SEEDED_LOG_LINE = "Hello from the e2e seed";

// The task page shows two columns only from 64rem of page width. The chromium
// project's Desktop Chrome device (1280x720) leaves the page narrower than
// that once the sidebar takes its share, so the wide tests pin a wide window.
test.use({ viewport: { width: 1440, height: 900 } });

test("tasks list opens the seeded task and its session logs", async ({ page, seed, clean }) => {
  test.skip(!seed, "remote run without seed");
  await page.goto("/tasks");

  const row = page.getByRole("row", { name: new RegExp(TASK_PROMPT) });
  await expect(row).toBeVisible();
  await expect(row.getByText("IN PROGRESS")).toBeVisible();

  await row.getByText(TASK_PROMPT).click();
  await expect(page).toHaveURL(`/tasks/${seed!.tasks.inProgress}`);

  // The breadcrumb shows the same title, so match the heading role: plain text
  // matches two elements once both have rendered (a strict-mode violation).
  await expect(page.getByRole("heading", { level: 1, name: TASK_PROMPT })).toBeVisible();
  // The detail page renders both the narrow tab layout and the wide two-column
  // layout (switched by the page's own width), so text assertions filter to the
  // visible copy. At 1440px the center column shows the session logs inline; the
  // "Log" tab only shows in the narrow layout.
  await expect(page.getByText(SEEDED_LOG_LINE).filter({ visible: true })).toBeVisible();

  await clean.assertClean();
});

test.describe("below the lg breakpoint", () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test("session logs open from the Log tab", async ({ page, seed, clean }) => {
    test.skip(!seed, "remote run without seed");
    await page.goto(`/tasks/${seed!.tasks.inProgress}`);

    await expect(page.getByRole("heading", { level: 1, name: TASK_PROMPT })).toBeVisible();
    // A running task opens on Log. The click keeps the test valid if the default changes.
    await page.getByRole("tab", { name: "Log", exact: true }).click();
    await expect(page.getByText(SEEDED_LOG_LINE).filter({ visible: true })).toBeVisible();

    await clean.assertClean();
  });
});
