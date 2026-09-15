import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

describe("helper credentials", () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  async function stub(name: string, body: string) {
    const path = join(dir, name);
    await Bun.write(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
    await chmod(path, 0o755);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "helper-credentials-"));
    env = {
      PATH: `${dir}:${process.env.PATH}`,
      TMPDIR: dir,
      CAPTURE: join(dir, "capture"),
      REAL_BUN: process.execPath,
    };
    await stub("id", "echo 0");
    await stub("curl", 'printf "%s\\n" "$@" >> "$CAPTURE"; exit 23');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const script of ["e2e-workflow-test.sh", "seed-api-keys.sh", "scripts-api-smoke.sh"]) {
    for (const empty of [false, true]) {
      test(`${script} rejects ${empty ? "empty" : "missing"} credentials before requests`, async () => {
        const result = await runChild(["bash", `scripts/${script}`], {
          env: {
            ...env,
            SWARM_BASE_URL: "http://unused.invalid",
            ...(empty ? { AGENT_SWARM_API_KEY: "", API_KEY: "" } : {}),
          },
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("AGENT_SWARM_API_KEY");
        expect(await Bun.file(env.CAPTURE as string).exists()).toBe(false);
      });
    }
  }

  for (const preferred of [false, true]) {
    test(`workflow helper uses ${preferred ? "preferred" : "legacy"} exported key`, async () => {
      const key = crypto.randomUUID();
      const result = await runChild(["bash", "scripts/e2e-workflow-test.sh"], {
        env: {
          ...env,
          API_KEY: preferred ? crypto.randomUUID() : key,
          ...(preferred ? { AGENT_SWARM_API_KEY: key } : {}),
        },
      });
      expect(result.exitCode).toBe(1); // Deliberate connection failure after capturing auth.
      expect(await Bun.file(env.CAPTURE as string).text()).toContain(
        `Authorization: Bearer ${key}`,
      );
      expect(result.stdout + result.stderr).not.toContain(key);
    });
  }

  test("seed helper gives its explicit argument precedence over exported keys", async () => {
    await stub("curl", 'printf "%s\\n" "$@" >> "$CAPTURE"');
    const key = crypto.randomUUID();
    const result = await runChild(
      ["bash", "scripts/seed-api-keys.sh", "http://unused.invalid", key],
      {
        env: { ...env, AGENT_SWARM_API_KEY: crypto.randomUUID(), API_KEY: crypto.randomUUID() },
      },
    );
    expectChildOk(result, "seed helper");
    const captured = await Bun.file(env.CAPTURE as string).text();
    expect(captured.match(/Authorization: Bearer /g)?.length).toBe(158);
    expect(captured.match(new RegExp(key, "g"))?.length).toBe(158);
    expect(result.stdout + result.stderr).not.toContain(key);
  });

  test(
    "self-hosted smoke generates a fresh key per run and uses it for server and clients",
    async () => {
      // Run the real key generator; replace only server startup and HTTP transport.
      await stub(
        "bun",
        'if [[ "$1" != run ]]; then exec "$REAL_BUN" "$@"; fi\nprintf "%s" "$AGENT_SWARM_API_KEY" > "$CAPTURE.server"',
      );
      await stub(
        "curl",
        `if [[ "$*" == *"/health"* ]]; then exit 0; fi
for _ in {1..100}; do [[ -s "$CAPTURE.server" ]] && break; sleep 0.01; done
expected="Authorization: Bearer $(cat "$CAPTURE.server")"
for arg in "$@"; do
  if [[ "$arg" == "$expected" ]]; then
    echo authenticated >> "$CAPTURE"
    echo '{"version":1,"name":"scripts-smoke-double","result":42,"deleted":true}'
    exit 0
  fi
done
exit 22`,
      );
      const keys: string[] = [];
      for (let i = 0; i < 2; i++) {
        await rm(`${env.CAPTURE}.server`, { force: true });
        const result = await runChild(["bash", "scripts/scripts-api-smoke.sh"], { env });
        expectChildOk(result, "self-hosted smoke");
        const key = await Bun.file(`${env.CAPTURE}.server`).text();
        expect(key).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
        expect(result.stdout + result.stderr).not.toContain(key);
        keys.push(key);
      }
      expect(keys[0]).not.toBe(keys[1]);
      expect((await Bun.file(env.CAPTURE as string).text()).trim().split("\n")).toHaveLength(10);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  for (const empty of [false, true]) {
    test(`PostgreSQL rejects ${empty ? "empty" : "missing"} password before creating a cluster`, async () => {
      const cluster = join(dir, "cluster");
      const result = await runChild(["bash", "scripts/init-local-postgres.sh"], {
        env: {
          ...env,
          LOCAL_POSTGRES_DATA_DIR: cluster,
          ...(empty ? { LOCAL_POSTGRES_PASSWORD: "" } : {}),
        },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("LOCAL_POSTGRES_PASSWORD");
      expect(await Bun.file(join(cluster, "data", "PG_VERSION")).exists()).toBe(false);
    });
  }
});
