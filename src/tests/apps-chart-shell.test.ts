import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

const fixture = (name: string) =>
  Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json() as Promise<Record<string, any>>;

const definition = await fixture("app-shell-charts-definition.json.txt");

type Elements = Record<string, { type: string; props: Record<string, unknown> }>;

function withProps(page: string, elementId: string, props: Record<string, unknown>) {
  const copy = structuredClone(definition);
  const elements = copy.pages[page].elements as Elements;
  elements[elementId]!.props = { ...elements[elementId]!.props, ...props };
  return copy;
}

async function issuesFor(input: unknown) {
  const parsed = await parseAppDefinition(input);
  return parsed.success ? [] : parsed.issues;
}

async function pathsFor(input: unknown) {
  return (await issuesFor(input)).map((i) => i.path);
}

describe("Chart, Metric sparkline and the sidebar layout", () => {
  test("the sample app using all three passes validation", async () => {
    const parsed = await parseAppDefinition(definition);
    if (!parsed.success) console.error(parsed.issues);
    expect(parsed.success).toBe(true);
  });

  test("Chart rejects unknown and malformed props", async () => {
    const chart = "pages.overview.elements.deploysChart.props";
    expect(await pathsFor(withProps("overview", "deploysChart", { colour: "red" }))).toContain(
      `${chart}.colour`,
    );
    expect(await pathsFor(withProps("overview", "deploysChart", { kind: "pie" }))).toContain(
      `${chart}.kind`,
    );
    expect(await pathsFor(withProps("overview", "deploysChart", { xType: "log" }))).toContain(
      `${chart}.xType`,
    );
    expect(await pathsFor(withProps("overview", "deploysChart", { format: "bytes" }))).toContain(
      `${chart}.format`,
    );
    expect(await pathsFor(withProps("overview", "deploysChart", { series: [] }))).toContain(
      `${chart}.series`,
    );
    const nine = Array.from({ length: 9 }, () => ({ key: "deploys" }));
    expect(await pathsFor(withProps("overview", "deploysChart", { series: nine }))).toContain(
      `${chart}.series`,
    );
    expect(
      await pathsFor(
        withProps("overview", "deploysChart", { series: [{ key: "deploys", color: "pink" }] }),
      ),
    ).toContain(`${chart}.series.0.color`);
    expect(
      await pathsFor(
        withProps("overview", "deploysChart", { series: [{ key: "deploys", stack: "a" }] }),
      ),
    ).toContain(`${chart}.series.0.stack`);
    expect(
      await pathsFor(
        withProps("overview", "deploysChart", { series: [{ key: "deploys" }, { key: "deploys" }] }),
      ),
    ).toContain(`${chart}.series.1.key`);
    expect(await pathsFor(withProps("overview", "deploysChart", { currency: "usd" }))).toContain(
      `${chart}.currency`,
    );
    expect(await pathsFor(withProps("overview", "deploysChart", { height: 40 }))).toContain(
      `${chart}.height`,
    );
    const missingX = structuredClone(definition);
    delete (missingX.pages.overview.elements as Elements).deploysChart!.props.x;
    expect(await pathsFor(missingX)).toContain(`${chart}.x`);
  });

  test("Chart x and series keys are cross-checked against the bound query's model", async () => {
    expect(await issuesFor(withProps("overview", "deploysChart", { x: "day" }))).toContainEqual({
      path: "pages.overview.elements.deploysChart.props.x",
      message: 'unknown or hidden column "day" on model "day"',
    });
    expect(
      await issuesFor(withProps("overview", "deploysChart", { series: [{ key: "deploy" }] })),
    ).toContainEqual({
      path: "pages.overview.elements.deploysChart.props.series.0.key",
      message: 'unknown or hidden column "deploy" on model "day"',
    });
  });

  test("Metric sparkline rejects malformed values and unknown props", async () => {
    const tile = "pages.overview.elements.failuresTile.props";
    expect(await pathsFor(withProps("overview", "failuresTile", { sparkline: ["5"] }))).toContain(
      `${tile}.sparkline.0`,
    );
    expect(await pathsFor(withProps("overview", "failuresTile", { sparkline: 5 }))).toContain(
      `${tile}.sparkline`,
    );
    expect(await pathsFor(withProps("overview", "failuresTile", { sparklineKey: 3 }))).toContain(
      `${tile}.sparklineKey`,
    );
    expect(await pathsFor(withProps("overview", "failuresTile", { sparkLine: [1, 2] }))).toContain(
      `${tile}.sparkLine`,
    );
  });

  test("layout and page shell fields are validated", async () => {
    expect(await pathsFor({ ...definition, layout: "tabs" })).toContain("layout");

    const badIcon = structuredClone(definition);
    badIcon.pages.overview.icon = "chart-pie";
    expect(await issuesFor(badIcon)).toContainEqual({
      path: "pages.overview.icon",
      message: 'unknown icon "chart-pie"',
    });

    const unknownPageKey = structuredClone(definition);
    unknownPageKey.pages.overview.subtitle = "x";
    expect((await pathsFor(unknownPageKey)).some((p) => p.startsWith("pages.overview"))).toBe(true);

    const missingHeader = structuredClone(definition);
    missingHeader.pages.overview.headerActions = "nope";
    expect(await issuesFor(missingHeader)).toContainEqual({
      path: "pages.overview.headerActions",
      message: 'element "nope" not found',
    });

    const doubled = structuredClone(definition);
    doubled.pages.overview.elements.root.children.push("headerRefresh");
    expect(await issuesFor(doubled)).toContainEqual({
      path: "pages.overview.headerActions",
      message: 'element "headerRefresh" is already rendered from root',
    });

    // The header subtree counts as reachable only through `headerActions`.
    const orphan = structuredClone(definition);
    delete orphan.pages.overview.headerActions;
    delete orphan.layout;
    expect(await pathsFor(orphan)).toContain("pages.overview.elements.headerRefresh");

    const noLayout = structuredClone(definition);
    delete noLayout.layout;
    const paths = await pathsFor(noLayout);
    expect(paths).toContain("pages.overview.headerActions");
    expect(paths).toContain("pages.settings.nav");
    // Icons and descriptions are harmless without the layout.
    expect(paths).not.toContain("pages.overview.icon");
    expect(paths).not.toContain("pages.overview.description");
  });

  test("existing definitions still validate and none opts into the sidebar layout", async () => {
    for (const name of [
      "bookmarks-definition.json.txt",
      "catalog-feedback-definition.json.txt",
      "catalog-inputs-definition.json.txt",
      "catalog-table-definition.json.txt",
      "kibo-blocks-definition.json.txt",
      // prs-app-definition is left out: its script refs need a seeded DB.
    ]) {
      const existing = await fixture(name);
      const parsed = await parseAppDefinition(existing);
      if (!parsed.success) console.error(name, parsed.issues);
      expect(parsed.success).toBe(true);
      expect(existing.layout).toBeUndefined();
    }
  });
});
