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
            stack: {
              type: "Stack",
              props: {},
              children: ["start", "static", "active", "draggable"],
            },
            start: { type: "Input", props: { id: "start", label: "Start" } },
            static: { type: "Kanban", props: board },
            active: {
              type: "Kanban",
              props: {
                ...board,
                onCardClick: [{ action: "ui.toast", params: { message: { $row: "id" } } }],
              },
            },
            draggable: {
              type: "Kanban",
              props: {
                ...board,
                columns: ["open", "done"],
                data: [{ id: "row-43", stage: "open", title: "Release checklist" }],
                onCardClick: [{ action: "ui.toast", params: { message: { $row: "id" } } }],
                onMove: [{ action: "ui.toast", params: { message: "Card moved" } }],
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
    const action = boards.nth(1).getByRole("button", { name: "Review request", exact: true });
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

    const draggable = boards.last();
    const title = draggable.getByRole("button", { name: "Release checklist", exact: true });
    const handle = draggable.getByRole("button", { name: "Drag Release checklist", exact: true });
    const draggableMessages = page.getByText("row-43", { exact: true });
    const moveMessages = page.getByText("Card moved", { exact: true });
    await page.keyboard.press("Tab");
    await expect(title).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(draggableMessages).toHaveCount(1);
    await expect(handle).not.toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Space");
    await expect(draggableMessages).toHaveCount(2);
    await expect(handle).not.toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Tab");
    await expect(handle).toBeFocused();
    // dnd-kit installs the document key listener on a timer after pickup.
    await page.keyboard.press("Enter", { delay: 100 });
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await expect(draggable.getByRole("status")).toContainText("Release checklist");
    await page.keyboard.press("Escape");
    await expect(page.getByText('Cancelled dragging the card "Release checklist"')).toHaveCount(1);
    await expect(page.getByText("Release checklist", { exact: true })).toHaveCount(1);
    await expect(handle).toBeFocused();
    await expect(draggableMessages).toHaveCount(2);
    await expect(moveMessages).toHaveCount(0);

    await title.click();
    await expect(draggableMessages).toHaveCount(3);
    await clean.assertClean();
  } finally {
    await api.delete(`/api/apps/${app.id}`);
  }
});
