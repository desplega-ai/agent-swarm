import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

    await Bun.write(statePath, await sealCodexAuth(authJson("r2"), "other-seed"));
    expect(await loadCodexAuthChain(statePath, SEED, warn)).toBeUndefined();
    await Bun.write(statePath, "");
    expect(await loadCodexAuthChain(statePath, SEED, warn)).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("does not open under the current CODEX_OAUTH");
    expect(warnings.join("\n")).not.toContain("r2");
  });

  test("persist logs the outcome and warns on every lost chain without auth contents", async () => {
    const authPath = join(dir, "auth.json");
    const lines: { level: string; message: string }[] = [];
    const log = {
      info: (message: string) => lines.push({ level: "info", message }),
      warn: (message: string) => lines.push({ level: "warn", message }),
    };
    await Bun.write(authPath, authJson("secret-r2"));
    await persistCodexAuthChain(join(dir, "s"), SEED, authPath, async () => authJson("r1"), log);
    expect(lines.pop()).toEqual({ level: "info", message: "codex auth chain persisted (rotated)" });

    // The state path is a directory, so the write fails.
    await persistCodexAuthChain(dir, SEED, authPath, async () => authJson("r1"), log);
    // A parse error message can quote the secret; only the error kind may reach the log.
    await persistCodexAuthChain(
      join(dir, "s"),
      SEED,
      authPath,
      async () => {
        throw new SyntaxError('JSON Parse error: Unexpected identifier "secret-seed"');
      },
      log,
    );
    await persistCodexAuthChain(
      join(dir, "s"),
      SEED,
      join(dir, "missing.json"),
      async () => "",
      log,
    );
    expect(lines.map((line) => line.level)).toEqual(["warn", "warn", "warn"]);
    expect(lines[1]?.message).toBe("WARN codex auth chain not persisted: SyntaxError");
    expect(lines[2]?.message).toContain("missing or has no usable tokens");
    expect(lines.map((line) => line.message).join("\n")).not.toContain("secret");

    lines.length = 0;
    await persistCodexAuthChain(undefined, SEED, authPath, async () => "", log);
    await persistCodexAuthChain(join(dir, "s"), undefined, authPath, async () => "", log);
    expect(lines).toEqual([]);
  });
});
