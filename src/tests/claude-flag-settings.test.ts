import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeSettingsConfigError,
  claudeFlagSettings,
  mergeClaudeSettingsArgs,
  userClaudeMdExclude,
  WORKSPACE_CLAUDE_MD_EXCLUDE,
} from "../providers/claude-flag-settings";

let directory: string;
// Own CONTEXT_MODE_DISABLED: an ambient value would change every expectation.
let prevContextModeDisabled: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "claude-flag-settings-"));
  prevContextModeDisabled = process.env.CONTEXT_MODE_DISABLED;
  delete process.env.CONTEXT_MODE_DISABLED;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  if (prevContextModeDisabled === undefined) delete process.env.CONTEXT_MODE_DISABLED;
  else process.env.CONTEXT_MODE_DISABLED = prevContextModeDisabled;
});

describe("mergeClaudeSettingsArgs", () => {
  test("no caller settings: args pass through, only the workspace exclusion", () => {
    const merged = mergeClaudeSettingsArgs([["--max-turns", "3"]], directory);
    expect(merged.argLists).toEqual([["--max-turns", "3"]]);
    expect(merged.settings).toEqual({
      claudeMdExcludes: [WORKSPACE_CLAUDE_MD_EXCLUDE, userClaudeMdExclude()],
    });
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
      claudeMdExcludes: [
        "/a/CLAUDE.md",
        WORKSPACE_CLAUDE_MD_EXCLUDE,
        "/b/CLAUDE.md",
        userClaudeMdExclude(),
      ],
    });
  });

  test("missing file, malformed JSON and non-object values refuse to start", async () => {
    await writeFile(join(directory, "array.json"), "[1]");
    await writeFile(join(directory, "broken.json"), "{nope");
    const cases: [string[], string][] = [
      [
        ["--settings=missing.json"],
        `file ${join(directory, "missing.json")} cannot be read (ENOENT)`,
      ],
      [["--settings", "broken.json"], `file ${join(directory, "broken.json")} is not valid JSON`],
      [["--settings", "array.json"], "is not a JSON object"],
    ];
    for (const [args, message] of cases) {
      expect(() => mergeClaudeSettingsArgs([args], directory)).toThrow(message);
      expect(() => mergeClaudeSettingsArgs([args], directory)).toThrow(ClaudeSettingsConfigError);
    }
  });

  test("malformed inline JSON error never echoes the value", () => {
    let error: unknown;
    try {
      mergeClaudeSettingsArgs(
        [["--settings", '{"env":{"TOKEN":"sk-ant-oat01-should-not-leak"', "--verbose"]],
        directory,
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ClaudeSettingsConfigError);
    expect((error as Error).message).toContain("inline JSON is not valid JSON");
    expect((error as Error).message).not.toContain("should-not-leak");
  });

  test("a missing value never swallows the next flag", () => {
    for (const args of [
      ["--settings"],
      ["--settings="],
      ["--settings", "--max-turns", "3"],
      ["--settings", `--settings=${JSON.stringify({ model: "x" })}`],
    ]) {
      expect(() => mergeClaudeSettingsArgs([args], directory)).toThrow("--settings has no value");
    }
  });

  test("consecutive valid settings flags merge in order", () => {
    const merged = mergeClaudeSettingsArgs(
      [["--settings", '{"model":"a"}', '--settings={"model":"b","env":{}}', "--max-turns", "3"]],
      directory,
    );
    expect(merged.argLists).toEqual([["--max-turns", "3"]]);
    expect(merged.settings).toEqual({
      model: "b",
      env: {},
      claudeMdExcludes: [WORKSPACE_CLAUDE_MD_EXCLUDE, userClaudeMdExclude()],
    });
  });
});

describe("CONTEXT_MODE_DISABLED", () => {
  // The plugin id the worker image installs.
  const CONTEXT_MODE_CLAUDE_PLUGIN = "context-mode@context-mode";

  test("unset: the context-mode plugin is left to the user settings", () => {
    expect(claudeFlagSettings().enabledPlugins).toBeUndefined();
    expect(mergeClaudeSettingsArgs([[]], directory).settings.enabledPlugins).toBeUndefined();
  });

  test.each(["true", "1"])("=%s turns the context-mode plugin off for the session", (value) => {
    process.env.CONTEXT_MODE_DISABLED = value;
    expect(claudeFlagSettings().enabledPlugins).toEqual({ [CONTEXT_MODE_CLAUDE_PLUGIN]: false });
    expect(mergeClaudeSettingsArgs([[]], directory).settings.enabledPlugins).toEqual({
      [CONTEXT_MODE_CLAUDE_PLUGIN]: false,
    });
  });

  test("overrides a caller that enables the plugin and keeps the caller's other plugins", () => {
    process.env.CONTEXT_MODE_DISABLED = "true";
    const caller = { enabledPlugins: { [CONTEXT_MODE_CLAUDE_PLUGIN]: true, "other@market": true } };
    const merged = mergeClaudeSettingsArgs([["--settings", JSON.stringify(caller)]], directory);
    expect(merged.settings.enabledPlugins).toEqual({
      [CONTEXT_MODE_CLAUDE_PLUGIN]: false,
      "other@market": true,
    });
  });
});
