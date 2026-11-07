import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCodexAuthChain,
  openCodexAuth,
  persistCodexAuthChain,
  saveCodexAuthChain,
  sealCodexAuth,
  usableCodexAuth,
} from "../../scripts/e2e/codex-auth-chain";
import { runHarnessLeg } from "../../scripts/e2e/harness";
import type { ApiClient, ApiResponse } from "../../scripts/e2e/http";

const SEED = JSON.stringify({
  access: "a",
  refresh: "seed-refresh",
  expires: 1,
  accountId: "acct",
});
const EXP = 1_800_000_000;

function jwt(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

function authJson(refresh: string, exp = EXP): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: jwt(exp), refresh_token: refresh, account_id: "acct" },
  });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-auth-chain-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("codex auth chain", () => {
  test("seals without leaking tokens and opens only under the same seed", async () => {
    const auth = authJson("rotated-refresh");
    const sealed = await sealCodexAuth(auth, SEED);
    expect(sealed).not.toContain("rotated-refresh");
    expect(sealed).not.toContain(jwt(EXP));
    expect(await openCodexAuth(sealed, SEED)).toBe(auth);
    expect(await openCodexAuth(sealed, `${SEED} `)).toBeUndefined();
  });

  test("rejects a tampered ciphertext", async () => {
    const box = JSON.parse(await sealCodexAuth(authJson("r1"), SEED)) as { data: string };
    const bytes = Buffer.from(box.data, "base64");
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0xff;
    const tampered = JSON.stringify({ ...box, data: bytes.toString("base64") });
    expect(await openCodexAuth(tampered, SEED)).toBeUndefined();
    expect(await openCodexAuth("not json", SEED)).toBeUndefined();
  });

  test("save then load carries the rotated token to the next run", async () => {
    const statePath = join(dir, "state.sealed");
    const authPath = join(dir, "auth.json");
    expect(await loadCodexAuthChain(statePath, SEED)).toBeUndefined();

    await Bun.write(authPath, authJson("r2"));
    expect(await saveCodexAuthChain(statePath, SEED, authPath, authJson("r1"))).toBe("rotated");
    expect(await loadCodexAuthChain(statePath, SEED)).toBe(authJson("r2"));
    expect(await saveCodexAuthChain(statePath, SEED, authPath, authJson("r2"))).toBe("unchanged");
  });

  test("never replaces a working chain with a blanked refresh token", async () => {
    const statePath = join(dir, "state.sealed");
    const authPath = join(dir, "auth.json");
    await Bun.write(authPath, authJson("r2"));
    await saveCodexAuthChain(statePath, SEED, authPath, authJson("r1"));

    await Bun.write(authPath, authJson(""));
    expect(usableCodexAuth(authJson(""))).toBe(false);
    expect(await saveCodexAuthChain(statePath, SEED, authPath, authJson("r2"))).toBe("skipped");
    expect(await loadCodexAuthChain(statePath, SEED)).toBe(authJson("r2"));
  });

  test("skips without a state path or seed", async () => {
    const authPath = join(dir, "auth.json");
    await Bun.write(authPath, authJson("r2"));
    expect(await saveCodexAuthChain(undefined, SEED, authPath, authJson("r1"))).toBe("skipped");
    expect(await saveCodexAuthChain(join(dir, "s"), undefined, authPath, "")).toBe("skipped");
    expect(await loadCodexAuthChain(undefined, SEED)).toBeUndefined();
  });

  test("warns when a sealed chain exists but does not open, and stays quiet when absent", async () => {
    const statePath = join(dir, "state.sealed");
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(await loadCodexAuthChain(statePath, SEED, warn)).toBeUndefined();
    expect(warnings).toEqual([]);

    // mkdtemp suffixes are random letters and digits, so the token needs a dash to be unique.
    await Bun.write(statePath, await sealCodexAuth(authJson("sealed-r2"), "other-seed"));
    expect(await loadCodexAuthChain(statePath, SEED, warn)).toBeUndefined();
    await Bun.write(statePath, "");
    expect(await loadCodexAuthChain(statePath, SEED, warn)).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("does not open under the current CODEX_OAUTH");
    expect(warnings.join("\n")).not.toContain("sealed-r2");
  });

  test("a retried attempt starts from the chain the failed attempt saved", async () => {
    const statePath = join(dir, "state.sealed");
    const authPath = join(dir, "auth.json");
    const quiet = { info: () => {}, warn: () => {} };
    // Attempt 1 rotates r1 to r2 and then fails its task; the chain must still carry over.
    await Bun.write(authPath, authJson("r2"));
    const start = async () => (await loadCodexAuthChain(statePath, SEED)) ?? authJson("r1");
    expect(await persistCodexAuthChain(statePath, SEED, authPath, start, quiet)).toBeUndefined();
    // Attempt 2, or a re-run that restored this file, starts from r2, never the spent r1.
    expect(await start()).toBe(authJson("r2"));
    await Bun.write(authPath, authJson("r3"));
    expect(await saveCodexAuthChain(statePath, SEED, authPath, await start())).toBe("rotated");
    expect(await start()).toBe(authJson("r3"));
  });

  test("persist returns why a chain was lost, without auth contents", async () => {
    const authPath = join(dir, "auth.json");
    const lines: { level: string; message: string }[] = [];
    const log = {
      info: (message: string) => lines.push({ level: "info", message }),
      warn: (message: string) => lines.push({ level: "warn", message }),
    };
    await Bun.write(authPath, authJson("secret-r2"));
    expect(
      await persistCodexAuthChain(join(dir, "s"), SEED, authPath, async () => authJson("r1"), log),
    ).toBeUndefined();
    expect(lines.pop()).toEqual({ level: "info", message: "codex auth chain persisted (rotated)" });

    const lost = [
      // The state path is a directory, so the save fails after the CLI rotated the token.
      await persistCodexAuthChain(dir, SEED, authPath, async () => authJson("r1"), log),
      // A parse error message can quote the secret; only the error kind may reach the log.
      await persistCodexAuthChain(
        join(dir, "s"),
        SEED,
        authPath,
        async () => {
          throw new SyntaxError('JSON Parse error: Unexpected identifier "secret-seed"');
        },
        log,
      ),
      await persistCodexAuthChain(
        join(dir, "s"),
        SEED,
        join(dir, "missing.json"),
        async () => "",
        log,
      ),
    ];
    expect(lost.every((reason) => reason?.startsWith("codex auth chain not persisted: "))).toBe(
      true,
    );
    expect(lost[1]).toBe("codex auth chain not persisted: SyntaxError");
    expect(lost[2]).toContain("missing or has no usable tokens");
    expect(lines).toEqual(lost.map((reason) => ({ level: "warn", message: `WARN ${reason}` })));
    expect(lines.map((line) => line.message).join("\n")).not.toContain("secret");

    lines.length = 0;
    expect(await persistCodexAuthChain(undefined, SEED, authPath, async () => "", log)).toBe(
      undefined,
    );
    await persistCodexAuthChain(join(dir, "s"), undefined, authPath, async () => "", log);
    expect(lines).toEqual([]);
  });
});

