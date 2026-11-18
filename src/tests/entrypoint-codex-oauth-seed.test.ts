import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const entrypoint = await Bun.file(`${import.meta.dir}/../../docker-entrypoint.sh`).text();
const start = 'elif [ "$HARNESS_PROVIDER" = "codex" ]; then\n';
const end = "\nelse\n";
const codexBranch = entrypoint.split(start)[1]?.split(end)[0];
if (!codexBranch?.includes('WORKER_CODEX_HOME="/home/worker/.codex"')) {
  throw new Error("Could not locate the Codex entrypoint branch");
}
const script = codexBranch.replace(
  'WORKER_CODEX_HOME="/home/worker/.codex"',
  'WORKER_CODEX_HOME="$TEST_CODEX_HOME"',
);

const flat = (label: string) => ({
  access: `fixture-access-${label}`,
  refresh: `fixture-refresh-${label}`,
  accountId: "fixture-account",
  expires: 1_800_000_000_000,
});
const shaped = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "fixture-id-shaped",
    access_token: "fixture-access-shaped",
    refresh_token: "fixture-refresh-shaped",
    account_id: "fixture-account",
  },
  last_refresh: "2026-07-01T00:00:00.000Z",
};

const cases = [
  {
    name: "prefers usable slot 0 to legacy and env",
    slot: JSON.stringify(shaped),
    legacy: JSON.stringify(flat("legacy")),
    env: JSON.stringify(flat("env")),
    access: shaped.tokens.access_token,
    refresh: "",
  },
  {
    name: "skips masked slot 0 and uses multiline legacy JSON",
    slot: "********",
    legacy: JSON.stringify(flat("legacy"), null, 2),
    access: flat("legacy").access,
    refresh: "",
  },
  {
    name: "skips malformed slot and unsupported legacy, retaining flat env refresh",
    slot: "{bad-fixture",
    legacy: '{"auth_mode":"chatgpt","tokens":{}}',
    env: JSON.stringify(flat("env")),
    access: flat("env").access,
    refresh: flat("env").refresh,
  },
  {
    name: "falls back to shaped env if the config endpoint fails",
    unavailable: true,
    env: JSON.stringify(shaped),
    access: shaped.tokens.access_token,
    refresh: shaped.tokens.refresh_token,
  },
  {
    name: "does not write a file from unusable candidates",
    slot: '{"auth_mode":"api_key"}',
    legacy: "[]",
    env: '{"access":123}',
    access: undefined,
  },
  {
    name: "preserves an existing ChatGPT auth file without fetching config",
    existing: true,
    slot: JSON.stringify(flat("slot")),
    access: shaped.tokens.access_token,
    refresh: shaped.tokens.refresh_token,
  },
];

for (const fixture of cases) {
  test(
    fixture.name,
    async () => {
      const home = await mkdtemp(join(tmpdir(), "codex-seed-test-"));
      const file = Bun.file(join(home, "auth.json"));
      let calls = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          if (
            `${new URL(req.url).pathname}${new URL(req.url).search}` !==
              "/api/config/resolved?includeSecrets=true" ||
            req.method !== "GET" ||
            req.headers.get("authorization") !== "Bearer fixture-key"
          )
            return new Response(null, { status: 400 });
          calls++;
          if (fixture.unavailable) return new Response(null, { status: 503 });
          return Response.json({
            configs: [
              { key: "codex_oauth", value: fixture.legacy },
              { key: "codex_oauth_0", value: fixture.slot },
            ],
          });
        },
      });
      try {
        const original = JSON.stringify(shaped, null, 2);
        if (fixture.existing) await Bun.write(file, original);
        const result = await runChild(["bash", "-e", "-c", script], {
          env: {
            PATH: process.env.PATH,
            API_KEY: "fixture-key",
            MCP_URL: server.url.origin,
            TEST_CODEX_HOME: home,
            CODEX_OAUTH: fixture.env ?? "",
          },
        });
        expectChildOk(result, "Codex entrypoint branch");
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain("fixture-");
        expect(calls).toBe(fixture.existing ? 0 : 1);
        if (fixture.access === undefined) {
          expect(await file.exists()).toBe(false);
        } else {
          expect(await file.json()).toMatchObject({
            auth_mode: "chatgpt",
            tokens: {
              access_token: fixture.access,
              refresh_token: fixture.refresh,
              account_id: "fixture-account",
            },
          });
          if (fixture.existing) expect(await file.text()).toBe(original);
          else expect((await stat(file.name!)).mode & 0o777).toBe(0o600);
        }
      } finally {
        await server.stop(true);
        await rm(home, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
}
