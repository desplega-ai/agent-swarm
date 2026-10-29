import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type DeployStubs, makeDeployStubs } from "./deploy-stubs";
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

interface InstallOptions {
  env?: Record<string, string>;
  args?: string[];
  /** Runs against the fake docker before install.sh, e.g. to leave a network behind. */
  before?: (stubs: DeployStubs) => Promise<void>;
}

async function install({ env = {}, args = ["--no-tunnel"], before }: InstallOptions = {}) {
  const stubs = await makeDeployStubs(dir, env);
  await before?.(stubs);
  const r = await runChild(
    ["bash", INSTALL_SH, "--dir", installDir, ...args, "--bind", "127.0.0.1"],
    {
      env: stubs.env,
    },
  );
  return { ...r, out: r.stdout + r.stderr, stubs };
}

const NETWORK = "agent-swarm_default";
const NETWORK_OPTION = 'com.docker.network.bridge.host_binding_ipv4: "127.0.0.1"';
const override = () => readFile(join(installDir, "docker-compose.override.yml"), "utf8");

describe("install.sh --bind", () => {
  test(
    "rewrites an existing literal 3013:3013 mapping before starting the stack",
    async () => {
      await existingInstall('"3013:3013"');
      // The earlier install's network, without a default address. Compose reuses it.
      const r = await install({ before: (stubs) => stubs.network(NETWORK, "") });
      expect(r.exitCode).toBe(0);
      expect(await r.stubs.ups()).toEqual([`${NETWORK} 0.0.0.0`]);
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
        'services:\n  swarm-api:\n    ports:\n      - "0.0.0.0:3014:3014"\n',
      );
      const r = await install();
      expect(r.exitCode).not.toBe(0);
      expect(r.out).toContain(
        "ports are still published outside 127.0.0.1 (0.0.0.0:3014->3014/tcp",
      );
      expect(await override()).toContain(`ports:\n      - "0.0.0.0:3014:3014"\nnetworks:`);
      expect(r.out).not.toContain(BOUND);
      expect(await r.stubs.ports()).toEqual([]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "the first docker compose up, inside a CLI that ignores the bind address, already binds there",
    async () => {
      const r = await install();
      expect(r.exitCode).toBe(0);
      // onboard's own `up` comes first; it must find the network default in place.
      expect((await r.stubs.ups())[0]).toBe(`${NETWORK} 127.0.0.1`);
      const history = await r.stubs.history();
      expect(history.length).toBeGreaterThan(0);
      expect(history.filter((p) => !p.startsWith("127.0.0.1:"))).toEqual([]);
      expect(await override()).toContain(
        `networks:\n  default:\n    driver_opts:\n      ${NETWORK_OPTION}\n`,
      );
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "the override keeps the network default next to the public URL",
    async () => {
      const r = await install({ args: ["--public-url", "https://swarm.example.com"] });
      expect(r.exitCode).toBe(0);
      const text = await override();
      expect(text).toContain(NETWORK_OPTION);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose env var syntax
      expect(text).toContain("- PUBLIC_MCP_BASE_URL=${PUBLIC_MCP_BASE_URL:-}");
      expect(text.match(/^# Written by install\.sh/gm)).toHaveLength(1);
      expect((await r.stubs.history()).filter((p) => !p.startsWith("127.0.0.1:"))).toEqual([]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a re-run with another address rewrites the network default",
    async () => {
      await existingInstall('"3013:3013"');
      await Bun.write(
        join(installDir, "docker-compose.override.yml"),
        `networks:\n  default:\n    driver_opts:\n      com.docker.network.bridge.host_binding_ipv4: "10.0.0.5"\n`,
      );
      const r = await install();
      expect(r.exitCode).toBe(0);
      expect(await override()).toContain(NETWORK_OPTION);
      expect(await override()).not.toContain("10.0.0.5");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a fresh install refuses a network an earlier install left without the default",
    async () => {
      const r = await install({ before: (stubs) => stubs.network(NETWORK, "") });
      expect(r.exitCode).not.toBe(0);
      expect(r.out).toContain(
        `Docker network ${NETWORK} from an earlier install exists and publishes ports on every interface`,
      );
      expect(await r.stubs.history()).toEqual([]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "fails before starting anything when a compose.override.yml would hide the network default",
    async () => {
      await Bun.write(join(installDir, "compose.override.yml"), "services: {}\n");
      const r = await install();
      expect(r.exitCode).not.toBe(0);
      expect(r.out).toContain("compose.override.yml hides docker-compose.override.yml");
      expect(await r.stubs.history()).toEqual([]);
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

  test(
    "stops the stack when onboard fails after starting it",
    async () => {
      const r = await install({ env: { FAKE_ONBOARD_FAIL: "1" } });
      expect(r.exitCode).not.toBe(0);
      expect(await r.stubs.history()).toContain("127.0.0.1:3013->3013/tcp");
      expect(await r.stubs.ports()).toEqual([]);
      expect(r.out).not.toContain(BOUND);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "stops the stack when the installer is terminated after onboard starts it",
    async () => {
      const r = await install({ env: { FAKE_ONBOARD_FAIL: "term" } });
      expect(r.exitCode).not.toBe(0);
      expect(await r.stubs.history()).toContain("127.0.0.1:3013->3013/tcp");
      expect(await r.stubs.ports()).toEqual([]);
      expect(r.out).not.toContain(BOUND);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "stops the stack when the generated compose file names another host address",
    async () => {
      const r = await install({ env: { FAKE_ONBOARD_API_PORT: "0.0.0.0:3013:3013" } });
      expect(r.exitCode).not.toBe(0);
      expect(r.out).toContain("publishes ports that ignore --bind: 0.0.0.0:3013:3013");
      expect(await r.stubs.history()).toContain("0.0.0.0:3013->3013/tcp");
      expect(await r.stubs.ports()).toEqual([]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
