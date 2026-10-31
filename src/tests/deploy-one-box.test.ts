import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeDeployStubs } from "./deploy-stubs";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

// deploy/one-box/bootstrap.sh runs for real here, under a scratch root
// (AGENT_SWARM_BOOTSTRAP_ROOT) with stand-ins for docker, curl, apt-get, ufw,
// systemctl and caddy. By default it runs the repo's install.sh, whose onboard
// step is a stand-in for the CLI release on npm before AGENT_SWARM_BIND_ADDRESS:
// port mappings without a host address.

const ROOT = resolve(import.meta.dir, "../..");
const BOOTSTRAP = resolve(ROOT, "deploy/one-box/bootstrap.sh");
const read = (path: string) => Bun.file(resolve(ROOT, path)).text();
const API_KEY = "one-box-test-key";
const HOST = "203-0-113-7.sslip.io";

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deploy-one-box-"));
  root = join(dir, "root");
  for (const sub of ["etc/agent-swarm", "etc/caddy", "etc/profile.d", "var/log", "root"]) {
    await mkdir(join(root, sub), { recursive: true });
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function bootstrap(installUrl = `file://${ROOT}/install.sh`) {
  await Bun.write(
    join(root, "etc/agent-swarm/deploy.env"),
    `SWARM_DOMAIN=\nAGENT_SWARM_INSTALL_URL=${installUrl}\n`,
  );
  const stubs = await makeDeployStubs(dir, {
    AGENT_SWARM_BOOTSTRAP_ROOT: root,
    FAKE_API_KEY: API_KEY,
  });
  const result = await runChild(["bash", BOOTSTRAP], { env: stubs.env });
  const status = (await readFile(join(root, "var/lib/agent-swarm/deploy-status"), "utf8")).trim();
  return { ...result, out: result.stdout + result.stderr, status, stubs };
}

describe("one-box bootstrap.sh", () => {
  test(
    "keeps every published port on loopback from the first docker compose up, with a CLI that ignores --bind",
    async () => {
      const r = await bootstrap();
      expect(r.out).toContain(`Agent Swarm is running at https://${HOST}`);
      expect(r.exitCode).toBe(0);
      expect(r.status).toBe("done");

      // Compose puts the stack on its own network, which daemon.json's "ip" does
      // not cover: the first `up`, inside onboard, must find its default set.
      expect((await r.stubs.ups())[0]).toBe("agent-swarm_default 127.0.0.1");
      const history = await r.stubs.history();
      expect(history.length).toBeGreaterThan(0);
      expect(history.filter((p) => !p.startsWith("127.0.0.1:"))).toEqual([]);
      expect(await r.stubs.ports()).toEqual([
        "127.0.0.1:3013->3013/tcp",
        "127.0.0.1:3201->3000/tcp",
      ]);

      expect(await readFile(join(root, "etc/caddy/Caddyfile"), "utf8")).toContain(
        `${HOST} {\n\treverse_proxy 127.0.0.1:3013\n}`,
      );
      // The /setup link holds the API key: it goes to a root-only file, never stdout.
      const link = await readFile(join(root, "root/agent-swarm-setup-link.txt"), "utf8");
      expect(link).toContain(`/setup?apiUrl=https%3A%2F%2F${HOST}&apiKey=${API_KEY}`);
      expect(r.out).not.toContain(API_KEY);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "stops the stack when install.sh fails after publishing a port on a public interface",
    async () => {
      // A stand-in install.sh: starts a stack bound to 0.0.0.0 explicitly, then fails.
      const script = join(dir, "failing-install.sh");
      await Bun.write(
        script,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'dir=""',
          'while [ $# -gt 0 ]; do case "$1" in --dir) dir="$2"; shift 2 ;; *) shift ;; esac; done',
          'mkdir -p "$dir" && cd "$dir"',
          `printf 'services:\\n  swarm-api:\\n    ports:\\n      - "0.0.0.0:3013:3013"\\n' >docker-compose.yml`,
          "touch .env",
          "docker compose --env-file .env up -d",
          "echo 'API did not become healthy' >&2",
          "exit 1",
          "",
        ].join("\n"),
      );
      const r = await bootstrap(`file://${script}`);
      expect(r.exitCode).not.toBe(0);
      expect(r.status).toBe("failed");
      expect(await r.stubs.history()).toEqual(["0.0.0.0:3013->3013/tcp"]);
      expect(await r.stubs.ports()).toEqual([]);
      expect(await r.stubs.calls()).toContain("compose stop");
      expect(r.out).toContain("stopped the stack because it published ports on a public interface");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "refuses an existing daemon.json without the loopback default before starting anything",
    async () => {
      await mkdir(join(root, "etc/docker"), { recursive: true });
      await Bun.write(join(root, "etc/docker/daemon.json"), '{ "log-driver": "json-file" }\n');
      const r = await bootstrap();
      expect(r.exitCode).not.toBe(0);
      expect(r.status).toBe("failed");
      expect(r.out).toContain('without "ip": "127.0.0.1"');
      expect(await r.stubs.history()).toEqual([]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});

interface CloudConfig {
  write_files: { path: string; permissions?: string; content: string }[];
  runcmd: string[][];
}

describe("one-box deploy packaging", () => {
  test("cloud-init.yaml embeds bootstrap.sh byte for byte and runs it", async () => {
    const yaml = await read("deploy/cloud-init.yaml");
    expect(yaml.startsWith("#cloud-config\n")).toBe(true);
    const config = Bun.YAML.parse(yaml) as CloudConfig;
    const script = config.write_files.find(
      (f) => f.path === "/usr/local/sbin/agent-swarm-bootstrap",
    );
    expect(script?.permissions).toBe("0700");
    // On a mismatch, copy deploy/one-box/bootstrap.sh into the write_files entry (6-space indent).
    expect(script?.content).toBe(await read("deploy/one-box/bootstrap.sh"));
    expect(config.runcmd).toEqual([["/usr/local/sbin/agent-swarm-bootstrap"]]);

    const settings = config.write_files.find((f) => f.path === "/etc/agent-swarm/deploy.env");
    expect(settings?.permissions).toBe("0600");
    expect(settings?.content).toContain("\nSWARM_DOMAIN=\n");
  });

  // Structural only: CI has no packer binary to run `packer validate`.
  test("the DigitalOcean image runs the same bootstrap.sh on first boot", async () => {
    const template = await read("deploy/digitalocean/agent-swarm.pkr.hcl");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Packer HCL syntax
    expect(template).toContain('source      = "${path.root}/../one-box/bootstrap.sh"');
    expect(template).toContain('destination = "/opt/agent-swarm/bootstrap.sh"');
    const onboot = await read(
      "deploy/digitalocean/files/var/lib/cloud/scripts/per-instance/001_onboot",
    );
    expect(onboot).toContain("\n/opt/agent-swarm/bootstrap.sh\n");
  });
});
