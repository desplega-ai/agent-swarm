import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type DeployStubs, makeDeployStubs } from "./deploy-stubs";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const INSTALL_SH = resolve(import.meta.dir, "../../install.sh");
const API_KEY = "installer-fixture-with-+/=&-characters";
let dir: string;
let installDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "install-sh-setup-url-"));
  installDir = join(dir, "install with spaces");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function install(args: string[] = [], configure?: (stubs: DeployStubs) => Promise<void>) {
  const stubs = await makeDeployStubs(dir, { FAKE_API_KEY: API_KEY });
  await configure?.(stubs);
  const result = expectChildOk(
    await runChild(["bash", INSTALL_SH, "--dir", installDir, ...args], { env: stubs.env }),
    "install.sh",
  );
  return result.stdout + result.stderr;
}

describe("install.sh setup link", () => {
  test(
    "redacts the only printed link and saves the full public link privately",
    async () => {
      const out = await install(["--public-url", "https://swarm.example.com"]);
      expect(out).not.toContain(API_KEY);
      expect(out).not.toContain(encodeURIComponent(API_KEY));
      expect(out.match(/https:\/\/app\.agent-swarm\.dev\/setup\?/g)).toHaveLength(1);
      expect(out).toContain("apiKey=<redacted>");
      expect(out).toContain("AGENT_SWARM_INSTALLER=1");
      expect(out).toContain("cat ");

      const path = join(installDir, ".agent-swarm/setup-url");
      const url = new URL((await Bun.file(path).text()).trim());
      expect(url.pathname).toBe("/setup");
      expect(url.searchParams.get("apiUrl")).toBe("https://swarm.example.com");
      expect(url.searchParams.get("apiKey")).toBe(API_KEY);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "replaces an old permissive file and uses localhost when the tunnel is off",
    async () => {
      const path = join(installDir, ".agent-swarm/setup-url");
      await Bun.write(path, "stale link\n");
      await chmod(path, 0o644);
      await install(["--no-tunnel"]);
      const url = new URL((await Bun.file(path).text()).trim());
      expect(url.searchParams.get("apiUrl")).toBe("http://localhost:3013");
      expect(url.searchParams.get("apiKey")).toBe(API_KEY);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "saves the final tunnel URL instead of onboard's localhost URL",
    async () => {
      const out = await install(["--tunnel"], async () => {
        const lt = join(dir, "bin/lt");
        await Bun.write(
          lt,
          '#!/bin/sh\nif [ "$1" = --help ]; then echo lt.desplega.ai; else echo https://fixture.lt.desplega.ai; fi\n',
        );
        await chmod(lt, 0o755);
        const curl = join(dir, "bin/curl");
        await Bun.file(curl).delete();
        await Bun.write(
          curl,
          '#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = -w ]; then printf 200; fi; done\n',
        );
        await chmod(curl, 0o755);
      });
      expect(out.match(/https:\/\/app\.agent-swarm\.dev\/setup\?/g)).toHaveLength(1);
      expect(out).not.toContain(API_KEY);
      expect(out).not.toContain(encodeURIComponent(API_KEY));
      const url = new URL(
        (await Bun.file(join(installDir, ".agent-swarm/setup-url")).text()).trim(),
      );
      expect(url.searchParams.get("apiUrl")).toBe("https://fixture.lt.desplega.ai");
      expect(url.searchParams.get("apiKey")).toBe(API_KEY);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a re-run reads the preferred API key from the existing .env",
    async () => {
      await Bun.write(join(installDir, "docker-compose.yml"), "services: {}\n");
      await Bun.write(
        join(installDir, ".env"),
        `AGENT_SWARM_API_KEY=${API_KEY}\nAPI_KEY=legacy-fixture\n`,
      );
      const out = await install(["--no-tunnel"]);
      expect(out).not.toContain(API_KEY);
      const url = new URL(
        (await Bun.file(join(installDir, ".agent-swarm/setup-url")).text()).trim(),
      );
      expect(url.searchParams.get("apiKey")).toBe(API_KEY);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "dry-run masks an existing key without creating a setup URL file",
    async () => {
      await Bun.write(join(installDir, ".env"), `API_KEY=${API_KEY}\n`);
      const out = await install(["--dry-run", "--no-tunnel"]);
      expect(out).not.toContain(API_KEY);
      expect(out).not.toContain(encodeURIComponent(API_KEY));
      expect(out).toContain("apiKey=<redacted>");
      expect(await Bun.file(join(installDir, ".agent-swarm/setup-url")).exists()).toBe(false);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
