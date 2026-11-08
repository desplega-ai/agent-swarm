import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChild } from "./test-proc";

const SCRIPT = join(import.meta.dir, "../../scripts/e2e/visuals-comment.ts");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "visuals-comment-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Scenario = { name: string; status: string; error: string | null };

// index.json is fork-controlled for a fork PR; render a comment from a hostile one.
async function render(scenarios: Scenario[]) {
  const dir = join(root, "v2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({
      profile: "v2",
      channel: "channel.png",
      scenarios: scenarios.map((s) => ({ ...s, threads: [] })),
    }),
  );
  const out = join(root, "comment.md");
  const result = await runChild([
    "bun",
    SCRIPT,
    "--base-url",
    "https://raw.example/visuals",
    "--profile",
    `v2=${dir}`,
    "--out",
    out,
    "--sha",
    "0123456789abcdef0123456789abcdef01234567",
  ]);
  expect(result.exitCode).toBe(0);
  return (await Bun.file(out).text()).split("\n");
}

describe("visuals-comment.ts with fork-controlled index.json", () => {
  test("renders a scenario name as a code span, so links and mentions stay inert", async () => {
    const lines = await render([
      { name: "[pwn](https://evil.example) @octocat", status: "pass", error: null },
    ]);
    expect(lines).toContain("#### ` [pwn](https://evil.example) @octocat `");
    expect(lines).toContain("##### ` [pwn](https://evil.example) @octocat `");
  });

  test("renders status and error as code spans that cannot break the table cell", async () => {
    const lines = await render([
      {
        name: "s",
        status: "fail",
        error:
          "see ![t](https://evil.example/p.png) @octocat https://evil.example\nnext a\\| [b](https://evil.example) ``x``",
      },
    ]);
    const row = lines.find((line) => line.includes("FAIL"));
    expect(row).toBe(
      "| **` FAIL `**: ``` see ![t](https://evil.example/p.png) @octocat https://evil.example next a\\│ [b](https://evil.example) ``x`` ``` |",
    );
    // One profile column: the row has exactly its two delimiting pipes.
    expect(row?.split("|").length).toBe(3);
  });

  test("keeps HTML in fork text literal inside the code span", async () => {
    const lines = await render([
      { name: "<img src=x onerror=alert(1)>", status: "pass", error: null },
    ]);
    expect(lines).toContain("#### ` <img src=x onerror=alert(1)> `");
  });
});
