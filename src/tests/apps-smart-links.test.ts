import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

/**
 * Validator coverage for smart links (`href` / `linkLabel`, the `link` field
 * kind), the Table column `hint` and `popover`. Pure `parseAppDefinition`
 * calls, like `apps-card-grid.test.ts`.
 */

type Element = { type: string; props?: Record<string, unknown>; children?: string[] };

function appWith(elements: Record<string, Element>) {
  return {
    models: {
      pr: {
        columns: {
          repo: { kind: "string" },
          number: { kind: "number" },
          title: { kind: "string" },
          url: { kind: "string" },
          mergeReason: { kind: "string" },
          ci: { kind: "string" },
          workUrl: { kind: "string" },
        },
      },
    },
    queries: { prs: { model: "pr" } },
    pages: { main: { title: "Main", root: "root", elements } },
    defaultPage: "main",
  };
}

async function issuesFor(input: unknown) {
  const parsed = await parseAppDefinition(input);
  return parsed.success ? [] : parsed.issues;
}

const BOUND = {
  data: { $state: "/queries/prs/data" },
  loading: { $state: "/queries/prs/loading" },
  error: { $state: "/queries/prs/error" },
};

const table = (columns: unknown[]) =>
  appWith({
    root: { type: "Stack", props: {}, children: ["t"] },
    t: { type: "Table", props: { ...BOUND, columns } },
  });

const el = (id: string) => `pages.main.elements.${id}`;

describe("Table smart links", () => {
  test("href, linkLabel, hint and a popover with DetailList fields pass", async () => {
    const issues = await issuesFor(
      table([
        {
          key: "number",
          label: "PR",
          format: "{{repo}}#{{number}}",
          href: "url",
          hint: "The pull request",
          popover: {
            title: "{{title}}",
            trigger: "hover",
            fields: [
              { key: "mergeReason", label: "Merge detail" },
              { key: "ci", kind: "badge", tones: { green: "success" } },
              { key: "title", kind: "link", href: "url", linkLabel: "{{repo}}#{{number}}" },
            ],
          },
        },
        { key: "workUrl", kind: "link", linkLabel: "Task" },
      ]),
    );
    expect(issues).toEqual([]);
  });

  test("an href naming no model column is rejected with its path", async () => {
    const issues = await issuesFor(table([{ key: "number", href: "prUrl" }]));
    expect(issues).toEqual([
      expect.objectContaining({
        path: `${el("t")}.props.columns.0.href`,
        message: expect.stringContaining('unknown or hidden column "prUrl"'),
      }),
    ]);
  });

  test("popover field keys and hrefs are checked against the model", async () => {
    const issues = await issuesFor(
      table([
        {
          key: "number",
          popover: {
            fields: [
              { key: "nope" },
              { key: "title", kind: "link", href: "gone" },
              { key: "title" },
            ],
          },
        },
      ]),
    );
    expect(issues.map((found) => found.path)).toEqual([
      `${el("t")}.props.columns.0.popover.fields.0.key`,
      `${el("t")}.props.columns.0.popover.fields.1.href`,
    ]);
  });

  test("a popover needs at least one field, takes at most 12, and a known trigger", async () => {
    const fields = (count: number) => Array.from({ length: count }, () => ({ key: "title" }));
    expect(await issuesFor(table([{ key: "number", popover: { fields: [] } }]))).not.toEqual([]);
    expect(
      await issuesFor(table([{ key: "number", popover: { fields: fields(13) } }])),
    ).not.toEqual([]);
    expect(await issuesFor(table([{ key: "number", popover: { fields: fields(12) } }]))).toEqual(
      [],
    );
    expect(
      await issuesFor(table([{ key: "number", popover: { fields: fields(1), trigger: "tap" } }])),
    ).not.toEqual([]);
  });
});

describe("DetailList and CardGrid link fields", () => {
  test("a DetailList link field with href passes and a bad href is rejected", async () => {
    const detail = (fields: unknown[]) =>
      appWith({
        root: { type: "Stack", props: {}, children: ["d"] },
        d: {
          type: "DetailList",
          props: { data: { $state: "/queries/prs/data/0" }, fields },
        },
      });
    expect(
      await issuesFor(detail([{ key: "title", kind: "link", href: "url", linkLabel: "{{repo}}" }])),
    ).toEqual([]);
    const issues = await issuesFor(detail([{ key: "title", kind: "link", href: "gone" }]));
    expect(issues.map((found) => found.path)).toEqual([`${el("d")}.props.fields.0.href`]);
  });

  test("a CardGrid link field with href passes and a bad href is rejected", async () => {
    const grid = (fields: unknown[]) =>
      appWith({
        root: { type: "Stack", props: {}, children: ["g"] },
        g: { type: "CardGrid", props: { ...BOUND, titleKey: "title", fields } },
      });
    expect(await issuesFor(grid([{ key: "number", kind: "link", href: "url" }]))).toEqual([]);
    const issues = await issuesFor(grid([{ key: "number", kind: "link", href: "gone" }]));
    expect(issues.map((found) => found.path)).toEqual([`${el("g")}.props.fields.0.href`]);
  });
});
