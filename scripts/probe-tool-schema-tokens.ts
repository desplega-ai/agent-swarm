#!/usr/bin/env bun
/**
 * Measure what the swarm's MCP tool schemas cost on a harness's first turn.
 *
 * Runs one harness for one turn per leg, with and without the swarm MCP
 * server, behind a local logging proxy. It reports the provider's own
 * turn-1 input tokens (`input_tokens` / `prompt_tokens`), the delta against
 * the no-MCP leg, and how many tools, and swarm tools, the request declared.
 * Every MCP leg also runs a control session that must reach `get-swarm`.
 * Run it on every codex, opencode or pi bump; see
 * runbooks/harness-providers.md. The agent's installed MCP servers load too,
 * so use an agent without them for a swarm-only delta.
 *
 *   bun scripts/probe-tool-schema-tokens.ts --harness codex|pi|opencode [--model <id>]
 *
 * Needs a running swarm API (`MCP_BASE_URL`, the key via getApiKey()) and an
 * agent id (`--agent-id` or `AGENT_ID`). Model keys come from env only:
 * `OPENAI_API_KEY` for codex, `OPENROUTER_API_KEY` for pi and opencode.
 * Nothing secret is written to disk: configs name env vars, and the proxy
 * keeps bodies, not headers. Captures go to ~/.cache/probe-tool-schema-tokens
 * (path printed) and stay there for inspection.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { McpHttpClient } from "../src/mcp-client/http-client";
import type { ProviderAdapter } from "../src/providers/types";
import { getApiKey } from "../src/utils/api-key";

type Harness = "codex" | "pi" | "opencode";

const DEFAULT_MODELS: Record<Harness, string> = {
  codex: "gpt-6.1-sol",
  pi: "openrouter/deepseek/deepseek-v4.1-flash",
  opencode: "openrouter/deepseek/deepseek-v4.1-flash",
};

const UPSTREAMS: Record<Harness, string> = {
  codex: "https://api.openai.com",
  pi: "https://openrouter.ai",
  opencode: "https://openrouter.ai",
};

const PROMPT = "Reply with the single word OK. Do not call any tools.";

/**
 * Positive control for MCP legs: a second session that must reach a swarm
 * tool. Without it, a zero delta cannot tell "deferred" from "never connected".
 * The tool result text ("Found N agent(s) in the swarm") then appears in a
 * later request body.
 */
const CONTROL_PROMPT =
  "Call the agent-swarm tool get-swarm exactly once, then reply with the single word DONE.";
const CONTROL_MARKER = "in the swarm";

interface Leg {
  label: string;
  mcp: boolean;
  env?: Record<string, string>;
}

function legsFor(harness: Harness): Leg[] {
  // The opencode adapter always admits the swarm MCP server, so it has no
  // no-MCP leg; its "swarm tools declared" column carries the measurement.
  if (harness === "opencode") return [{ label: "swarm MCP", mcp: true }];
  const legs: Leg[] = [
    { label: "no MCP", mcp: false },
    { label: "swarm MCP", mcp: true },
  ];
  if (harness === "pi") {
    // pi's deferral is a swarm flag, so measure both settings.
    legs[1] = { label: "swarm MCP, deferral off", mcp: true, env: { PI_TOOL_DEFERRAL: "false" } };
    legs.push({ label: "swarm MCP, deferral on", mcp: true, env: { PI_TOOL_DEFERRAL: "true" } });
  }
  return legs;
}

