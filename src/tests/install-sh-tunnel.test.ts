import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

// `install.sh --dry-run` prints every command instead of running it, so these
// tests need no Docker and no network. They cover the tunnel default logic.

const INSTALL_SH = resolve(import.meta.dir, "../../install.sh");
const TUNNEL_LINE = "Starting tunnel:";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "install-sh-tunnel-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function dryRun(args: string[] = [], env: Record<string, string> = {}, dotenv?: string) {
  if (dotenv !== undefined) await Bun.write(join(dir, ".env"), dotenv);
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.AGENT_SWARM_TUNNEL;
  delete base.AGENT_SWARM_PRESET;
  delete base.AGENT_SWARM_PUBLIC_URL;
  delete base.AGENT_SWARM_BIND_ADDRESS;
  const r = await runChild(["bash", INSTALL_SH, "--dry-run", "--dir", dir, ...args], {
    env: { ...base, ...env },
  });
  expect(r.exitCode).toBe(0);
  return r.stdout + r.stderr;
}

describe("install.sh tunnel default", () => {
  test(
    "is on by default",
    async () => {
      const out = await dryRun();
      expect(out).toContain(TUNNEL_LINE);
      expect(out).toContain("Pass --no-tunnel to keep it local");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "--no-tunnel turns it off and saves the choice",
    async () => {
      const out = await dryRun(["--no-tunnel"]);
      expect(out).not.toContain(TUNNEL_LINE);
      expect(out).toContain("set AGENT_SWARM_TUNNEL=0");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "AGENT_SWARM_TUNNEL=0 turns it off",
    async () => {
      const out = await dryRun([], { AGENT_SWARM_TUNNEL: "0" });
      expect(out).not.toContain(TUNNEL_LINE);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "--tunnel wins over AGENT_SWARM_TUNNEL=0",
    async () => {
      const out = await dryRun(["--tunnel"], { AGENT_SWARM_TUNNEL: "0" });
      expect(out).toContain(TUNNEL_LINE);
      expect(out).toContain("set AGENT_SWARM_TUNNEL=1");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a saved AGENT_SWARM_TUNNEL=0 in .env keeps it off",
    async () => {
      const out = await dryRun([], {}, "AGENT_SWARM_TUNNEL=0\n");
      expect(out).not.toContain(TUNNEL_LINE);
      expect(out).toContain("AGENT_SWARM_TUNNEL=0 in .env");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a saved AGENT_SWARM_TUNNEL=1 beats an own-domain URL",
    async () => {
      const out = await dryRun(
        [],
        {},
        "AGENT_SWARM_TUNNEL=1\nPUBLIC_MCP_BASE_URL=https://swarm.example.com\n",
      );
      expect(out).toContain(TUNNEL_LINE);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a non-tunnel PUBLIC_MCP_BASE_URL keeps it off",
    async () => {
      const out = await dryRun([], {}, "PUBLIC_MCP_BASE_URL=https://swarm.example.com\n");
      expect(out).not.toContain(TUNNEL_LINE);
      expect(out).toContain("Keeping PUBLIC_MCP_BASE_URL=https://swarm.example.com");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a previous lt.desplega.ai URL keeps it on",
    async () => {
      const out = await dryRun([], {}, "PUBLIC_MCP_BASE_URL=https://abc-def.lt.desplega.ai\n");
      expect(out).toContain(TUNNEL_LINE);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "--tunnel overrides an own-domain .env",
    async () => {
      const out = await dryRun(["--tunnel"], {}, "PUBLIC_MCP_BASE_URL=https://swarm.example.com\n");
      expect(out).toContain(TUNNEL_LINE);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});

async function dryRunFails(args: string[]) {
  const r = await runChild(["bash", INSTALL_SH, "--dry-run", "--dir", dir, ...args]);
  expect(r.exitCode).not.toBe(0);
  return r.stdout + r.stderr;
}

describe("install.sh public URL and bind address", () => {
  const LINK = "/setup?apiUrl=https%3A%2F%2Fswarm.example.com&apiKey=";

  test(
    "--public-url turns the tunnel off, passes the URL to the API and uses it in the link",
    async () => {
      const out = await dryRun(["--public-url", "https://swarm.example.com/"]);
      expect(out).not.toContain(TUNNEL_LINE);
      expect(out).toContain("set AGENT_SWARM_TUNNEL=0");
      expect(out).toContain("set PUBLIC_MCP_BASE_URL=https://swarm.example.com in");
      expect(out).toContain("write docker-compose.override.yml");
      expect(out).toContain("up -d swarm-api agent-fs");
      expect(out).toContain(LINK);
      expect(out).toContain("Public API: https://swarm.example.com\n");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "an own-domain PUBLIC_MCP_BASE_URL in .env reaches the API and the link",
    async () => {
      const out = await dryRun([], {}, "PUBLIC_MCP_BASE_URL=https://swarm.example.com\n");
      expect(out).not.toContain(TUNNEL_LINE);
      expect(out).toContain("write docker-compose.override.yml");
      expect(out).toContain(LINK);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "--no-tunnel ignores a stale tunnel URL and links to localhost",
    async () => {
      const out = await dryRun(
        ["--no-tunnel"],
        {},
        "PUBLIC_MCP_BASE_URL=https://abc.lt.desplega.ai\n",
      );
      expect(out).not.toContain("write docker-compose.override.yml");
      expect(out).toContain("/setup?apiUrl=http%3A%2F%2Flocalhost%3A3013&apiKey=");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "--bind saves the address and plans the port check without claiming it",
    async () => {
      const out = await dryRun(["--no-tunnel", "--bind", "127.0.0.1"]);
      expect(out).not.toContain("Publishing ports on 127.0.0.1 only");
      expect(out).toContain("+ check that every published port listens on 127.0.0.1");
      expect(out).toContain("set AGENT_SWARM_BIND_ADDRESS=127.0.0.1 in");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "--public-url wins over AGENT_SWARM_TUNNEL=1",
    async () => {
      const out = await dryRun(["--public-url", "https://swarm.example.com"], {
        AGENT_SWARM_TUNNEL: "1",
      });
      expect(out).not.toContain(TUNNEL_LINE);
      expect(out).toContain(LINK);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "rejects a URL without a scheme, a conflicting --tunnel, and a non-IP bind",
    async () => {
      expect(await dryRunFails(["--public-url", "swarm.example.com"])).toContain(
        "must start with http:// or https://",
      );
      expect(
        await dryRunFails(["--tunnel", "--public-url", "https://swarm.example.com"]),
      ).toContain("conflict");
      expect(await dryRunFails(["--bind", "localhost"])).toContain("needs an IP address");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
