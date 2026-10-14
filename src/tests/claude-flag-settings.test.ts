import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeClaudeSettingsArgs,
  WORKSPACE_CLAUDE_MD_EXCLUDE,
} from "../providers/claude-flag-settings";

let directory: string;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "claude-flag-settings-"));
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  warnSpy.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

const warnings = () => warnSpy.mock.calls.map((call) => String(call[0]));

describe("mergeClaudeSettingsArgs", () => {
  test("no caller settings: args pass through, only the workspace exclusion", () => {
    const merged = mergeClaudeSettingsArgs([["--max-turns", "3"]], directory);
    expect(merged.argLists).toEqual([["--max-turns", "3"]]);
    expect(merged.settings).toEqual({ claudeMdExcludes: [WORKSPACE_CLAUDE_MD_EXCLUDE] });
    expect(warnings()).toEqual([]);
  });

  test("strips both flag forms, keeps caller keys, unions and dedupes claudeMdExcludes", async () => {
    await writeFile(
      join(directory, "relative.json"),
      JSON.stringify({ model: "file", claudeMdExcludes: ["/a/CLAUDE.md", "/a/CLAUDE.md"] }),
    );
    const merged = mergeClaudeSettingsArgs(
      [
        ["--settings", "relative.json"],
        [
          "--verbose",
          `--settings=${JSON.stringify({ env: { X: "kept" }, claudeMdExcludes: [WORKSPACE_CLAUDE_MD_EXCLUDE, "/b/CLAUDE.md"] })}`,
        ],
      ],
      directory,
    );
    expect(merged.argLists).toEqual([[], ["--verbose"]]);
    expect(merged.settings).toEqual({
      model: "file",
      env: { X: "kept" },
      claudeMdExcludes: ["/a/CLAUDE.md", WORKSPACE_CLAUDE_MD_EXCLUDE, "/b/CLAUDE.md"],
    });
  });

  test("unparseable inline JSON is dropped with a warning that never echoes the value", () => {
    const merged = mergeClaudeSettingsArgs(
      [["--settings", '{"env":{"TOKEN":"sk-ant-oat01-should-not-leak"', "--verbose"]],
      directory,
    );
    expect(merged.argLists).toEqual([["--verbose"]]);
    expect(merged.settings).toEqual({ claudeMdExcludes: [WORKSPACE_CLAUDE_MD_EXCLUDE] });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("invalid JSON");
    expect(warnings()[0]).not.toContain("should-not-leak");
  });

  test("unreadable file, non-object JSON and a dangling flag keep the exclusion", async () => {
    await writeFile(join(directory, "array.json"), "[1]");
    const merged = mergeClaudeSettingsArgs(
      [["--settings=missing.json", "--settings", "array.json"], ["--settings"]],
      directory,
    );
    expect(merged.argLists).toEqual([[], []]);
    expect(merged.settings).toEqual({ claudeMdExcludes: [WORKSPACE_CLAUDE_MD_EXCLUDE] });
    expect(warnings()).toHaveLength(3);
    expect(warnings()[0]).toContain("ENOENT");
    expect(warnings()[1]).toContain("not a JSON object");
    expect(warnings()[2]).toContain("no value");
  });
});
