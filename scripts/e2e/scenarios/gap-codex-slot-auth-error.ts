import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { repoRoot } from "../sut";

// PR #2482: a terminal Codex auth error names the OAuth pool slot and its login command.
// Real codex binary, bogus token in `codex_oauth_2`, isolated HOME. Needs outbound network.
// Control: the same bogus login run without a pool slot keeps the generic message.
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function probe(apiUrl: string, apiKey: string, slot: string) {
  const home = mkdtempSync(join(process.env.GAP_TMP ?? tmpdir(), "gap-codex-"));
  try {
    const child = Bun.spawn(["bun", "scripts/e2e-gap/codex-slot-probe.ts", apiUrl, apiKey, slot], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        ...(process.env.CODEX_PATH_OVERRIDE
          ? { CODEX_PATH_OVERRIDE: process.env.CODEX_PATH_OVERRIDE }
          : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    const line = out.split("\n").find((l) => l.startsWith("PROBE_RESULT "));
    const logTail = await Bun.file(`${home}/codex.log`)
      .text()
      .then((t) => t.slice(-1200))
      .catch(() => "");
    expect(line, `no probe result. stderr tail: ${err.slice(-1500)} log tail: ${logTail}`);
    return JSON.parse(line.slice("PROBE_RESULT ".length)) as {
      isError: boolean;
      errorCategory: string | null;
      failureReason: string;
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export const gapCodexSlotAuthError: Scenario = {
  name: "gap-codex-slot-auth-error",
  order: 1070,
  async run(ctx) {
    // Far enough out that the pool path (12h refresh skew) never refreshes: the turn-level 401 is under test.
    const exp = Math.floor(Date.now() / 1000) + 10 * 24 * 3600;
    const access = `${b64({ alg: "none" })}.${b64({ exp, "https://api.openai.com/auth": { chatgpt_account_id: "acct-gap" } })}.sig`;
    const blob = JSON.stringify({
      access,
      refresh: "bogus-refresh",
      expires: exp * 1000,
      accountId: "acct-gap",
    });
    expectStatus(
      await ctx.api("PUT", "/api/config", {
        body: { scope: "global", scopeId: null, key: "codex_oauth_2", value: blob, isSecret: true },
      }),
      [200],
      "seed bogus codex_oauth_2",
    );

    const slotted = await probe(ctx.baseUrl, ctx.apiKey, "2");
    ctx.log(`gap-codex-slot-auth-error: slot 2 -> ${JSON.stringify(slotted)}`);
    expect(slotted.isError, "bogus token should end the session in error");
    expect(
      slotted.failureReason.includes("Codex pool slot 2 authentication failed") &&
        slotted.failureReason.includes("codex-login --slot 2"),
      `failure does not name slot 2 and its login command: ${slotted.failureReason}`,
    );
    // errorCategory does not cross the codex-session-runner subprocess boundary (null on main too).
  },
};
