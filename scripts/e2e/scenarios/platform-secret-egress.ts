import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { claimTask, createAssignedTask, registerWorker } from "./core-helpers";
import { deleteConfig, putConfig } from "./platform-helpers";
import { startStub } from "./script-helpers";

/** Fake credential values, separate from ctx.nonce (the scrubber remembers values it saw). */
function fakeValue(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

/**
 * An MCP server that echoes the `x-echo-secret` request header: in the tool list, in a tool
 * result and in a JSON-RPC error. The plain `echo` text stays as sent.
 */
function echoingMcp(request: Request, body: string): Response {
  const rpc = JSON.parse(body || "{}") as { id?: unknown; method?: string; params?: unknown };
  const header = request.headers.get("x-echo-secret") ?? "";
  if (rpc.method === "initialize") {
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "e2e-echo", version: "1" },
      },
    });
  }
  if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (rpc.method === "tools/list") {
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        tools: [
          {
            name: "echo",
            description: `Echo text back (auth ${header})`,
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
          { name: "fail", description: "Fail", inputSchema: { type: "object" } },
        ],
      },
    });
  }
  const params = asRecord(rpc.params);
  if (rpc.method === "tools/call" && params.name === "fail") {
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      error: { code: -32000, message: `upstream rejected ${header}` },
    });
  }
  if (rpc.method === "tools/call") {
    const text = String(asRecord(params.arguments).text);
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { content: [{ type: "text", text: `echo:${text} header:${header}` }] },
    });
  }
  return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "no" } });
}

/** The script MCP proxy redacts the injected header value from results, errors and tool lists. */
async function mcpProxyResponses(ctx: ScenarioContext, workerId: string): Promise<void> {
  const secret = fakeValue("e2e-hdr");
  const key = `E2E_ECHO_SECRET_${ctx.nonce.toUpperCase()}`;
  const stub = startStub(echoingMcp);
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    const row = await putConfig(ctx, { key, value: secret, isSecret: true });
    cleanup.unshift(() => deleteConfig(ctx, String(row.id)));
    const server = await ctx.api("POST", "/api/mcp-servers", {
      body: {
        name: `e2e-echo-mcp-${ctx.nonce}`,
        transport: "http",
        url: `${stub.origin}/mcp`,
        headerConfigKeys: JSON.stringify({ "X-Echo-Secret": key }),
      },
    });
    expectStatus(server, [201], "register the echoing MCP server");
    const serverId = asString(asRecord(asRecord(server.json).server).id, "mcp server id");
    cleanup.unshift(() => ctx.api("DELETE", `/api/mcp-servers/${serverId}`));
    const created = await ctx.api("POST", "/api/script-connections", {
      body: { kind: "mcp", slug: `e2eEcho${ctx.nonce}`, mcpServerId: serverId },
    });
    expectStatus(created, [200], "create the echoing MCP connection");
    const connection = asRecord(asRecord(created.json).connection);
    const connectionId = asString(connection.id, "mcp connection id");
    cleanup.unshift(() => ctx.api("DELETE", `/api/script-connections/${connectionId}`));
    expect(
      stub.seen.some((request) => request.headers["x-echo-secret"] === secret),
      "the MCP server never received the resolved header",
    );

    const detail = await ctx.api("GET", `/api/script-connections/${connectionId}`);
    expectStatus(detail, [200], "read the MCP connection");
    expect(
      !detail.text.includes(secret) && detail.text.includes("Echo text back"),
      "the discovered tool list keeps the echoed header value",
    );

    const call = await ctx.api("POST", `/api/script-connections/${connectionId}/mcp-call`, {
      agentId: workerId,
      body: { tool: "echo", arguments: { text: ctx.nonce } },
    });
    expectStatus(call, [200], "mcp-call echo");
    const result = asRecord(call.json);
    const text = String(asRecords(asRecord(result.result), "content")[0]?.text ?? "");
    expect(result.ok === true, `mcp-call echo failed: ${call.text}`);
    expect(text.startsWith(`echo:${ctx.nonce} header:`), `mcp-call lost the tool output: ${text}`);
    expect(!call.text.includes(secret), "mcp-call result keeps the echoed header value");

    const failed = await ctx.api("POST", `/api/script-connections/${connectionId}/mcp-call`, {
      agentId: workerId,
      body: { tool: "fail", arguments: {} },
    });
    expectStatus(failed, [200], "mcp-call fail");
    expect(
      asRecord(failed.json).ok === false && failed.text.includes("upstream rejected"),
      `mcp-call fail lost the error: ${failed.text}`,
    );
    expect(!failed.text.includes(secret), "mcp-call error keeps the echoed header value");
  } finally {
    for (const step of cleanup) await step();
    stub.stop();
  }
}

