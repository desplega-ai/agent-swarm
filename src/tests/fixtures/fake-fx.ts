/**
 * A fake `fx acp` for adapter tests. Plain newline-delimited JSON-RPC, not the
 * ACP SDK's agent app: fx 0.0.15 takes `systemPrompt` as a bare content-block
 * array, which the SDK's request validation rejects.
 *
 * It answers with the recorded fx 0.0.15 responses and replays the recorded
 * session updates (`fixtures/fx/`). Everything it receives (argv, the fx
 * env, `~/.fx/settings.json`, every request) goes to `capture.json` in its cwd.
 *
 * FAKE_FX_MODE:
 * - `ok` (default): one turn; a steer received during it is echoed where the
 *   recording echoed one, and its request answers `steering: "absorbed"`.
 * - `steer-ignored`: the steer request answers without `_meta.fx.steering`.
 * - `wait-for-cancel`: starts a `sleep` child, then holds the turn until
 *   `session/cancel` and answers `cancelled` with usage.
 * FAKE_FX_MCP_CALL=1: POSTs `tools/list` to the swarm MCP URL it was given.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDir = process.env.FAKE_FX_FIXTURE_DIR ?? "";
const mode = process.env.FAKE_FX_MODE ?? "ok";
const responses = JSON.parse(readFileSync(join(fixtureDir, "acp-responses-recorded.json"), "utf8"));
const updates: Array<Record<string, unknown>> = readFileSync(
  join(fixtureDir, "acp-updates-recorded.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const settingsPath = join(process.env.HOME ?? "", ".fx", "settings.json");
const capture: Record<string, unknown> = {
  argv: process.argv.slice(2),
  env: Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(FX_|OPENROUTER_|OPENAI_|AI_GATEWAY_|ANTHROPIC_|XAI_|CLAUDE_)/.test(key),
    ),
  ),
  settings: existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : null,
  requests: [] as Array<{ method: string; params: unknown }>,
};
const save = () => writeFileSync("capture.json", JSON.stringify(capture));
save();

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (sessionId: string, update: unknown) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

let steerText: string | null = null;
let steerWaiter: (() => void) | null = null;
const steerReplies: Array<() => void> = [];
let cancelTurn: (() => void) | null = null;

async function runTurn(id: number, sessionId: string): Promise<void> {
  if (process.env.FAKE_FX_MCP_CALL === "1") {
    const newSession = (capture.requests as Array<{ method: string; params: any }>).find(
      (request) => request.method === "session/new" || request.method === "session/resume",
    );
    const swarm = newSession?.params.mcpServers.find((server: any) => server.name === "swarm");
    const headers = Object.fromEntries(
      swarm.headers.map((header: { name: string; value: string }) => [header.name, header.value]),
    );
    const response = await fetch(swarm.url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    capture.mcpCall = { url: swarm.url, status: response.status, body: await response.json() };
    save();
  }
  for (const update of updates) {
    const meta = update._meta as { fx?: { steering?: unknown } } | undefined;
    if (update.sessionUpdate === "user_message_chunk" && meta?.fx?.steering) {
      // The recording echoed a steer here. Wait briefly for one to arrive.
      if (steerText === null && mode !== "wait-for-cancel") {
        await new Promise<void>((resolve) => {
          steerWaiter = resolve;
          setTimeout(resolve, 3_000);
        });
      }
      if (steerText === null || mode === "steer-ignored") continue;
      notify(sessionId, { ...update, content: { type: "text", text: steerText } });
      continue;
    }
    notify(sessionId, update);
  }
  if (mode === "wait-for-cancel") {
    const child = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
    capture.childPid = child.pid;
    save();
    await new Promise<void>((resolve) => {
      cancelTurn = resolve;
    });
    send({
      jsonrpc: "2.0",
      id,
      result: { stopReason: "cancelled", usage: { inputTokens: 1200, outputTokens: 30 } },
    });
    return;
  }
  send({ jsonrpc: "2.0", id, result: responses.prompt });
  for (const reply of steerReplies.splice(0)) reply();
}

async function handle(message: any): Promise<void> {
  if (message.method === undefined) return;
  (capture.requests as Array<{ method: string; params: unknown }>).push({
    method: message.method,
    params: message.params,
  });
  save();
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: responses.initialize });
      return;
    case "session/new":
      send({ jsonrpc: "2.0", id, result: responses.newSession });
      return;
    case "session/resume": {
      const { sessionId: _, ...rest } = responses.newSession;
      send({ jsonrpc: "2.0", id, result: rest });
      return;
    }
    case "session/set_config_option":
    case "session/set_mode":
      send({ jsonrpc: "2.0", id, result: { configOptions: responses.newSession.configOptions } });
      return;
    case "session/prompt": {
      if (params._meta?.fx?.steer) {
        steerText = params.prompt[0].text;
        steerWaiter?.();
        steerReplies.push(() =>
          send({
            jsonrpc: "2.0",
            id,
            result: mode === "steer-ignored" ? { stopReason: "end_turn" } : responses.steer,
          }),
        );
        return;
      }
      await runTurn(id, params.sessionId);
      return;
    }
    case "session/cancel":
      cancelTurn?.();
      return;
    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `${method} not supported` } });
      }
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handle(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
}
