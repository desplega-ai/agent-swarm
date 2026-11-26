import { expect, test } from "../fixtures";

test("Apps table keeps its favorite column compact and centered across desktop widths", async ({
  page,
  api,
  clean,
}) => {
  const { app } = await api.post<{ app: { id: string; name: string } }>("/api/apps", {
    name: "e2e-apps-column-width",
    definition: {
      models: {},
      defaultPage: "main",
      pages: {
        main: {
          root: "text",
          elements: { text: { type: "Text", props: { content: "Column width check" } } },
        },
      },
    },
  });
  try {
    await page.goto("/apps?view=table");
    for (const width of [1280, 1920, 800, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      const row = page.getByRole("row").filter({ hasText: app.name });
      const cell = row.locator('[col-id="favorite"]');
      const star = cell.getByRole("button");
      await expect(star).toBeVisible();
      await expect(cell).toHaveCSS("width", "52px");
      await expect(page.getByRole("columnheader", { name: "Favorite", exact: true })).toHaveCSS(
        "width",
        "52px",
      );
      const cellBox = await cell.boundingBox();
      const starBox = await star.boundingBox();
      expect(cellBox).not.toBeNull();
      expect(starBox).not.toBeNull();
      if (cellBox && starBox) {
        expect(
          Math.abs(starBox.x + starBox.width / 2 - cellBox.x - cellBox.width / 2),
        ).toBeLessThan(1);
      }
    }
    await clean.assertClean();
  } finally {
    await api.delete(`/api/apps/${app.id}`);
  }
});
