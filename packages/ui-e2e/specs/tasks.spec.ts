import { expect, test } from "../fixtures";

const TASK_PROMPT = "e2e in-progress task";
const SEEDED_LOG_LINE = "Hello from the e2e seed";

// The task page shows two columns from 60rem of page width. The chromium
// project's Desktop Chrome device (1280x720) leaves 976 px once the sidebar
// takes its share, just over that. The wide tests pin a wide window, so they
// do not depend on that margin.
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
  // visible copy. At 1440px the center column shows the transcript inline; the
  // "Transcript" tab only shows in the narrow layout.
  await expect(page.getByText(SEEDED_LOG_LINE).filter({ visible: true })).toBeVisible();

  await clean.assertClean();
});

test.describe("below the 60rem page-width switch (tabs layout)", () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test("the transcript opens from the Transcript tab", async ({ page, seed, clean }) => {
    test.skip(!seed, "remote run without seed");
    await page.goto(`/tasks/${seed!.tasks.inProgress}`);

    await expect(page.getByRole("heading", { level: 1, name: TASK_PROMPT })).toBeVisible();
    // Every task opens on Transcript.
    await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByText(SEEDED_LOG_LINE).filter({ visible: true })).toBeVisible();

    await clean.assertClean();
  });
});

// The transcript is the first tab for every status, at a narrow window and at
// a desktop window whose expanded sidebar (16rem) leaves the page under 60rem.
for (const width of [900, 1200]) {
  test.describe(`a ${width}px window opens every task on its transcript`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const status of ["completed", "pendingLead"] as const) {
      test(`${status} task`, async ({ page, seed, clean }) => {
        test.skip(!seed, "remote run without seed");
        await page.goto(`/tasks/${seed!.tasks[status]}`);

        const tab = page.getByRole("tab", { name: "Transcript", exact: true });
        await expect(tab).toBeVisible();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tab", { name: "Details", exact: true })).toHaveAttribute(
          "aria-selected",
          "false",
        );

        await clean.assertClean();
      });
    }
  });
}
