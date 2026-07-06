import { describe, expect, test } from "bun:test";

/**
 * Regression test for the codex_oauth boot-seed jq transform in
 * docker-entrypoint.sh (Auth path 1: seed slot 0 from the config store).
 *
 * The jq program is extracted verbatim from docker-entrypoint.sh and run
 * against real `jq` so this test tracks the actual deployed transform
 * instead of a hand-written mirror that could silently drift from it.
 *
 * Regression: the `auth_mode == "chatgpt"` branch used to return the input
 * object unchanged, so a live pool refresh_token in an auth.json-shaped
 * config value was written straight to the worker's auth.json at boot —
 * the exact unlocked worker-disk refresh path this hardening pass closes.
 * Both accepted shapes (chatgpt auth.json passthrough, flat credentials)
 * must blank refresh_token.
 */

const entrypointPath = `${import.meta.dir}/../../docker-entrypoint.sh`;

function extractCodexOauthSeedFilter(): string {
  const script = require("node:fs").readFileSync(entrypointPath, "utf8");

  // Anchor on `mkdir -p "$WORKER_CODEX_HOME"` — unique to the boot-seed
  // block, unlike the `jq '...'` prefix which also matches the earlier
  // `jq '.' >/dev/null 2>&1` JSON-validity check.
  const anchorIndex = script.indexOf('mkdir -p "$WORKER_CODEX_HOME"');
  if (anchorIndex === -1) {
    throw new Error(
      'Could not locate `mkdir -p "$WORKER_CODEX_HOME"` in docker-entrypoint.sh — did the boot-seed block move?',
    );
  }

  const jqStart = script.indexOf("jq '", anchorIndex);
  if (jqStart === -1) {
    throw new Error(
      "Could not locate the codex_oauth boot-seed jq invocation after the mkdir anchor.",
    );
  }
  const filterStart = jqStart + "jq '".length;

  const closingMarker = '\' > "$WORKER_CODEX_HOME/auth.json"';
  const filterEnd = script.indexOf(closingMarker, filterStart);
  if (filterEnd === -1) {
    throw new Error(
      'Could not locate the closing `\' > "$WORKER_CODEX_HOME/auth.json"` marker for the boot-seed jq filter.',
    );
  }

  return script.slice(filterStart, filterEnd);
}

function runJqFilter(filter: string, input: unknown): unknown {
  const proc = Bun.spawnSync(["jq", filter], {
    stdin: Buffer.from(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`jq failed: ${proc.stderr.toString()}`);
  }
  return JSON.parse(proc.stdout.toString());
}

describe("docker-entrypoint.sh: codex_oauth boot-seed jq transform", () => {
  const filter = extractCodexOauthSeedFilter();

  test("blanks refresh_token for an auth.json-shaped (chatgpt) input", () => {
    const result = runJqFilter(filter, {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "id-tok",
        access_token: "access-tok",
        refresh_token: "live-refresh-tok",
        account_id: "acct-123",
      },
      last_refresh: "2026-07-01T00:00:00.000Z",
    }) as {
      auth_mode: string;
      tokens: {
        id_token: string;
        access_token: string;
        refresh_token: string;
        account_id: string;
      };
      last_refresh: string;
    };

    expect(result.tokens.refresh_token).toBe("");
    expect(result.auth_mode).toBe("chatgpt");
    expect(result.tokens.id_token).toBe("id-tok");
    expect(result.tokens.access_token).toBe("access-tok");
    expect(result.tokens.account_id).toBe("acct-123");
    expect(result.last_refresh).toBe("2026-07-01T00:00:00.000Z");
  });

  test("blanks refresh_token for a flat {access,refresh,accountId,expires} input", () => {
    const result = runJqFilter(filter, {
      access: "access-tok",
      refresh: "live-refresh-tok",
      accountId: "acct-456",
      expires: 1_800_000_000_000,
    }) as {
      auth_mode: string;
      tokens: {
        id_token: string;
        access_token: string;
        refresh_token: string;
        account_id: string;
      };
    };

    expect(result.tokens.refresh_token).toBe("");
    expect(result.auth_mode).toBe("chatgpt");
    expect(result.tokens.id_token).toBe("access-tok");
    expect(result.tokens.access_token).toBe("access-tok");
    expect(result.tokens.account_id).toBe("acct-456");
  });

  test("errors on a value matching neither accepted shape", () => {
    expect(() => runJqFilter(filter, { foo: "bar" })).toThrow();
  });
});
