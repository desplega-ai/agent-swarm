import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

test(
  "MCP docs retain all app-row helper registrations with descriptions and parameters",
  async () => {
    const root = path.resolve(import.meta.dir, "../..");
    const temp = await mkdtemp(path.join(tmpdir(), "mcp-docs-"));
    try {
      await mkdir(path.join(temp, "scripts"));
      await symlink(path.join(root, "src"), path.join(temp, "src"));
      await symlink(path.join(root, "node_modules"), path.join(temp, "node_modules"));
      const script = path.join(temp, "scripts/generate-mcp-docs.ts");
      await Bun.write(script, Bun.file(path.join(root, "scripts/generate-mcp-docs.ts")));
      const result = expectChildOk(
        await runChild([process.execPath, script]),
        "MCP docs generation",
      );
      const markdown = await Bun.file(path.join(temp, "MCP.md")).text();
      expect(result.stderr).not.toContain('No info found for tool "app-row"');
      expect(markdown).not.toContain("### app-row\n");
      expect(markdown).not.toContain("[app-row](#app-row)");
      // Direct subdirectory imports, barrel imports and multiple registrars
      // sharing one file must keep their individual tools without duplicates.
      for (const name of ["list-model-profiles", "get-config", "room-get", "room-reset"]) {
        expect(markdown.split(`### ${name}\n`)).toHaveLength(2);
      }
      const tools = {
        "app-rows-list": [
          "List app rows with equality filters, sorting, and a limit.",
          "equals",
          "sort",
          "limit",
        ],
        "app-row-get": ["Get an app row.", "rowId"],
        "app-row-create": ["Create an app row.", "values"],
        "app-rows-create": ["Create up to 500 app rows within 10 MiB.", "rows"],
        "app-row-patch": ["Patch an app row.", "rowId", "values"],
        "app-row-delete": ["Delete an app row.", "rowId"],
        "app-rows-delete": [
          "Delete matching app rows. Supply at least one equality filter.",
          "equals",
          "limit",
        ],
      };
      for (const [name, [description, ...params]] of Object.entries(tools)) {
        expect(markdown).toContain(`[${name}](#${name})`);
        expect(markdown.split(`### ${name}\n`)).toHaveLength(2);
        const section = markdown
          .split(`### ${name}\n`)[1]
          ?.split(/\n## /)[0]
          ?.split(/\n### /)[0];
        expect(section).toBeDefined();
        expect(section).toContain(`\n${description}\n`);
        for (const param of ["appId", "model", ...params]) {
          expect(section).toContain(`| \`${param}\` |`);
        }
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

for (const name of ["chat-reply", "chat-post", "model-catalog-overlay-upsert"]) {
  test(
    `MCP docs preserve shared field metadata for ${name}`,
    async () => {
      const root = path.resolve(import.meta.dir, "../..");
      const temp = await mkdtemp(path.join(tmpdir(), "mcp-docs-fields-"));
      try {
        await mkdir(path.join(temp, "scripts"));
        await symlink(path.join(root, "src"), path.join(temp, "src"));
        await symlink(path.join(root, "node_modules"), path.join(temp, "node_modules"));
        const script = path.join(temp, "scripts/generate-mcp-docs.ts");
        await Bun.write(script, Bun.file(path.join(root, "scripts/generate-mcp-docs.ts")));
        expectChildOk(await runChild([process.execPath, script]), "MCP docs generation");
        const markdown = await Bun.file(path.join(temp, "MCP.md")).text();
        const section = markdown.split(`### ${name}\n`)[1]?.split(/\n#{2,3} /)[0];
        expect(section).toBeDefined();
        if (name.startsWith("chat-")) {
          expect(section).toContain(
            "| `attachments` | `string[]` | No | - | Files to send after the text, up to 10:",
          );
          expect(section).toContain("A file over the platform upload limit");
        } else {
          const provider = section?.split("\n").find((line) => line.startsWith("| `provider` |"));
          expect(provider).toContain("opencode-go, nan, helmcode");
          expect(provider).not.toContain("${");
        }
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
}
