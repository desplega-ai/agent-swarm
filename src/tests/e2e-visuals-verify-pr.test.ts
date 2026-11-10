import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChild } from "./test-proc";

const SCRIPT = join(import.meta.dir, "../../scripts/e2e/visuals-verify-pr.sh");
const BASE = "desplega-ai/agent-swarm";
const FORK = "contrib/agent-swarm";
const SHA = "ba00cfec7fb04fdc15604d72c4d8c1ad224a0c47";

let binDir: string;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "visuals-verify-gh-"));
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});

type Pr = { number: number; base: string; head: string };

// Fake `gh`: `gh api <path>` prints the canned JSON for that path, logs the call, and
// fails on any path without a fixture (mirrors a real 404/422 failing closed).
function fakeGh(responses: Record<string, Pr[]>) {
  const fixtures = Object.fromEntries(
    Object.entries(responses).map(([path, prs]) => [
      path,
      prs.map((p) => ({
        number: p.number,
        base: { repo: { full_name: p.base } },
        head: { repo: { full_name: p.head } },
      })),
    ]),
  );
  const fixtureFile = join(binDir, "fixtures.json");
  writeFileSync(fixtureFile, JSON.stringify(fixtures));
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/bin/bash
echo "$2" >> "${join(binDir, "calls.log")}"
jq -e --arg p "$2" 'has($p)' "${fixtureFile}" >/dev/null || { echo "HTTP 404: $2" >&2; exit 1; }
jq -c --arg p "$2" '.[$p]' "${fixtureFile}"
`,
  );
  chmodSync(gh, 0o755);
}

async function verify(pr: string, sha: string, headRepo: string) {
  const result = await runChild(["bash", SCRIPT, pr, sha, headRepo], {
    env: { ...process.env, GITHUB_REPOSITORY: BASE, PATH: `${binDir}:${process.env.PATH}` },
  });
  const calls = await Bun.file(join(binDir, "calls.log"))
    .text()
    .catch(() => "");
  return { ...result, calls: calls.trim().split("\n").filter(Boolean) };
}

const basePath = `repos/${BASE}/commits/${SHA}/pulls`;
const forkPath = `repos/${FORK}/commits/${SHA}/pulls`;

describe("visuals-verify-pr.sh", () => {
  test("accepts an in-repo PR from the base lookup without querying another repo", async () => {
    fakeGh({ [basePath]: [{ number: 2861, base: BASE, head: BASE }] });
    const r = await verify("2861", SHA, BASE);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("source=base");
    expect(r.calls).toEqual([basePath]);
  });

  test("accepts a fork-only commit via the head repo lookup", async () => {
    fakeGh({
      [basePath]: [],
      // The fork's own PR for the same commit must not count: its base is the fork.
      [forkPath]: [
        { number: 138, base: FORK, head: FORK },
        { number: 2876, base: BASE, head: FORK },
      ],
    });
    const r = await verify("2876", SHA, FORK);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("source=head-repo");
    expect(r.calls).toEqual([basePath, forkPath]);
  });

  test("rejects when the claimed PR number is not linked to the commit", async () => {
    fakeGh({ [basePath]: [], [forkPath]: [{ number: 2876, base: BASE, head: FORK }] });
    const r = await verify("2861", SHA, FORK);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("found 0");
  });

  test("rejects a fork-internal PR that reuses the claimed number", async () => {
    fakeGh({ [basePath]: [], [forkPath]: [{ number: 2876, base: FORK, head: FORK }] });
    const r = await verify("2876", SHA, FORK);
    expect(r.exitCode).toBe(1);
  });

  test("rejects a head-repo entry whose head is a different repo", async () => {
    fakeGh({
      [basePath]: [],
      [forkPath]: [{ number: 2876, base: BASE, head: "someone-else/agent-swarm" }],
    });
    const r = await verify("2876", SHA, FORK);
    expect(r.exitCode).toBe(1);
  });

  test("does not fall back when the head repo is the base repo", async () => {
    fakeGh({ [basePath]: [] });
    const r = await verify("2861", SHA, BASE);
    expect(r.exitCode).toBe(1);
    expect(r.calls).toEqual([basePath]);
  });

  test("fails closed when the API call errors", async () => {
    fakeGh({ [basePath]: [] });
    const r = await verify("2876", SHA, FORK);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("source=");
  });

  test.each([
    ["0", SHA, FORK],
    ["12a", SHA, FORK],
    ["2876", SHA.toUpperCase(), FORK],
    ["2876", SHA, "../../evil"],
    ["2876", SHA, "../evil"],
    ["2876", SHA, "owner/.."],
    ["2876", SHA, "owner/name/extra"],
  ])("rejects malformed input %s %s %s before any API call", async (pr, sha, headRepo) => {
    fakeGh({});
    const r = await verify(pr, sha, headRepo);
    expect(r.exitCode).toBe(1);
    expect(r.calls).toEqual([]);
  });
});
