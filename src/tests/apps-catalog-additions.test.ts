import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

/**
 * Validator coverage for the small catalog additions: `NumberInput`, Select
 * `defaultValue`, and `fill` on Stack / Split. Pure `parseAppDefinition`
 * calls — no DB, no HTTP — mirroring `apps-catalog-inputs.test.ts`.
 */

type Element = { type: string; props?: Record<string, unknown>; children?: string[] };

function appWith(elements: Record<string, Element>) {
  return {
    models: {},
    pages: { main: { title: "Main", root: "root", elements } },
    defaultPage: "main",
  };
}

async function issuesFor(input: unknown) {
  const parsed = await parseAppDefinition(input);
  return parsed.success ? [] : parsed.issues;
}

const el = (id: string) => `pages.main.elements.${id}`;

describe("NumberInput", () => {
  test("a NumberInput's /ui/<id>/value read by a bound Text validates", async () => {
    const issues = await issuesFor(
      appWith({
        root: { type: "Stack", props: {}, children: ["width", "echo"] },
        width: {
          type: "NumberInput",
          props: { id: "x", label: "Width", placeholder: "px", min: 1, max: 4096 },
        },
        echo: { type: "Text", props: { content: { $state: "/ui/x/value" } } },
      }),
    );
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("a /ui/<id>/value read with no UI control of that id is rejected", async () => {
    const issues = await issuesFor(
      appWith({
        root: { type: "Stack", props: {}, children: ["echo"] },
        echo: { type: "Text", props: { content: { $state: "/ui/x/value" } } },
      }),
    );
    expect(issues).toContainEqual({
      path: `${el("echo")}.props.content`,
      message: 'state reference targets unknown UI control "x"',
    });
  });

  test("id is required and min/max must be numbers", async () => {
    const missingId = await issuesFor(
      appWith({
        root: { type: "Stack", props: {}, children: ["width"] },
        width: { type: "NumberInput", props: { label: "Width" } },
      }),
    );
    expect(missingId.map((issue) => issue.path)).toContain(`${el("width")}.props.id`);

    const badBounds = await issuesFor(
      appWith({
        root: { type: "Stack", props: {}, children: ["width"] },
        width: { type: "NumberInput", props: { id: "x", min: "1", max: "10" } },
      }),
    );
    const paths = badBounds.map((issue) => issue.path);
    expect(paths).toContain(`${el("width")}.props.min`);
    expect(paths).toContain(`${el("width")}.props.max`);
  });
});

describe("Select defaultValue", () => {
  const select = (props: Record<string, unknown>) =>
    appWith({
      root: { type: "Stack", props: {}, children: ["device", "echo"] },
      device: {
        type: "Select",
        props: { id: "device", options: ["phone", "tablet", "desktop"], ...props },
      },
      echo: { type: "Text", props: { content: { $state: "/ui/device/value" } } },
    });

  test("a Select with defaultValue validates", async () => {
    const issues = await issuesFor(select({ defaultValue: "tablet" }));
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("defaultValue must be a string", async () => {
    const paths = (await issuesFor(select({ defaultValue: 2 }))).map((issue) => issue.path);
    expect(paths).toContain(`${el("device")}.props.defaultValue`);
  });
});

describe("Stack and Split fill", () => {
  const layout = (stackFill: unknown, splitFill: unknown) =>
    appWith({
      root: { type: "Stack", props: { fill: stackFill }, children: ["split"] },
      split: { type: "Split", props: { fill: splitFill, ratio: "1-1" }, children: ["a", "b"] },
      a: { type: "Text", props: { content: "left" } },
      b: { type: "Text", props: { content: "right" } },
    });

  test("fill: true validates on both", async () => {
    const issues = await issuesFor(layout(true, true));
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("fill must be a boolean", async () => {
    const paths = (await issuesFor(layout("yes", 1))).map((issue) => issue.path);
    expect(paths).toContain(`${el("root")}.props.fill`);
    expect(paths).toContain(`${el("split")}.props.fill`);
  });
});

function pageWith(elements: Record<string, Element>, params: Record<string, unknown>) {
  return {
    models: {},
    pages: { main: { title: "Main", root: "root", params, elements } },
    defaultPage: "main",
  };
}

describe("Drawer presentation split and vertical Divider", () => {
  const params = { issue: { kind: "string" }, other: { kind: "string" } };

  test("one split Drawer and a vertical Divider validate", async () => {
    const issues = await issuesFor(
      pageWith(
        {
          root: { type: "Stack", props: { direction: "row" }, children: ["a", "rule", "drawer"] },
          a: { type: "Text", props: { content: "list" } },
          rule: { type: "Divider", props: { orientation: "vertical" } },
          drawer: {
            type: "Drawer",
            props: { param: "issue", presentation: "split", size: "md", title: "Issue" },
            children: ["body"],
          },
          body: { type: "Text", props: { content: "detail" } },
        },
        params,
      ),
    );
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("a second split Drawer on the page is rejected", async () => {
    const issues = await issuesFor(
      pageWith(
        {
          root: { type: "Stack", props: {}, children: ["d1", "d2"] },
          d1: { type: "Drawer", props: { param: "issue", presentation: "split" } },
          d2: { type: "Drawer", props: { param: "other", presentation: "split" } },
        },
        params,
      ),
    );
    expect(issues).toEqual([
      {
        path: `${el("d2")}.props.presentation`,
        message: `only one presentation: "split" Drawer per page (first: ${el("d1")})`,
      },
    ]);
  });

  test("a split Drawer next to a sheet Drawer validates", async () => {
    const issues = await issuesFor(
      pageWith(
        {
          root: { type: "Stack", props: {}, children: ["d1", "d2"] },
          d1: { type: "Drawer", props: { param: "issue", presentation: "split" } },
          d2: { type: "Drawer", props: { param: "other", presentation: "sheet" } },
        },
        params,
      ),
    );
    expect(issues).toEqual([]);
  });

  test("unknown presentation and orientation values are rejected", async () => {
    const issues = await issuesFor(
      pageWith(
        {
          root: { type: "Stack", props: {}, children: ["d1", "rule"] },
          d1: { type: "Drawer", props: { param: "issue", presentation: "inline" } },
          rule: { type: "Divider", props: { orientation: "diagonal" } },
        },
        params,
      ),
    );
    expect(issues.map((entry) => entry.path).sort()).toEqual(
      [`${el("d1")}.props.presentation`, `${el("rule")}.props.orientation`].sort(),
    );
  });
});
