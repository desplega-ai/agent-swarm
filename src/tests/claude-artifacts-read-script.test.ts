/**
 * examples/claude-artifacts-read/claude-artifacts-read.sh must never write
 * outside <outdir> and never replace a file with content that failed its
 * sha256 check. A mock `claude` (CLAUDE_BIN) replays canned stream-json, so
 * no network or auth is involved.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

const SCRIPT = resolve(
  import.meta.dir,
  "../../examples/claude-artifacts-read/claude-artifacts-read.sh",
);

const MOCK_CLAUDE = `#!/usr/bin/env bash
case "$2" in
  *list_files*) cat "$MOCK_DIR/list.jsonl" ;;
  *) cat "$MOCK_DIR/read.jsonl" ;;
esac
`;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function toolResult(blocks: string[]): string {
  return JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", content: blocks.map((text) => ({ type: "text", text })) }],
    },
  });
}

let root: string;
let out: string;
let outside: string;
let mockDir: string;

/**
 * Stage a listing whose sha256 for each path is `listed` and a read that
 * returns `served`, then run the script into `out`.
 */
async function run(files: { path: string; listed: string; served: string }[]) {
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    claude_code_version: "2.1.314",
    tools: ["mcp__claude-artifacts__list_files", "mcp__claude-artifacts__read_file"],
  });
  const manifest = {
    slug: "art_mock",
    files: files.map((f) => ({
      path: f.path,
      content_type: "text/html",
      size: f.listed.length,
      sha256: sha256(f.listed),
    })),
  };
  await writeFile(
    join(mockDir, "list.jsonl"),
    `${init}\n${toolResult([JSON.stringify(manifest)])}\n`,
  );
  const reads = files.map((f) =>
    toolResult([
      JSON.stringify({ path: f.path }),
      `<untrusted-document-abc123>${f.served}</untrusted-document-abc123>`,
    ]),
  );
  await writeFile(join(mockDir, "read.jsonl"), `${init}\n${reads.join("\n")}\n`);
  return runChild(["bash", SCRIPT, "https://claude.ai/artifact/mock", out], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      CLAUDE_BIN: join(mockDir, "claude"),
      MOCK_DIR: mockDir,
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-artifacts-read-"));
  out = join(root, "out");
  outside = join(root, "outside");
  mockDir = join(root, "mock");
  await mkdir(out);
  await mkdir(outside);
  await mkdir(mockDir);
  await writeFile(join(mockDir, "claude"), MOCK_CLAUDE, { mode: 0o755 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("claude-artifacts-read.sh", () => {
  test(
    "a sha256 mismatch leaves an existing file untouched",
    async () => {
      await mkdir(join(out, "project"));
      await writeFile(join(out, "project/a.html"), "previous good copy");

      const r = await run([
        { path: "project/a.html", listed: "real content", served: "truncated" },
      ]);

      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("sha256 mismatch: project/a.html");
      expect(await readFile(join(out, "project/a.html"), "utf8")).toBe("previous good copy");
      expect(await readdir(join(out, "project"))).toEqual(["a.html"]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a sha256 mismatch never writes through a destination symlink",
    async () => {
      await writeFile(join(outside, "target.txt"), "external");
      await symlink(join(outside, "target.txt"), join(out, "a.html"));

      const r = await run([{ path: "a.html", listed: "real content", served: "truncated" }]);

      expect(r.exitCode).toBe(1);
      expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("external");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a verified file is not written through a destination symlink",
    async () => {
      await writeFile(join(outside, "target.txt"), "external");
      await symlink(join(outside, "target.txt"), join(out, "a.html"));

      const r = await run([{ path: "a.html", listed: "real content", served: "real content" }]);

      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("refused");
      expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("external");
      expect(await readlink(join(out, "a.html"))).toBe(join(outside, "target.txt"));
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a verified file is not written through a parent directory symlink",
    async () => {
      await symlink(outside, join(out, "project"));

      const r = await run([
        { path: "project/a.html", listed: "real content", served: "real content" },
      ]);

      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("refused");
      expect(await readdir(outside)).toEqual([]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "manifest.json is not written through a symlink",
    async () => {
      await writeFile(join(outside, "target.json"), "external");
      await symlink(join(outside, "target.json"), join(out, "manifest.json"));

      const r = await run([{ path: "a.html", listed: "real content", served: "real content" }]);

      expect(r.exitCode).toBe(1);
      expect(await readFile(join(outside, "target.json"), "utf8")).toBe("external");
      // The run stops before any artifact file is written.
      await expect(lstat(join(out, "a.html"))).rejects.toThrow();
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "verified files and the manifest replace existing regular files",
    async () => {
      await mkdir(join(out, "project"));
      await writeFile(join(out, "project/a.html"), "old");
      await writeFile(join(out, "manifest.json"), "old");

      const r = await run([
        { path: "project/a.html", listed: "real content", served: "real content" },
      ]);

      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("ok: project/a.html");
      expect(await readFile(join(out, "project/a.html"), "utf8")).toBe("real content");
      expect(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")).slug).toBe("art_mock");
      expect(await readdir(join(out, "project"))).toEqual(["a.html"]);
      expect((await lstat(join(out, "project/a.html"))).isFile()).toBe(true);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
