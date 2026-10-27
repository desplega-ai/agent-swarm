import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCodexAuthChain,
  openCodexAuth,
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
});