describe("codex harness leg", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  function fakeApi(taskStatus: "completed" | "failed"): ApiClient {
    let marker = "";
    const reply = (status: number, json: unknown): ApiResponse => ({
      status,
      json,
      text: JSON.stringify(json),
    });
    return async (method, path, options) => {
      if (method === "POST" && path === "/api/agents") return reply(201, { id: "agent-1" });
      if (method === "POST" && path === "/api/tasks") {
        const task = String((options?.body as { task?: unknown } | undefined)?.task ?? "");
        marker = task.match(/PONG-[A-Za-z0-9-]+/)?.[0] ?? "";
        return reply(201, { id: "task-1" });
      }
      if (method === "GET" && path.startsWith("/api/tasks/")) {
        return reply(200, { status: taskStatus, output: marker, claudeSessionId: "session-1" });
      }
      if (method === "GET" && path.startsWith("/api/session-costs?")) {
        return reply(200, { costs: [{ inputTokens: 1, outputTokens: 1, totalCostUsd: 0.01 }] });
      }
      throw new Error(`Unexpected fake API call: ${method} ${path}`);
    };
  }

  function fakeWorker(): ReturnType<typeof Bun.spawn> {
    const closed = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    return {
      stdout: closed(),
      stderr: closed(),
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }

  // The state path is a directory, so sealing the chain the CLI left behind fails.
  async function legWithLostChain(taskStatus: "completed" | "failed") {
    process.env.CODEX_OAUTH = SEED;
    process.env.E2E_CODEX_AUTH_STATE = dir;
    process.env.E2E_COST_TIMEOUT_MS = "1000";
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => fakeWorker()) as typeof Bun.spawn);
    try {
      return await runHarnessLeg("codex", fakeApi(taskStatus), "http://chain.test", "key", "n", 2);
    } finally {
      spawn.mockRestore();
    }
  }

  test("a passing task whose chain was not persisted fails as auth-chain", async () => {
    const result = await legWithLostChain("completed");
    expect(result).toMatchObject({ status: "fail", failureKind: "auth-chain" });
    expect(result.error).toStartWith("codex auth chain not persisted: ");
    expect(result.attempts).toHaveLength(1);
  });

  test("a lost chain starts no retry from the spent token", async () => {
    const result = await legWithLostChain("failed");
    expect(result).toMatchObject({ status: "fail", failureKind: "auth-chain" });
    expect(result.error).toContain("codex task finished with status failed");
    expect(result.attempts).toHaveLength(1);
  });
});

