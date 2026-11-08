import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

/**
 * Validator coverage for the agent-fs `Files` and `File` components: literal
 * paths must be absolute without `..`, bound paths pass, and `Files.onSelect`
 * is a `$row` chain over the entry fields. Pure `parseAppDefinition` calls.
 */

const el = (id: string) => `pages.docs.elements.${id}`;

function filesDefinition(
  filesProps: Record<string, unknown> = {},
  fileProps: Record<string, unknown> = {},
) {
  return {
    models: { note: { columns: { title: { kind: "string" } } } },
    pages: {
      docs: {
        title: "Docs",
        params: { file: { kind: "string" } },
        root: "root",
        elements: {
          root: { type: "Split", props: {}, children: ["docs", "viewer"] },
          docs: {
            type: "Files",
            props: {
              path: "/apps/launch-tracker/docs",
              mode: "browser",
              selectedPath: { $state: "/route/params/file" },
              emptyMessage: "No docs yet",
              onSelect: [
                {
                  action: "app.navigate",
                  params: { page: "docs", params: { file: { $row: "path" } } },
                },
              ],
              ...filesProps,
            },
          },
          viewer: {
            type: "File",
            props: { path: { $state: "/route/params/file" }, fill: true, ...fileProps },
          },
        },
      },
    },
    defaultPage: "docs",
  };
}

async function issuesFor(input: unknown) {
  const parsed = await parseAppDefinition(input);
  return parsed.success ? [] : parsed.issues;
}

describe("Files and File validation", () => {
  test("the plan's list + viewer page validates", async () => {
    const issues = await issuesFor(filesDefinition());
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("a literal File path validates when absolute", async () => {
    expect(
      await issuesFor(filesDefinition({}, { path: "/apps/launch-tracker/README.md" })),
    ).toEqual([]);
  });

  test.each([
    ["relative", "apps/docs"],
    ["parent segment", "/apps/../secrets"],
    ["empty", ""],
  ])("rejects a %s Files path", async (_label, path) => {
    const issues = await issuesFor(filesDefinition({ path }));
    expect(issues.map((i) => i.path)).toContain(`${el("docs")}.props.path`);
  });

  test("rejects a relative File path", async () => {
    const issues = await issuesFor(filesDefinition({}, { path: "notes.md" }));
    expect(issues.map((i) => i.path)).toContain(`${el("viewer")}.props.path`);
  });

  test("rejects an unknown $row field in onSelect", async () => {
    const issues = await issuesFor(
      filesDefinition({
        onSelect: [
          { action: "app.navigate", params: { page: "docs", params: { file: { $row: "id" } } } },
        ],
      }),
    );
    const found = issues.find((i) => i.path.includes("onSelect"));
    expect(found?.message).toContain('unknown Files row field "id"');
  });

  test("validates onSelect as an action chain (unknown action rejected)", async () => {
    const issues = await issuesFor(filesDefinition({ onSelect: [{ action: "app.nope" }] }));
    expect(issues.some((i) => i.path.startsWith(`${el("docs")}.props.onSelect`))).toBe(true);
  });

  test("rejects an unknown mode", async () => {
    const issues = await issuesFor(filesDefinition({ mode: "tree" }));
    expect(issues.map((i) => i.path)).toContain(`${el("docs")}.props.mode`);
  });

  test("requires path on both components", async () => {
    const definition = filesDefinition();
    delete (definition.pages.docs.elements.docs.props as Record<string, unknown>).path;
    delete (definition.pages.docs.elements.viewer.props as Record<string, unknown>).path;
    const paths = (await issuesFor(definition)).map((i) => i.path);
    expect(paths).toContain(`${el("docs")}.props.path`);
    expect(paths).toContain(`${el("viewer")}.props.path`);
  });
});
