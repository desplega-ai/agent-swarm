import { expect, test } from "../fixtures";

test("Kanban card actions support Tab, Enter, Space and click", async ({
  page,
  api,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const board = {
    columnField: "stage",
    columns: ["open"],
    titleField: "title",
    data: [{ id: "row-42", stage: "open", title: "Review request" }],
  };
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name: "e2e-kanban-keyboard",
    definition: {
      models: {},
      queries: {},
      defaultPage: "main",
      pages: {
        main: {
          root: "stack",
          elements: {
            stack: { type: "Stack", props: {}, children: ["start", "static", "active"] },
            start: { type: "Input", props: { id: "start", label: "Start" } },
            static: { type: "Kanban", props: board },
            active: {
              type: "Kanban",
              props: {
                ...board,
                onCardClick: [{ action: "ui.toast", params: { message: { $row: "id" } } }],
              },
            },
          },
        },
      },
    },
  });
  try {
    await page.goto(`/apps/${app.id}`);
    const boards = page.getByTestId("json-render-kanban");
    await expect(boards.first().getByRole("button")).toHaveCount(0);
    const action = boards.last().getByRole("button", { name: "Review request" });
    await page.getByLabel("Start", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(action).toBeFocused();
    const messages = page.getByText("row-42", { exact: true });
    await page.keyboard.press("Enter");
    await expect(messages).toHaveCount(1);
    await page.keyboard.press("Space");
    await expect(messages).toHaveCount(2);
    await action.click();
    await expect(messages).toHaveCount(3);
    await clean.assertClean();
  } finally {
    await api.delete(`/api/apps/${app.id}`);
  }
});