describe("nightly workflow codex chain", () => {
  type Step = {
    name?: string;
    id?: string;
    if?: string;
    uses?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
    run?: string;
  };
  const steps = async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(join(import.meta.dir, "../../.github/workflows/nightly-e2e.yml")).text(),
    ) as { jobs: { harness: { steps: Step[] } } };
    return workflow.jobs.harness.steps;
  };
  const byName = (all: Step[], name: string) => {
    const step = all.find((candidate) => candidate.name === name);
    expect(step).toBeDefined();
    return step!;
  };

  test("a failed cache upload fails the leg, and a re-run restores the prior attempt's save", async () => {
    const all = await steps();
    const restore = byName(all, "Restore Codex auth chain");
    const save = byName(all, "Save Codex auth chain");
    const verify = byName(all, "Verify Codex auth chain was saved");
    expect(all.indexOf(verify)).toBeGreaterThan(all.indexOf(save));
    expect(verify.if).toBe(`always() && steps.${save.id}.outcome == 'success'`);
    expect(verify.uses).toStartWith("actions/cache/restore@");
    expect(verify.with).toMatchObject({
      path: save.with?.path,
      key: save.with?.key,
      "lookup-only": true,
      "fail-on-cache-miss": true,
    });
    expect(String(save.with?.key)).toStartWith(String(restore.with?.["restore-keys"]));
  });

  test("a failed save or check rewrites the codex result before it is uploaded", async () => {
    const all = await steps();
    const run = byName(all, "Run harness leg");
    const save = byName(all, "Save Codex auth chain");
    const verify = byName(all, "Verify Codex auth chain was saved");
    const check = byName(all, "Check for a Codex auth chain to save");
    const mark = byName(all, "Fail the codex result when the chain was not saved");
    const upload = byName(all, "Upload harness results");
    expect(all.indexOf(mark)).toBeGreaterThan(all.indexOf(verify));
    expect(all.indexOf(mark)).toBeLessThan(all.indexOf(upload));
    expect(mark.if).toBe(
      `always() && (steps.${check.id}.outcome == 'failure' || steps.${save.id}.outcome == 'failure' || steps.${verify.id}.outcome == 'failure')`,
    );
    const resultsPath = run.run?.match(/--json (\S+)/)?.[1];
    expect(resultsPath).toBeDefined();
    expect(mark.run).toBe(`bun scripts/e2e/codex-chain-lost.ts ${resultsPath}`);
  });

  // The worker image runs steps as root and the harness writes the chain mode 600. hashFiles()
  // runs on the host as the runner user, cannot read that file, and fails the whole condition.
  test("the save is gated by an in-container file check, never hashFiles()", async () => {
    const all = await steps();
    const check = byName(all, "Check for a Codex auth chain to save");
    const save = byName(all, "Save Codex auth chain");
    expect(all.indexOf(check)).toBeLessThan(all.indexOf(save));
    expect(check.if).toBe(
      "always() && matrix.provider == 'codex' && github.ref == 'refs/heads/main'",
    );
    expect(check.run).toContain(`[ -f ${save.with?.path} ]`);
    expect(check.run).toContain(`echo "present=true" >> "$GITHUB_OUTPUT"`);
    expect(save.if).toBe(`always() && steps.${check.id}.outputs.present == 'true'`);
    for (const step of all) expect(step.if ?? "").not.toContain("hashFiles(");
  });

  test("the codex leg and its secret stay on main", async () => {
    const all = await steps();
    const run = byName(all, "Run harness leg");
    expect(run.if).toBe("matrix.provider != 'codex' || github.ref == 'refs/heads/main'");
    for (const step of all.filter((candidate) => candidate.env?.CODEX_OAUTH !== undefined)) {
      expect(step.env?.CODEX_OAUTH).toContain(
        "github.ref == 'refs/heads/main' && secrets.E2E_CODEX_OAUTH",
      );
    }
  });
});
