import { expect, test } from "../fixtures";

const PR_URL = "https://github.com/desplega-ai/agent-swarm/pull/2605";

test("app Table smart links, header tooltips and cell popovers", async ({
  page,
  api,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name: "e2e-smart-links",
    definition: {
      models: {
        pr: {
          columns: {
            repo: { kind: "string" },
            number: { kind: "number" },
            title: { kind: "string" },
            url: { kind: "string" },
            mergeReason: { kind: "string" },
            queue: { kind: "string" },
          },
        },
      },
      queries: { prs: { model: "pr" } },
      pages: {
        main: {
          root: "table",
          elements: {
            table: {
              type: "Table",
              props: {
                data: { $state: "/queries/prs/data" },
                loading: { $state: "/queries/prs/loading" },
                error: { $state: "/queries/prs/error" },
                columns: [
                  {
                    key: "number",
                    label: "PR",
                    format: "{{repo}}#{{number}}",
                    href: "url",
                    width: 190,
                    popover: {
                      title: "{{title}}",
                      fields: [{ key: "mergeReason", label: "Merge detail" }],
                    },
                  },
                  {
                    key: "queue",
                    label: "Merge queue status",
                    width: 90,
                    hint: "Merge queue state",
                  },
                  { key: "url", label: "PR link", kind: "link", width: 190 },
                ],
              },
            },
          },
        },
      },
      defaultPage: "main",
    },
  });
  try {
    await api.post(`/api/apps/${app.id}/models/pr/rows`, {
      values: {
        repo: "agent-swarm",
        number: 2605,
        title: "feat(apps): smart links",
        url: PR_URL,
        mergeReason: "All required checks passed.",
        queue: "no",
      },
    });
    await page.goto(`/apps/${app.id}`);

    // A PR URL is a chip with the short label; `href` + `format` label the other column.
    const chips = page.locator('a[data-slot="swarm-link"]');
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toHaveText("agent-swarm#2605");
    await expect(chips.first()).toHaveAttribute("href", PR_URL);
    await expect(chips.last()).toHaveText("agent-swarm#2605");

    // A header cut by its column width shows in full, in the styled tooltip.
    await page.getByText("Merge queue status", { exact: false }).first().hover();
    await expect(page.getByRole("tooltip").getByText("Merge queue state")).toBeVisible();

    // The PR cell opens a popover with the row's fields.
    await chips.first().hover();
    await expect(page.getByText("Merge detail")).toBeVisible();
    await expect(page.getByText("All required checks passed.")).toBeVisible();
    await clean.assertClean();
  } finally {
    await api.delete(`/api/apps/${app.id}`);
  }
});
