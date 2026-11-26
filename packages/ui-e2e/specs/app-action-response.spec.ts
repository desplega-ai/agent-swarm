import { expect, test } from "../fixtures";

test("app mutations refresh the canvas without a last action response panel", async ({
  page,
  api,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name: "e2e-action-response",
    definition: {
      models: { note: { columns: { title: { kind: "string" } } } },
      queries: { notes: { model: "note" } },
      defaultPage: "main",
      pages: {
        main: {
          root: "stack",
          elements: {
            stack: { type: "Stack", props: {}, children: ["create", "notes"] },
            create: {
              type: "Button",
              props: { label: "Add note" },
              on: {
                press: {
                  action: "app.mutate",
                  params: { model: "note", op: "create", values: { title: "Saved note" } },
                },
              },
            },
            notes: {
              type: "Table",
              props: {
                data: { $state: "/queries/notes/data" },
                columns: [{ key: "title", label: "Title" }],
              },
            },
          },
        },
      },
    },
  });
  try {
    await page.goto(`/apps/${app.id}`);
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(page.getByText("Saved note", { exact: true })).toBeVisible();
    await expect(page.getByText("Last action response", { exact: true })).toHaveCount(0);
    const { rows } = await api.get<{ rows: { data: { title: string } }[] }>(
      `/api/apps/${app.id}/models/note/rows`,
    );
    expect(rows).toHaveLength(1);
    await clean.assertClean();
  } finally {
    await api.delete(`/api/apps/${app.id}`);
  }
});
