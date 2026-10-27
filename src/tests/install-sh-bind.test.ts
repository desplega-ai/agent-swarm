import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeDeployStubs } from "./deploy-stubs";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

// `install.sh --bind` runs for real against a fake docker that publishes ports
// the way Compose does (fixtures/deploy-stubs), so these tests check where the
// running stack listens, not what the script prints.

const INSTALL_SH = resolve(import.meta.dir, "../../install.sh");
const BOUND = "Publishing ports on 127.0.0.1 only";
// What the onboard compose generator puts before each published port.
// biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
const BIND_PREFIX = "${AGENT_SWARM_BIND_ADDRESS:+${AGENT_SWARM_BIND_ADDRESS:-}:}";

let dir: string;
let installDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "install-sh-bind-"));
  installDir = join(dir, "agent-swarm");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// An install from before AGENT_SWARM_BIND_ADDRESS, with `ports` as given.
async function existingInstall(ports: string) {
  await Bun.write(
    join(installDir, "docker-compose.yml"),
    `services:\n  swarm-api:\n    image: ghcr.io/desplega-ai/agent-swarm:latest\n    ports:\n      - ${ports}\n    volumes:\n      - swarm_data:/app/data\n`,
  );
  await Bun.write(join(installDir, ".env"), "API_KEY=k\nMCP_BASE_URL=http://localhost:3013\n");
}

async function install() {
  const stubs = await makeDeployStubs(dir);
  const r = await runChild(
    ["bash", INSTALL_SH, "--dir", installDir, "--no-tunnel", "--bind", "127.0.0.1"],
    { env: stubs.env },
  );
  return { ...r, out: r.stdout + r.stderr, stubs };
}

describe("install.sh --bind", () => {
  test(
    "rewrites an existing literal 3013:3013 mapping before starting the stack",
    async () => {
      await existingInstall('"3013:3013"');
      const r = await install();
      expect(r.exitCode).toBe(0);
      expect(await r.stubs.history()).toEqual(["127.0.0.1:3013->3013/tcp"]);
      const compose = await readFile(join(installDir, "docker-compose.yml"), "utf8");
      expect(compose).toContain(`- "${BIND_PREFIX}3013:3013"`);
      expect(compose).toContain("- swarm_data:/app/data");
      expect(await readFile(join(installDir, "docker-compose.yml.bak"), "utf8")).toContain(
        '- "3013:3013"',
      );
      expect(await readFile(join(installDir, ".env"), "utf8")).toContain(
        "AGENT_SWARM_BIND_ADDRESS=127.0.0.1\n",
      );
      expect(r.out).toContain(BOUND);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "fails without starting the stack when a mapping names another host address",
    async () => {
      await existingInstall('"0.0.0.0:3013:3013"');
      const r = await install();
      expect(r.exitCode).not.toBe(0);
      expect(r.out).toContain("publishes ports that ignore --bind: 0.0.0.0:3013:3013");
      expect(r.out).not.toContain(BOUND);
      expect(await r.stubs.history()).toEqual([]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "stops the stack and fails when a running port still listens elsewhere",
    async () => {
      await existingInstall(`"${BIND_PREFIX}3013:3013"`);
      await Bun.write(
        join(installDir, "docker-compose.override.yml"),
        'services:\n  swarm-api:\n    ports:\n      - "3014:3014"\n',
      );
      const r = await install();
      expect(r.exitCode).not.toBe(0);
      expect(r.out).toContain(
        "ports are still published outside 127.0.0.1 (0.0.0.0:3014->3014/tcp",
      );
      expect(r.out).not.toContain(BOUND);
      expect(await r.stubs.ports()).toEqual([]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a fresh install with a CLI that ignores the bind address ends on loopback",
    async () => {
      const r = await install();
      expect(r.exitCode).toBe(0);
      expect(await r.stubs.ports()).toEqual([
        "127.0.0.1:3013->3013/tcp",
        "127.0.0.1:3201->3000/tcp",
      ]);
      expect(r.out).toContain("Rewriting 2 port mapping(s)");
      expect(r.out).toContain(BOUND);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
