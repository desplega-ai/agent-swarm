import { randomBytes, randomUUID } from "node:crypto";
import { type CliResult, runCli } from "../cli";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { repoRoot } from "../sut";

/**
 * The operator CLI as a black box: `bun run src/cli.tsx <command>` with a temp HOME and
 * working directory, checked by exit code, output and the files it writes. Worker commands
 * (worker, lead, hook, claude and the like) are excluded in coverage-manifest.json: the
 * nightly harness legs spawn them.
 */

function expectExit(result: CliResult, code: number, label: string): void {
  expect(
    result.exitCode === code,
    `${label}: exit ${result.exitCode}, want ${code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function expectOutput(result: CliResult, text: string, label: string): void {
  expect(
    `${result.stdout}\n${result.stderr}`.includes(text),
    `${label}: output lacks ${JSON.stringify(text)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return asRecord(await Bun.file(path).json());
}

/** help, version, docs and an unknown command: the plain-text paths with no API. */
export const cliHelp: Scenario = {
  name: "cli-help",
  order: 12,
  groups: ["cli"],
  async run() {
    const help = await runCli(["help"]);
    expectExit(help, 0, "help");
    expectOutput(help, "Usage: agent-swarm <command> [options]", "help");
    const listed = help.stdout
      .slice(help.stdout.indexOf("Commands:"))
      .split("\n")
      .map((line) => /^ {2}([a-z][a-z0-9-]*)\s/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name) && name !== "help" && name !== "version");
    expect(listed.length >= 10, `help lists only ${listed.length} commands`);
    // Every listed command has its own help page (a COMMAND_HELP entry), not the general one.
    const pages = await Promise.all(listed.map((name) => runCli([name, "--help"])));
    for (const [index, page] of pages.entries()) {
      const name = listed[index]!;
      expectExit(page, 0, `${name} --help`);
      expectOutput(page, `agent-swarm ${name} — v`, `${name} --help`);
      expectOutput(page, "Usage:", `${name} --help`);
    }

    const pkg = asRecord(await Bun.file(`${repoRoot}/package.json`).json());
    const version = await runCli(["version"]);
    expectExit(version, 0, "version");
    expect(
      version.stdout.trim() === `agent-swarm v${String(pkg.version)}`,
      `version printed ${JSON.stringify(version.stdout.trim())}`,
    );

    const docs = await runCli(["docs"]);
    expectExit(docs, 0, "docs");
    expectOutput(docs, "Documentation: https://docs.agent-swarm.dev", "docs");
    expectOutput(docs, "https://docs.agent-swarm.dev/getting-started.md", "docs");

    const unknown = await runCli(["no-such-command"]);
    expectOutput(unknown, "Unknown command: no-such-command", "unknown command");
  },
};

/** onboard --yes: a dry run writes nothing; a real run writes the compose, env and config files. */
export const cliOnboard: Scenario = {
  name: "cli-onboard",
  order: 13,
  groups: ["cli"],
  async run() {
    // A PATH with bun only: no docker or podman, so onboard can never start containers.
    const bin = `/tmp/e2e-cli-bin-${randomBytes(4).toString("hex")}`;
    await Bun.$`mkdir -p ${bin} && ln -s ${process.execPath} ${bin}/bun`.quiet();
    const env = { PATH: bin, CI: "1", ANONYMIZED_TELEMETRY: "false" };
    try {
      const missing = await runCli(["onboard", "--yes"], { env });
      expectExit(missing, 1, "onboard --yes without a preset");
      expectOutput(missing, "--preset is required in non-interactive mode", "onboard --yes");

      const dry = await runCli(["onboard", "--yes", "--preset=solo", "--dry-run"], { env });
      expectExit(dry, 0, "onboard dry run");
      expectOutput(dry, "DRY-RUN MODE", "onboard dry run");
      expectOutput(dry, "Write docker-compose.yml", "onboard dry run");
      expect(
        !(await Bun.file(`${dry.cwd}/docker-compose.yml`).exists()),
        "onboard --dry-run wrote docker-compose.yml",
      );

      const apiKey = randomBytes(12).toString("hex");
      const real = await runCli(["onboard", "--yes", "--preset=solo", "--no-agent-fs"], {
        env: { ...env, AGENT_SWARM_API_KEY: apiKey },
      });
      // The engine check needs a TTY prompt once no engine is found; the files exist by then.
      const compose = await Bun.file(`${real.cwd}/docker-compose.yml`)
        .text()
        .catch(() => "");
      expect(
        compose.includes("container_name: swarm-api"),
        `onboard wrote no compose file with the API service\nstdout:\n${real.stdout}\nstderr:\n${real.stderr}`,
      );
      expect(compose.includes("ghcr.io/desplega-ai/agent-swarm"), "compose file lacks the image");
      const dotenv = await Bun.file(`${real.cwd}/.env`).text();
      expect(dotenv.includes(`API_KEY=${apiKey}`), ".env lacks the swarm API key from env");
      expect(dotenv.includes("INSTALL_PRESET=solo"), ".env lacks the preset");
      const config = await readJson(`${real.cwd}/.agent-swarm/config.json`);
      expect(
        String(config.apiUrl ?? "").startsWith("http://localhost:"),
        ".agent-swarm/config.json lacks apiUrl",
      );
    } finally {
      await Bun.$`rm -rf ${bin}`.quiet().nothrow();
    }
  },
};

/** connect -y writes the MCP config for the booted API; the key in it authenticates; --restore undoes it. */
export const cliConnect: Scenario = {
  name: "cli-connect",
  order: 14,
  groups: ["cli"],
  async run(ctx) {
    const agentId = randomUUID();
    const env = {
      AGENT_SWARM_API_KEY: ctx.apiKey,
      MCP_BASE_URL: ctx.baseUrl,
      AGENT_ID: agentId,
      CI: "1",
    };
    const noKey = await runCli(["connect", "-y"], { env: { MCP_BASE_URL: ctx.baseUrl, CI: "1" } });
    expectOutput(noKey, "AGENT_SWARM_API_KEY (or legacy API_KEY)", "connect -y without a key");

    const dry = await runCli(["connect", "-y", "--dry-run"], { env });
    expectExit(dry, 0, "connect --dry-run");
    expectOutput(dry, "DRY-RUN MODE", "connect --dry-run");
    expect(!(await Bun.file(`${dry.cwd}/.mcp.json`).exists()), "connect --dry-run wrote .mcp.json");

    const connected = await runCli(["connect", "-y"], { env });
    expectExit(connected, 0, "connect -y");
    expectOutput(connected, "Setup complete!", "connect -y");
    const server = asRecord(
      asRecord((await readJson(`${connected.cwd}/.mcp.json`)).mcpServers)["agent-swarm"],
    );
    expect(server.url === `${ctx.baseUrl}/mcp`, `.mcp.json url is ${String(server.url)}`);
    const headers = asRecord(server.headers);
    expect(headers["X-Agent-ID"] === agentId, ".mcp.json lacks the AGENT_ID from env");
    const settings = await readJson(`${connected.cwd}/.claude/settings.local.json`);
    expect(
      JSON.stringify(settings.permissions ?? {}).includes("mcp__agent-swarm__*"),
      "settings.local.json does not allow the agent-swarm MCP tools",
    );
    // The written header is a working credential for the booted API.
    const authorization = String(headers.Authorization ?? "");
    const response = await ctx.api("GET", "/api/agents", {
      apiKey: authorization.replace(/^Bearer /, ""),
    });
    expectStatus(response, [200], "list agents with the key connect wrote");

    const restored = await runCli(["connect", "--restore"], { cwd: connected.cwd, env });
    expectExit(restored, 0, "connect --restore");
    expectOutput(restored, "Restore complete!", "connect --restore");
    expect(
      !(await Bun.file(`${connected.cwd}/.mcp.json.bak`).exists()),
      "connect --restore left the .mcp.json backup",
    );
  },
};

/** worker-token create, rotate and revoke against the booted API; the printed token acts as its agent. */
export const cliWorkerToken: Scenario = {
  name: "cli-worker-token",
  order: 15,
  groups: ["cli"],
  async run(ctx) {
    const api = ["--api-url", ctx.baseUrl, "--api-key", ctx.apiKey];
    const name = `e2e-cli-token-${ctx.nonce}`;
    const usage = await runCli(["worker-token", "create", ...api]);
    expectExit(usage, 1, "worker-token without an agent");
    expectOutput(usage, "Pass exactly one of --agent-id or --name", "worker-token usage");

    const created = await runCli(["worker-token", "create", "--name", name, ...api]);
    expectExit(created, 0, "worker-token create");
    const agentId = /Created agent (\S+) \(/.exec(created.stderr)?.[1];
    expect(agentId, `worker-token create named no agent\nstderr:\n${created.stderr}`);
    const first = created.stdout.trim();
    expect(first.length > 20 && !first.includes(" "), "worker-token create printed no token");
    expectStatus(
      await ctx.api("GET", `/api/agents/${agentId}`, { apiKey: first }),
      [200],
      "read self with the created token",
    );

    const rotated = await runCli([
      "worker-token",
      "rotate",
      "--agent-id",
      agentId,
      "--grace-sec",
      "0",
      ...api,
    ]);
    expectExit(rotated, 0, "worker-token rotate");
    const second = rotated.stdout.trim();
    expect(second.length > 20 && second !== first, "worker-token rotate printed no new token");
    expectStatus(
      await ctx.api("GET", `/api/agents/${agentId}`, { apiKey: second }),
      [200],
      "read self with the rotated token",
    );
    const oldGone = await pollUntil(
      async () =>
        (await ctx.api("GET", `/api/agents/${agentId}`, { apiKey: first })).status === 401,
      10_000,
      250,
    );
    expect(oldGone, "The rotated-out token still works after --grace-sec 0");

    const revoked = await runCli(["worker-token", "revoke", "--agent-id", agentId, ...api]);
    expectExit(revoked, 0, "worker-token revoke");
    expectOutput(revoked, `worker token(s) of agent ${agentId}`, "worker-token revoke");
    expectStatus(
      await ctx.api("GET", `/api/agents/${agentId}`, { apiKey: second }),
      [401],
      "read self with the revoked token",
    );
  },
};

/** x composio routes a request to a REST base: the booted API stands in for Composio. */
export const cliX: Scenario = {
  name: "cli-x",
  order: 16,
  groups: ["cli"],
  async run(ctx) {
    const noKey = await runCli(["x", "composio", "GET", "/health", "--base-url", ctx.baseUrl]);
    expectExit(noKey, 1, "x composio without a key");
    expectOutput(noKey, "COMPOSIO_API_KEY is required", "x composio without a key");

    const env = { COMPOSIO_API_KEY: "e2e-dummy" };
    const health = await runCli(["x", "composio", "GET", "/health", "--base-url", ctx.baseUrl], {
      env,
    });
    expectExit(health, 0, "x composio GET /health");
    const body = asRecord(JSON.parse(health.stdout));
    expect(Object.keys(body).length > 0, "x composio printed an empty body");

    const missing = await runCli(
      ["x", "composio", "GET", `/api/no-such-route-${ctx.nonce}`, "--base-url", ctx.baseUrl],
      { env },
    );
    expectExit(missing, 1, "x composio on a missing route");
    expectOutput(missing, "composio: HTTP 4", "x composio on a missing route");

    const target = await runCli(["x", "nope"], { env });
    expectExit(target, 1, "x with an unknown target");
    expectOutput(target, "Unknown x target: nope", "x with an unknown target");
  },
};

/** e2b start-stack --dry-run plans an API, a lead and N workers without an E2B key. */
export const cliE2b: Scenario = {
  name: "cli-e2b",
  order: 17,
  groups: ["cli"],
  async run() {
    const plan = await runCli([
      "e2b",
      "start-stack",
      "--dry-run",
      "--json",
      "--swarm",
      "demo",
      "--workers",
      "2",
    ]);
    expectExit(plan, 0, "e2b start-stack --dry-run");
    const stack = asRecord(JSON.parse(plan.stdout));
    const workers = stack.workers;
    expect(Array.isArray(workers) && workers.length === 2, "dry-run plan lacks 2 workers");
    expect(stack.api && stack.lead, "dry-run plan lacks the API or the lead");
    expect(plan.stdout.includes('"demo"'), "dry-run plan lacks the swarm slug");

    const list = await runCli(["e2b", "list"]);
    expectExit(list, 1, "e2b list without a key");
    expectOutput(list, "Missing E2B_API_KEY", "e2b list without a key");
  },
};

/** codex-login and claude-managed-setup read the booted API's config before any provider call. */
export const cliProviderSetup: Scenario = {
  name: "cli-provider-setup",
  order: 18,
  groups: ["cli"],
  async run(ctx) {
    const api = ["--api-url", ctx.baseUrl, "--api-key", ctx.apiKey];
    // The full codex-login flow exchanges a code with auth.openai.com; no stand-in exists.
    const slot = await runCli(["codex-login", "--slot", "101", ...api]);
    expectExit(slot, 1, "codex-login --slot 101");
    expectOutput(slot, "--slot must be an integer between 0 and 100", "codex-login --slot");

    const env = { ANTHROPIC_API_KEY: "e2e-dummy", MCP_BASE_URL: "https://swarm.example.test" };
    const insecure = await runCli(["claude-managed-setup", ...api], {
      env: { ...env, MCP_BASE_URL: "http://swarm.example.test" },
    });
    expectExit(insecure, 1, "claude-managed-setup on an http MCP_BASE_URL");
    expectOutput(insecure, "MCP_BASE_URL must start with https://", "claude-managed-setup");

    // Configured already: the command stops before it calls Anthropic.
    const agentId = `agt_e2e_${ctx.nonce}`;
    const seeded = await ctx.api("PUT", "/api/config", {
      body: { scope: "global", key: "managed_agent_id", value: agentId, isSecret: false },
    });
    expectStatus(seeded, [200, 201], "seed managed_agent_id");
    const configId = String(asRecord(seeded.json).id ?? "");
    try {
      const configured = await runCli(["claude-managed-setup", ...api], { env });
      expectExit(configured, 0, "claude-managed-setup when configured");
      expectOutput(configured, `Target swarm API: ${ctx.baseUrl}`, "claude-managed-setup");
      expectOutput(
        configured,
        `already configured (managed_agent_id=${agentId})`,
        "claude-managed-setup",
      );
    } finally {
      if (configId) await ctx.api("DELETE", `/api/config/${configId}`);
    }
  },
};

/** rbac bootstrap and scripts reembed open a database file directly: a fresh one here. */
export const cliDatabaseCommands: Scenario = {
  name: "cli-database-commands",
  order: 19,
  groups: ["cli"],
  async run() {
    const dir = `/tmp/e2e-cli-db-${randomBytes(4).toString("hex")}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    await Bun.write(`${dir}/key`, randomBytes(32).toString("base64"));
    const env = {
      DATABASE_PATH: `${dir}/swarm.sqlite`,
      SECRETS_ENCRYPTION_KEY_FILE: `${dir}/key`,
      ANONYMIZED_TELEMETRY: "false",
    };
    try {
      const usage = await runCli(["rbac", "nope"], { env });
      expectExit(usage, 1, "rbac with an unknown action");

      const rbac = await runCli(["rbac", "bootstrap"], { env });
      expectExit(rbac, 0, "rbac bootstrap");
      expectOutput(rbac, "RBAC bootstrap complete", "rbac bootstrap");
      for (const role of ["admin", "auditor", "requester", "viewer"]) {
        expect(
          new RegExp(`^\\s*${role}\\s`, "m").test(rbac.stdout),
          `rbac bootstrap lacks role ${role}`,
        );
      }
      expect(await Bun.file(env.DATABASE_PATH).exists(), "rbac bootstrap wrote no database");

      const scripts = await runCli(["scripts", "reembed"], { env });
      expectExit(scripts, 0, "scripts reembed");
      expectOutput(scripts, "Scripts re-embedded.", "scripts reembed");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow();
    }
  },
};

/** api serves /health on its own port and database, then shuts down on SIGTERM. */
export const cliApi: Scenario = {
  name: "cli-api",
  order: 21,
  groups: ["cli"],
  async run(ctx) {
    const dir = `/tmp/e2e-cli-api-${randomBytes(4).toString("hex")}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    await Bun.write(`${dir}/key`, randomBytes(32).toString("base64"));
    const server = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = server.port;
    server.stop(true);
    const key = randomBytes(12).toString("hex");
    // The server reads package.json from its working directory (the install directory).
    await Bun.write(`${dir}/package.json`, Bun.file(`${repoRoot}/package.json`));
    // The SUT's quiet switches: no Slack, no integrations, no background jobs.
    const quiet = Object.fromEntries(
      Object.entries(ctx.sutEnv).filter(([name]) =>
        /^(NODE_ENV|ANONYMIZED_TELEMETRY|OAUTH_KEEPALIVE_DISABLE|HEARTBEAT_CHECKLIST_DISABLE|[A-Z]+_DISABLE|MULTI_RUNTIME_ENABLED)$/.test(
          name,
        ),
      ),
    );
    try {
      const result = await runCli(
        ["api", "--port", String(port), "--key", key, "--db", `${dir}/api.sqlite`],
        {
          // No CI=1: Ink then writes each frame as it renders, so the running line is in
          // stdout even when the process stops without unmounting the app.
          env: { ...quiet, SLACK_DISABLE: "true", SECRETS_ENCRYPTION_KEY_FILE: `${dir}/key` },
          cwd: dir,
          timeoutMs: 90_000,
          async whileRunning() {
            const healthy = await pollUntil(
              async () =>
                (await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined))?.status ===
                200,
              60_000,
              250,
            );
            expect(healthy, "api never served /health");
            const denied = await fetch(`http://127.0.0.1:${port}/api/agents`);
            expect(denied.status === 401, `api without its key answered ${denied.status}`);
            const allowed = await fetch(`http://127.0.0.1:${port}/api/agents`, {
              headers: { Authorization: `Bearer ${key}` },
            });
            expect(allowed.status === 200, `api with its key answered ${allowed.status}`);
          },
        },
      );
      expectOutput(result, "API server running on", "api");
      expect(await Bun.file(`${dir}/api.sqlite`).exists(), "api wrote no database at --db");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow();
    }
  },
};

/** controller refuses to start without a token or with an unsupported kind. */
export const cliController: Scenario = {
  name: "cli-controller",
  order: 22,
  groups: ["cli"],
  async run(ctx) {
    // Runtime pools are off in this suite, so no controller token can connect.
    const noToken = await runCli(["controller", "--api-url", ctx.baseUrl, "--kind", "docker"]);
    expectExit(noToken, 1, "controller without a token");
    expectOutput(
      noToken,
      "Controller requires --api-url and AGENT_SWARM_CONTROLLER_TOKEN",
      "controller",
    );

    const k8s = await runCli(["controller", "--api-url", ctx.baseUrl, "--kind", "k8s"], {
      env: { AGENT_SWARM_CONTROLLER_TOKEN: `aseph_${randomBytes(8).toString("hex")}` },
    });
    expectExit(k8s, 1, "controller --kind k8s");
    expectOutput(k8s, "Remote k8s controllers are not supported", "controller --kind k8s");
  },
};