/** resolveSecrets maps ordinary config keys, never API-only keys, and refuses task tokens. */
async function mcpServerResolution(ctx: ScenarioContext, workerId: string): Promise<void> {
  const ordinaryKey = `E2E_MCP_HEADER_${ctx.nonce.toUpperCase()}`;
  const ordinary = fakeValue("e2e-ordinary");
  const apiOnly = fakeValue("e2e-api-only");
  const cleanup: Array<() => Promise<unknown>> = [];
  let taskId: string | undefined;
  try {
    for (const input of [
      { key: ordinaryKey, value: ordinary },
      { key: "TRANSCRIPTION_API_KEY", value: apiOnly },
    ]) {
      const row = await putConfig(ctx, {
        ...input,
        isSecret: true,
        scope: "agent",
        scopeId: workerId,
      });
      cleanup.unshift(() => deleteConfig(ctx, String(row.id)));
    }
    const server = await ctx.api("POST", "/api/mcp-servers", {
      body: {
        name: `e2e-resolve-mcp-${ctx.nonce}`,
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headerConfigKeys: JSON.stringify({
          "X-Ordinary": ordinaryKey,
          "X-Api-Only": "TRANSCRIPTION_API_KEY",
        }),
      },
    });
    expectStatus(server, [201], "register the MCP server");
    const serverId = asString(asRecord(asRecord(server.json).server).id, "mcp server id");
    cleanup.unshift(() => ctx.api("DELETE", `/api/mcp-servers/${serverId}`));
    expectStatus(
      await ctx.api("POST", `/api/mcp-servers/${serverId}/install`, {
        body: { agentId: workerId },
      }),
      [200],
      "install the MCP server",
    );

    const path = `/api/agents/${workerId}/mcp-servers?resolveSecrets=true`;
    const resolved = await ctx.api("GET", path, { agentId: workerId });
    expectStatus(resolved, [200], "resolveSecrets as the worker");
    const headers = asRecord(
      asRecords(resolved.json, "servers").find((s) => s.id === serverId)?.resolvedHeaders,
    );
    expect(headers["X-Ordinary"] === ordinary, "resolveSecrets lost the ordinary config header");
    expect(
      headers["X-Api-Only"] === undefined && !resolved.text.includes(apiOnly),
      "resolveSecrets resolved an API-only config key",
    );

    taskId = await createAssignedTask(ctx, workerId, `secret egress task ${ctx.nonce}`);
    await claimTask(ctx, workerId, taskId);
    const minted = await ctx.api("POST", "/api/sessions/tokens", {
      body: { agentId: workerId, taskId, ttlMs: 120_000 },
    });
    expectStatus(minted, [200], "mint a task token");
    const taskToken = asString(asRecord(minted.json).plaintext, "task token");
    const viaTask = await ctx.api("GET", path, { apiKey: taskToken });
    expectStatus(viaTask, [403], "resolveSecrets with a task token");
    expect(!viaTask.text.includes(ordinary), "the task token refusal carries a secret");
    expectStatus(
      await ctx.api("GET", `/api/agents/${workerId}/mcp-servers`, { apiKey: taskToken }),
      [200],
      "the plain server list with a task token",
    );
  } finally {
    if (taskId) await ctx.api("POST", `/api/tasks/${taskId}/cancel`, { body: {} });
    for (const step of cleanup) await step();
  }
}

/** A metric run redacts secret-shaped values in its rows and keeps the rest. */
async function metricRun(ctx: ScenarioContext, agentId: string): Promise<void> {
  const token = `ghp_${randomBytes(18).toString("hex")}`;
  const optionSuffix = randomBytes(18).toString("hex");
  const optionToken = `ghp_${optionSuffix}`;
  const created = await ctx.api("POST", "/api/metrics/definitions", {
    agentId,
    body: {
      title: `Secret egress metric ${ctx.nonce}`,
      definition: {
        version: 1,
        // The options query builds its value from parts, so the stored SQL does not hold it.
        variables: [
          {
            key: "pick",
            optionsQuery: {
              sql: `SELECT 'gh' || 'p_' || '${optionSuffix}' AS value UNION ALL SELECT '${ctx.nonce}' AS value`,
              valueKey: "value",
            },
          },
        ],
        widgets: [
          {
            id: "rows",
            title: "Rows",
            query: {
              sql: "SELECT CAST($1 AS text) AS token, CAST($2 AS text) AS plain",
              params: [token, ctx.nonce],
            },
            viz: { type: "table" },
          },
        ],
      },
    },
  });
  expectStatus(created, [201], "create the metric");
  const metricId = asString(asRecord(created.json).id, "metric id");
  try {
    const run = await ctx.api("POST", `/api/metrics/definitions/${metricId}/run`, {
      agentId,
      body: {},
    });
    expectStatus(run, [200], "run the metric");
    const row = asRecords(asRecord(asRecords(run.json, "widgets")[0]?.result), "rows")[0];
    expect(row?.plain === ctx.nonce, `the metric run lost the plain value: ${run.text}`);
    // The response also echoes the stored definition (its params); only the rows are query output.
    expect(
      row?.token !== token && String(row?.token).includes("REDACTED"),
      `the metric run returned a secret-shaped row value unredacted: ${String(row?.token)}`,
    );
    // Variable options are query output too: the secret-shaped one is redacted, the plain one kept.
    expect(
      !run.text.includes(optionToken),
      "the metric run returned a secret-shaped variable option unredacted",
    );
    const definition = asRecord(asRecord(asRecord(run.json).metric).definition);
    const options = asRecords(asRecords(definition, "variables")[0], "options");
    expect(
      options.some((option) => option.value === ctx.nonce),
      `the metric run lost a plain variable option: ${JSON.stringify(options)}`,
    );
  } finally {
    await ctx.api("DELETE", `/api/metrics/definitions/${metricId}`, { agentId });
  }
}

