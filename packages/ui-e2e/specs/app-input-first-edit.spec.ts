import { expect, test } from "../fixtures";

// The first keystroke after a cold load used to vanish: the surface marked the
// interaction in the input's capture phase, the browser flushed that re-render
// before the bubble-phase onChange, and React reset the field to its old value.
// Only a real browser runs microtasks between listeners, so this lives here.
test("app inputs keep the first keystroke after a cold load", async ({
  page,
  api,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name: "e2e-input-first-edit",
    definition: {
      models: {},
      queries: {},
      defaultPage: "main",
      pages: {
        main: {
          state: { code: "" },
          root: "stack",
          elements: {
            stack: { type: "Stack", props: {}, children: ["plain", "bound", "search"] },
            plain: { type: "Input", props: { id: "plain", label: "Plain" } },
            bound: {
              type: "Input",
              props: { id: "bound", label: "Bound", value: { $bindState: "/local/code" } },
            },
            search: { type: "SearchInput", props: { id: "search", label: "Filter rows" } },
          },
        },
      },
    },
  });
  try {
    for (const label of ["Plain", "Bound", "Filter rows"]) {
      // A fresh document per field: each one has to survive a cold first edit.
      await page.goto(`/apps/${app.id}`);
      const field = page.getByLabel(label, { exact: true });
      await field.click();
      await page.keyboard.type("381946");
      await expect(field).toHaveValue("381946");
    }
    await clean.assertClean();
  } finally {
    await api.delete(`/api/apps/${app.id}`);
  }
});