/** Forwards every request upstream and writes request and response bodies to `capDir`. */
function startProxy(upstream: string, capDir: string) {
  let n = 0;
  return Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : await req.text();
      const i = ++n;
      if (body !== undefined) await Bun.write(join(capDir, `req-${i}.json`), body);
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("content-length");
      const res = await fetch(`${upstream}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body,
      });
      const buf = await res.arrayBuffer();
      await Bun.write(join(capDir, `res-${i}.txt`), new Uint8Array(buf));
      const out = new Headers(res.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(buf, { status: res.status, headers: out });
    },
  });
}

/** Names of the tools declared anywhere in a request body; namespaces list their members. */
export function toolNames(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(toolNames);
  if (!node || typeof node !== "object") return [];
  const names: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "tools" && Array.isArray(value)) {
      for (const tool of value) {
        if (tool && typeof tool === "object" && "tools" in tool) names.push(...toolNames(tool));
        else names.push(String(tool?.function?.name ?? tool?.name ?? ""));
      }
    } else if (typeof value === "object") {
      names.push(...toolNames(value));
    }
  }
  return names;
}

/**
 * Harnesses rename MCP tools (`mcp__agent_swarm__get_swarm`,
 * `agent-swarm_get-swarm`); compare on the bare name, dashes as underscores.
 */
export function bareToolName(name: string): string {
  return (name.split("__").at(-1) ?? name).replace(/^agent[-_]swarm[-_]/, "").replace(/-/g, "_");
}

/** How many of `names` are swarm tools. */
export function countSwarmTools(names: string[], swarm: Set<string>): number {
  return names.filter((name) => swarm.has(bareToolName(name))).length;
}

/** Whether any captured request carries the control tool's result. */
export function controlReached(capDir: string): boolean {
  return readdirSync(capDir)
    .filter((f) => f.startsWith("req-"))
    .some((f) => readFileSync(join(capDir, f), "utf8").includes(CONTROL_MARKER));
}

/** The last provider-reported input token count in a (streamed) response body. */
export function inputTokens(response: string): number | null {
  const matches = [...response.matchAll(/"(?:input_tokens|prompt_tokens)":(\d+)/g)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : null;
}

/**
 * Turn 1 is the first captured request for the probe's model. Harnesses also
 * send side requests (opencode titles a session with a small model).
 */
export function turnOne(
  capDir: string,
  model: string,
): { tokens: number | null; names: string[] } | null {
  const ids = readdirSync(capDir)
    .map((f) => /^req-(\d+)\.json$/.exec(f)?.[1])
    .filter((id): id is string => id !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  const modelId = model.replace(/^openrouter\//, "");
  for (const id of ids) {
    let body: { model?: string };
    try {
      body = JSON.parse(readFileSync(join(capDir, `req-${id}.json`), "utf8"));
    } catch {
      continue;
    }
    if (body.model !== modelId) continue;
    const response = readFileSync(join(capDir, `res-${id}.txt`), "utf8");
    return { tokens: inputTokens(response), names: toolNames(body) };
  }
  return null;
}

async function runCodex(opts: {
  prompt: string;
  model: string;
  proxyUrl: string;
  leg: Leg;
  mcpBaseUrl: string;
  agentId: string;
  home: string;
}) {
  const lines = [
    `model = ${JSON.stringify(opts.model)}`,
    `model_provider = "probe"`,
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    "[model_providers.probe]",
    `name = "probe"`,
    `base_url = "${opts.proxyUrl}/v1"`,
    `env_key = "OPENAI_API_KEY"`,
    `wire_api = "responses"`,
  ];
  if (opts.leg.mcp) {
    lines.push(
      "[mcp_servers.agent-swarm]",
      `url = ${JSON.stringify(`${opts.mcpBaseUrl}/mcp`)}`,
      `bearer_token_env_var = "PROBE_SWARM_BEARER"`,
      `env_http_headers = { "X-Agent-ID" = "PROBE_AGENT_ID" }`,
      "startup_timeout_sec = 30",
    );
  }
  await Bun.write(join(opts.home, "config.toml"), `${lines.join("\n")}\n`);
  const proc = Bun.spawn(["codex", "exec", "--json", "--skip-git-repo-check", opts.prompt], {
    cwd: opts.home,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CODEX_HOME: opts.home,
      PROBE_SWARM_BEARER: getApiKey(),
      PROBE_AGENT_ID: opts.agentId,
    },
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`codex exec exited ${code}: ${stderr.slice(-500)}`);
}

/** Runs pi or opencode in-process, through the real adapter. Called in a child process per leg. */
async function runAdapterLeg(
  harness: "pi" | "opencode",
  model: string,
  agentId: string,
  prompt: string,
) {
  const adapter: ProviderAdapter =
    harness === "pi"
      ? new (await import("../src/providers/pi-mono-adapter")).PiMonoAdapter()
      : new (await import("../src/providers/opencode-adapter")).OpencodeAdapter();
  const cwd = mkdtempSync(join(tmpdir(), `probe-${harness}-cwd-`));
  const session = await adapter.createSession({
    prompt,
    systemPrompt: "You are a measurement probe.",
    model,
    role: "worker",
    agentId,
    taskId: crypto.randomUUID(),
    apiUrl: process.env.PROBE_MCP === "1" ? (process.env.MCP_BASE_URL ?? "") : "",
    apiKey: getApiKey(),
    cwd,
    logFile: join(cwd, "session.jsonl"),
    env: process.env as Record<string, string>,
  });
  const result = await session.waitForCompletion();
  if (result.isError) throw new Error(result.failureReason ?? "session failed");
}

async function main() {
  const { values } = parseArgs({
    options: {
      harness: { type: "string" },
      model: { type: "string" },
      "agent-id": { type: "string" },
      leg: { type: "boolean", default: false },
      control: { type: "boolean", default: false },
    },
  });
  const harness = values.harness as Harness;
  if (!(harness in DEFAULT_MODELS)) {
    console.error("usage: bun scripts/probe-tool-schema-tokens.ts --harness codex|pi|opencode");
    process.exit(2);
  }
  const model = values.model ?? DEFAULT_MODELS[harness];
  const agentId = values["agent-id"] ?? process.env.AGENT_ID ?? "";

  if (values.leg) {
    await runAdapterLeg(
      harness as "pi" | "opencode",
      model,
      agentId,
      values.control ? CONTROL_PROMPT : PROMPT,
    );
    process.exit(0);
  }

  const mcpBaseUrl = process.env.MCP_BASE_URL ?? "http://localhost:3013";
  if (!agentId) throw new Error("pass --agent-id or set AGENT_ID");
  if (!getApiKey()) throw new Error("set AGENT_SWARM_API_KEY or API_KEY");
  // Not under /tmp: codex refuses to install its helper binaries there.
  const cacheDir = join(homedir(), ".cache", "probe-tool-schema-tokens");
  mkdirSync(cacheDir, { recursive: true });
  const root = mkdtempSync(join(cacheDir, `${harness}-`));
  console.error(`captures: ${root}`);

  /** One session for `leg` behind a fresh proxy; returns the capture dir. */
  async function runSession(leg: Leg, name: string, control: boolean): Promise<string> {
    const capDir = join(root, `${name}-cap`);
    const home = join(root, `${name}-home`);
    mkdirSync(capDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    const proxy = startProxy(UPSTREAMS[harness], capDir);
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    try {
      if (harness === "codex") {
        const prompt = control ? CONTROL_PROMPT : PROMPT;
        await runCodex({ prompt, model, proxyUrl, leg, mcpBaseUrl, agentId, home });
        return capDir;
      }
      const args = ["--leg", "--harness", harness, "--model", model];
      if (control) args.push("--control");
      const proc = Bun.spawn(["bun", resolve(import.meta.path), ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...process.env,
          ...leg.env,
          AGENT_ID: agentId,
          MCP_BASE_URL: mcpBaseUrl,
          PROBE_MCP: leg.mcp ? "1" : "0",
          OPENROUTER_BASE_URL: `${proxyUrl}/api/v1`,
        },
      });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 0) throw new Error(`${harness} leg exited ${code}: ${stderr.slice(-500)}`);
      return capDir;
    } finally {
      proxy.stop(true);
    }
  }

  const client = new McpHttpClient(mcpBaseUrl, getApiKey(), agentId, crypto.randomUUID());
  await client.initialize();
  const swarmTools = new Set((await client.listTools()).map((tool) => bareToolName(tool.name)));

  const rows: Array<{
    label: string;
    tokens: number | null;
    tools: number;
    swarm: number;
    control: string;
  }> = [];
  for (const [i, leg] of legsFor(harness).entries()) {
    const capDir = await runSession(leg, `leg-${i}`, false);
    const turn = turnOne(capDir, model);
    if (!turn) throw new Error(`leg "${leg.label}": no request for ${model} in ${capDir}`);
    let control = "n/a";
    if (leg.mcp) {
      control = controlReached(await runSession(leg, `leg-${i}-control`, true)) ? "pass" : "FAIL";
    }
    rows.push({
      label: leg.label,
      tokens: turn.tokens,
      tools: turn.names.length,
      swarm: countSwarmTools(turn.names, swarmTools),
      control,
    });
  }

  const base = rows[0]?.label === "no MCP" ? rows[0].tokens : null;
  const fmt = (n: number | null) => (n === null ? "n/a" : n.toLocaleString("en-US"));
  console.log(`\n${harness} turn 1, model ${model}, ${swarmTools.size} swarm tools\n`);
  console.log(
    "| Leg | input tokens | delta vs no MCP | tools declared | swarm tools declared | swarm tool reached |",
  );
  console.log("|---|---|---|---|---|---|");
  for (const row of rows) {
    const delta = row.tokens !== null && base !== null ? row.tokens - base : null;
    console.log(
      `| ${row.label} | ${fmt(row.tokens)} | ${fmt(delta)} | ${row.tools} | ${row.swarm} | ${row.control} |`,
    );
  }
  if (rows.some((row) => row.control === "FAIL")) {
    console.error(
      "\nA swarm MCP leg never reached get-swarm: its token count is not a measurement.",
    );
    process.exit(1);
  }
}

if (import.meta.main) await main();
