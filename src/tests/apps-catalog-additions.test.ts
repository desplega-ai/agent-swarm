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

describe("Chart pie and donut", () => {
  const chart = (props: Record<string, unknown>) =>
    appWith({
      root: {
        type: "Chart",
        props: { kind: "donut", x: "agent", series: [{ key: "spend" }], data: [], ...props },
      },
    });

  test.each(["pie", "donut"])("%s with one series validates", async (kind) => {
    expect(await issuesFor(chart({ kind }))).toEqual([]);
  });

  test.each(["pie", "donut"])("%s with two series is rejected", async (kind) => {
    const issues = await issuesFor(chart({ kind, series: [{ key: "a" }, { key: "b" }] }));
    expect(issues.find((i) => i.path === `${el("root")}.props.series`)?.message).toContain(
      "exactly one series",
    );
  });

  test("bar keeps several series", async () => {
    expect(await issuesFor(chart({ kind: "bar", series: [{ key: "a" }, { key: "b" }] }))).toEqual(
      [],
    );
  });
});

describe("DateRange", () => {
  const range = (props: Record<string, unknown>) =>
    appWith({
      root: { type: "Stack", props: {}, children: ["range", "label"] },
      range: { type: "DateRange", props: { id: "period", ...props } },
      label: { type: "Text", props: { content: { $state: "/ui/period/from" } } },
    });

  test("its /ui/<id>/from read by a bound Text validates", async () => {
    const issues = await issuesFor(
      range({ presets: ["7d", "30d", "90d", "mtd", "custom"], defaultPreset: "30d" }),
    );
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("control: the same /ui read without a DateRange is rejected", async () => {
    const app = range({});
    delete (app.pages.main.elements as Record<string, unknown>).range;
    app.pages.main.elements.root.children = ["label"];
    const issues = await issuesFor(app);
    expect(issues.some((i) => i.path.startsWith(`${el("label")}.props.content`))).toBe(true);
  });

  test("rejects a defaultPreset outside presets", async () => {
    const issues = await issuesFor(range({ presets: ["7d", "30d"], defaultPreset: "90d" }));
    expect(issues.map((i) => i.path)).toContain(`${el("range")}.props.defaultPreset`);
  });

  test("rejects an unknown preset", async () => {
    const issues = await issuesFor(range({ presets: ["1y"] }));
    expect(issues.some((i) => i.path.startsWith(`${el("range")}.props.presets`))).toBe(true);
  });

  test("rejects an id that is not a plain token", async () => {
    const issues = await issuesFor(range({ id: "a/b" }));
    expect(issues.map((i) => i.path)).toContain(`${el("range")}.props.id`);
  });
});

describe("Timeline", () => {
  const timeline = (props: Record<string, unknown>) =>
    appWith({
      root: {
        type: "Timeline",
        props: { data: [], timeField: "at", titleField: "title", ...props },
      },
    });

  test("validates with tones, icon and an onSelect chain", async () => {
    const issues = await issuesFor(
      timeline({
        statusField: "status",
        tones: { done: "success" },
        icon: "check",
        onSelect: [{ action: "app.refresh" }],
      }),
    );
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("validates onSelect as an action chain", async () => {
    const issues = await issuesFor(timeline({ onSelect: [{ action: "app.nope" }] }));
    expect(issues.some((i) => i.path.startsWith(`${el("root")}.props.onSelect`))).toBe(true);
  });

  test("rejects an unknown tone", async () => {
    const issues = await issuesFor(timeline({ statusField: "s", tones: { x: "purple" } }));
    expect(issues.some((i) => i.path.startsWith(`${el("root")}.props.tones`))).toBe(true);
  });
});
