import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";

// The task page folds its details card while a link preview is open, so the
// transcript and the preview share the row and the page never turns into the
// narrow Transcript | Details tabs. Closing the preview brings the card back.

/** A task whose prompt links the seeded public page. */
async function taskWithPageLink(
  api: { post<T>(path: string, body: unknown): Promise<T> },
  pageId: string,
): Promise<string> {
  const task = await api.post<{ id: string }>("/api/tasks", {
    task: `Review the [weekly digest](/pages/${pageId}).`,
    source: "ui",
    status: "draft",
  });
  return task.id;
}

const detailsCard = (page: Page) => page.getByRole("complementary", { name: "Task details" });
const transcriptTab = (page: Page) => page.getByRole("tab", { name: "Transcript" });

for (const width of [1280, 1600]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("an open preview folds the details card instead of showing tabs", async ({
      page,
      api,
      seed,
      clean,
    }) => {
      test.skip(!seed, "remote run without seed");
      const id = await taskWithPageLink(api, seed!.pages.public.id);
      await page.goto(`/tasks/${id}`);
      await expect(detailsCard(page)).toBeVisible();

      await page
        .getByRole("link", { name: "weekly digest", exact: true })
        .filter({ visible: true })
        .click();
      const preview = page.getByTestId("link-preview-panel");
      await expect(preview).toBeVisible();
      // Inline in the page body, not a sheet over it.
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(detailsCard(page)).toBeHidden();
      await expect(transcriptTab(page)).toBeHidden();

      // The details toggle still shows the card while previewing.
      await page.getByRole("button", { name: "Show details" }).click();
      await expect(detailsCard(page)).toBeVisible();
      await page.getByRole("button", { name: "Hide details" }).click();
      await expect(detailsCard(page)).toBeHidden();

      // Closing the preview restores the card the user had open.
      await preview.getByRole("button", { name: "Close preview" }).click();
      await expect(preview).toHaveCount(0);
      await expect(detailsCard(page)).toBeVisible();

      // A card the user had folded stays folded after a preview.
      await page.getByRole("button", { name: "Hide details" }).click();
      await page
        .getByRole("link", { name: "weekly digest", exact: true })
        .filter({ visible: true })
        .click();
      await page.getByRole("button", { name: "Show details" }).click();
      await expect(detailsCard(page)).toBeVisible();
      await preview.getByRole("button", { name: "Close preview" }).click();
      await expect(preview).toHaveCount(0);
      await expect(detailsCard(page)).toBeHidden();
      await clean.assertClean();
    });
  });
}
