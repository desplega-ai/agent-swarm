import { expect, test } from "../fixtures";

const TASK_PROMPT = "e2e in-progress task";
const SEEDED_LOG_LINE = "Hello from the e2e seed";

test("tasks list opens the seeded task and its session logs", async ({ page, seed, clean }) => {
  await page.goto("/tasks");

  const row = page.getByRole("row", { name: new RegExp(TASK_PROMPT) });
  await expect(row).toBeVisible();
  await expect(row.getByText("IN PROGRESS")).toBeVisible();

  await row.getByText(TASK_PROMPT).click();
  await expect(page).toHaveURL(`/tasks/${seed.tasks.inProgress}`);

  await expect(page.getByText(TASK_PROMPT).filter({ visible: true })).toBeVisible();
  // The detail page renders both the `lg:hidden` tab layout and the `lg:grid` rail
  // layout, so text assertions filter to the visible copy. At 1440px the rail shows
  // the session logs inline; the "Session Logs" tab only exists below lg.
  await expect(page.getByText(SEEDED_LOG_LINE).filter({ visible: true })).toBeVisible();

  await clean.assertClean();
});

test.describe("below the lg breakpoint", () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test("session logs open from the Session Logs tab", async ({ page, seed, clean }) => {
    await page.goto(`/tasks/${seed.tasks.inProgress}`);

    await expect(page.getByText(TASK_PROMPT).filter({ visible: true })).toBeVisible();
    await page.getByRole("tab", { name: "Session Logs" }).click();
    await expect(page.getByText(SEEDED_LOG_LINE).filter({ visible: true })).toBeVisible();

    await clean.assertClean();
  });
});