/** Jira status shows the webhook token only to a caller that may read config secrets. */
async function jiraStatus(ctx: ScenarioContext): Promise<void> {
  const webhookToken = randomBytes(24).toString("hex");
  await ctx.restartSut({
    env: {
      JIRA_DISABLE: "false",
      JIRA_CLIENT_ID: fakeValue("e2e-jira-client"),
      JIRA_CLIENT_SECRET: fakeValue("e2e-jira-secret"),
      JIRA_WEBHOOK_TOKEN: webhookToken,
    },
  });
  try {
    // The shared swarm key reads as the operator (as on /api/config/resolved), so the worker
    // case uses an agent-bound token.
    const workerId = await registerWorker(ctx, "jira-status");
    const minted = await ctx.api("POST", `/api/agents/${workerId}/token`, { body: {} });
    expectStatus(minted, [200], "mint a worker token");
    const workerToken = asString(asRecord(minted.json).plaintext, "worker token");
    const asWorker = await ctx.api("GET", "/api/trackers/jira/status", { apiKey: workerToken });
    expectStatus(asWorker, [200], "Jira status as a worker");
    const workerBody = asRecord(asWorker.json);
    expect(
      workerBody.webhookTokenConfigured === true &&
        String(workerBody.webhookUrl).endsWith("/api/trackers/jira/webhook/<redacted>"),
      `the worker Jira status has the wrong webhook URL: ${String(workerBody.webhookUrl)}`,
    );
    expect(!asWorker.text.includes(webhookToken), "the worker Jira status carries the token");

    const asOperator = await ctx.api("GET", "/api/trackers/jira/status");
    expectStatus(asOperator, [200], "Jira status as the operator");
    expect(
      String(asRecord(asOperator.json).webhookUrl).endsWith(
        `/api/trackers/jira/webhook/${webhookToken}`,
      ),
      "the operator Jira status lost the webhook URL to register",
    );
  } finally {
    await ctx.restartSut();
  }
}

/** connect -y ignores .mcp.json and its backup by whole line, and warns when one is tracked. */
async function connectGitignore(ctx: ScenarioContext): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "e2e-connect-git-"));
  try {
    await Bun.write(join(repo, ".gitignore"), "# keep .mcp.json out of git\n.claude/\n");
    await Bun.write(join(repo, ".mcp.json"), `${JSON.stringify({ mcpServers: {} })}\n`);
    await Bun.$`git -C ${repo} init -q && git -C ${repo} add .mcp.json .gitignore`.quiet();
    const env = {
      AGENT_SWARM_API_KEY: ctx.apiKey,
      MCP_BASE_URL: ctx.baseUrl,
      AGENT_ID: crypto.randomUUID(),
      CI: "1",
    };
    const connected = await runCli(["connect", "-y"], { cwd: repo, env });
    expect(
      connected.exitCode === 0,
      `connect -y failed\nstdout:\n${connected.stdout}\nstderr:\n${connected.stderr}`,
    );
    const lines = (await Bun.file(join(repo, ".gitignore")).text()).split("\n");
    expect(
      lines.includes(".mcp.json") && lines.includes(".mcp.json.bak"),
      `.gitignore does not ignore .mcp.json and its backup:\n${lines.join("\n")}`,
    );
    expect(!lines.includes(".claude"), "connect added .claude next to an existing .claude/");
    expect(
      connected.stdout.includes(".mcp.json is tracked by git"),
      `connect did not warn about the tracked .mcp.json\n${connected.stdout}`,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

/**
 * Flow `platform-secret-egress`: values that leave the API are redacted or withheld at the
 * egress point (script MCP proxy, MCP server secret resolution, metric runs, Jira status),
 * and `connect` keeps its token-bearing files out of git.
 */
export const platformSecretEgress: Scenario = {
  name: "platform-secret-egress",
  // Before github-installation-token-repos (656): this scenario restarts the API, and the boot
  // sweep fails in_progress tasks 5 s after a restart. The strict gate needs that status in the
  // final database, so no new restart may come later than the suite's own late restarts.
  order: 637,
  async run(ctx) {
    const workerId = await registerWorker(ctx, "secret-egress");
    await mcpProxyResponses(ctx, workerId);
    await mcpServerResolution(ctx, workerId);
    await metricRun(ctx, workerId);
    await connectGitignore(ctx);
    await jiraStatus(ctx);
  },
};
