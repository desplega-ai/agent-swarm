import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

/**
 * The entrypoint's root phase writes skill files under the worker's HOME, sources the
 * config env file, and composes /workspace/start-up.*. These run the real blocks from
 * docker-entrypoint.sh against a scratch dir, with /tmp and /workspace rewritten to it.
 */
const entrypoint = readFileSync("docker-entrypoint.sh", "utf8");

function slice(start: string, end: string, from = 0): string {
  const i = entrypoint.indexOf(start, from);
  const j = entrypoint.indexOf(end, i + start.length);
  if (i === -1 || j === -1) throw new Error(`docker-entrypoint.sh: block ${start} not found`);
  return entrypoint.slice(i, j);
}

const skillSync = slice("# Write simple skills to", "# Install legacy complex remote skills");
const configEnv = `${slice("# BEGIN swarm_config_env", "# END swarm_config_env")}\n${slice(
  "CONFIG_COUNT=$(jq '.configs | length' /tmp/swarm_config.json",
  "        rm -f /tmp/swarm_config.json",
)}`;
const findStartup = slice("find_startup_script() {", "\n}\n");
const composeStartup = `${findStartup}\n}\n${slice(
  '        if [ -n "$GLOBAL_SCRIPT" ] || [ -n "$AGENT_SCRIPT" ]; then',
  "        rm -f /tmp/setup_scripts.json",
)}`;

let root = "";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "entrypoint-boot-writes-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function runBlock(script: string, env: Record<string, string>): Promise<string> {
  const result = await runChild(["bash", "-c", script], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: root, ...env },
    timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS,
  });
  expectChildOk(result, "entrypoint block");
  return result.stdout;
}

/** Runs the simple-skill sync loop with HOME=<root>/home. */
async function syncSkills(skills: { name: string; content: string }[]): Promise<string> {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const response = JSON.stringify({
    skills: skills.map((s) => ({ ...s, isComplex: false })),
  });
  await runBlock(skillSync, { HOME: home, SKILLS_RESPONSE: response });
  return home;
}

const skillTrees = [".claude/skills", ".pi/agent/skills", ".codex/skills"];

describe("docker-entrypoint.sh skill sync", () => {
  test("control: a plain skill lands in every skill tree", async () => {
    const home = await syncSkills([{ name: "plain", content: "plain body" }]);
    for (const tree of skillTrees) {
      expect(readFileSync(join(home, tree, "plain", "SKILL.md"), "utf8")).toBe("plain body\n");
    }
  });

  test("a skill name with path segments stays inside the skill trees", async () => {
    const home = await syncSkills([{ name: "../../escaped", content: "x" }]);
    expect(existsSync(join(home, "escaped"))).toBe(false);
    expect(existsSync(join(home, ".pi", "escaped"))).toBe(false);
    expect(existsSync(join(root, "escaped"))).toBe(false);
  });

  test("does not write through a symlinked SKILL.md or skill directory", async () => {
    const home = join(root, "home");
    const target = join(root, "target");
    writeFileSync(target, "original");
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(join(home, ".claude", "skills", "file-link"), { recursive: true });
    symlinkSync(target, join(home, ".claude", "skills", "file-link", "SKILL.md"));
    symlinkSync(outside, join(home, ".claude", "skills", "dir-link"));
    await syncSkills([
      { name: "file-link", content: "replaced" },
      { name: "dir-link", content: "replaced" },
    ]);
    expect(readFileSync(target, "utf8")).toBe("original");
    expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
  });
});

describe("docker-entrypoint.sh config env export", () => {
  async function exportConfig(): Promise<string> {
    const config = join(root, "swarm_config.json");
    writeFileSync(config, JSON.stringify({ configs: [{ key: "FROM_API", value: "api" }] }));
    const script = `${configEnv.replaceAll("/tmp/", `${root}/`)}\necho "FROM_API=\${FROM_API:-}"\necho "PLANTED=\${PLANTED:-}"`;
    return runBlock(script, {});
  }

  test("control: config rows are exported", async () => {
    expect(await exportConfig()).toContain("FROM_API=api\n");
  });

  test("ignores a pre-existing env file it could not overwrite", async () => {
    const planted = join(root, "swarm_config.env");
    writeFileSync(planted, "PLANTED=1\n");
    chmodSync(planted, 0o444);
    const out = await exportConfig();
    expect(out).toContain("FROM_API=api\n");
    expect(out).toContain("PLANTED=\n");
  });
});

describe("docker-entrypoint.sh start-up script compose", () => {
  async function compose(): Promise<string> {
    const ws = join(root, "workspace");
    mkdirSync(ws, { recursive: true });
    await runBlock(composeStartup.replaceAll("/workspace/", `${ws}/`), {
      AGENT_SCRIPT: "echo agent-setup",
      GLOBAL_SCRIPT: "",
    });
    return ws;
  }

  test("control: creates start-up.sh, and prepends to an existing regular file", async () => {
    let ws = await compose();
    expect(readFileSync(join(ws, "start-up.sh"), "utf8")).toContain("echo agent-setup");
    expect(statSync(join(ws, "start-up.sh")).mode & 0o777).toBe(0o755);
    rmSync(ws, { recursive: true });
    mkdirSync(ws);
    writeFileSync(join(ws, "start-up.sh"), "#!/bin/bash\necho operator\n");
    ws = await compose();
    const body = readFileSync(join(ws, "start-up.sh"), "utf8");
    expect(body).toContain("echo agent-setup");
    expect(body).toContain("echo operator");
  });

  test("does not create a file through a dangling start-up.sh symlink", async () => {
    const ws = join(root, "workspace");
    mkdirSync(ws);
    const created = join(root, "created");
    symlinkSync(created, join(ws, "start-up.sh"));
    await compose();
    expect(existsSync(created)).toBe(false);
  });

  test("does not copy a symlink target's content into the workspace", async () => {
    const ws = join(root, "workspace");
    mkdirSync(ws);
    const secret = join(root, "private");
    writeFileSync(secret, "PRIVATE-DUMMY\n");
    chmodSync(secret, 0o600);
    symlinkSync(secret, join(ws, "start-up.sh"));
    await compose();
    const entry = join(ws, "start-up.sh");
    if (!lstatSync(entry).isSymbolicLink()) {
      expect(readFileSync(entry, "utf8")).not.toContain("PRIVATE-DUMMY");
    }
    expect(readFileSync(secret, "utf8")).toBe("PRIVATE-DUMMY\n");
    expect(statSync(secret).mode & 0o777).toBe(0o600);
  });
});
