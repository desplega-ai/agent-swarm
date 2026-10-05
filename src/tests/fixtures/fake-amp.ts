/**
 * A stand-in for the `amp` CLI, run by Bun (`src/tests/amp-adapter.test.ts`
 * prepends the shebang). It speaks the slice of the protocol the adapter uses,
 * as observed from the real binary (0.0.1791187719-g319a37):
 *
 *   amp usage                      -> exit 0, or 1 with "Invalid or missing API key"
 *   amp threads export <id>        -> thread JSON with per-request usage and model
 *   amp -x --stream-json [...]     -> JSONL events; with --stream-json-input it
 *                                     reads user messages from stdin and emits
 *                                     `result` only once stdin closes.
 *
 * `AMP_TEST_MODE` picks the behaviour, `AMP_TEST_DIR` is where it records what
 * it was given (the adapter deletes its own temp dir when the session ends).
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = process.env.AMP_TEST_MODE ?? "success";
const dir = process.env.AMP_TEST_DIR ?? process.cwd();

const emit = (event: unknown) => console.log(JSON.stringify(event));

if (args[0] === "usage") {
  if (mode === "usage-bad-key") {
    console.error("Error: Invalid or missing API key. Run 'amp login' to authenticate.");
    process.exit(1);
  }
  if (mode === "usage-echo-key") {
    console.error(`Error: Rejected key ${process.env.AMP_API_KEY}`);
    process.exit(1);
  }
  if (mode === "usage-hang") setInterval(() => {}, 1000);
  else {
    console.log("Signed in as someone@example.com\n**Individual credits:** $10 remaining");
    process.exit(0);
  }
}

if (args[0] === "threads" && args[1] === "export") {
  if (mode === "export-fail") process.exit(1);
  console.log(
    process.env.AMP_TEST_EXPORT ??
      JSON.stringify({
        id: args[2],
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            usage: {
              model: "accounts/fireworks/models/glm-5p3-flash",
              inputTokens: 0,
              outputTokens: 5,
              maxInputTokens: 228928,
              totalInputTokens: 1200,
              cacheReadInputTokens: 200,
              cacheCreationInputTokens: 1000,
            },
          },
        ],
      }),
  );
  process.exit(0);
}

if (args[0] !== "usage") await main();

async function main() {
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const read = (path: string | undefined) => {
    try {
      return path ? readFileSync(path, "utf8") : null;
    } catch {
      return null;
    }
  };
  const xdg = process.env.XDG_CONFIG_HOME ?? "";
  const mcpPath = flag("--mcp-config");
  writeFileSync(
    `${dir}/invocation.json`,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      env: {
        XDG_CONFIG_HOME: xdg,
        AMP_SETTINGS_FILE: process.env.AMP_SETTINGS_FILE,
        AMP_API_KEY: process.env.AMP_API_KEY,
      },
      plugin: read(`${xdg}/amp/plugins/agent-swarm.ts`),
      settings: read(flag("--settings-file")),
      mcp: read(mcpPath),
      mcpMode: mcpPath ? (statSync(mcpPath).mode & 0o777).toString(8) : null,
    }),
  );

  const sessionId = "T-fake-session";
  const usage = {
    input_tokens: 4,
    output_tokens: 5,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 200,
  };
  emit({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId,
    tools: ["code_exec", "tool_search"],
    mcp_servers: [{ name: "agent-swarm", status: mode === "mcp-fail" ? "failed" : "connected" }],
    agent_mode: "medium",
  });
  if (mode === "stderr-split-key") {
    // Two pipe chunks, each holding half of the key and neither a secret on its own.
    const key = process.env.AMP_API_KEY ?? "";
    const half = Math.floor(key.length / 2);
    process.stderr.write(`warning: key ${key.slice(0, half)}`);
    await Bun.sleep(150);
    process.stderr.write(`${key.slice(half)} rejected\n`);
    await Bun.sleep(150);
    process.stderr.write(`fatal: ${key.slice(0, half)}`);
    await Bun.sleep(150);
    // The last record has no newline: it reaches the adapter only at EOF.
    process.stderr.write(key.slice(half));
    await Bun.sleep(50);
    process.exit(1);
  }
  if (mode === "bad-key") {
    console.error("Error: Invalid or missing API key. Run 'amp login' to authenticate.");
    process.exit(1);
  }
  if (mode === "mcp-fail" || mode === "hang") {
    setInterval(() => {}, 1000);
    return new Promise(() => {});
  }
  if (mode === "abort") {
    // Amp runs shell commands in a session of its own, outside the process group.
    const child = Bun.spawn(["setsid", "sleep", "300"], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(`${dir}/child.pid`, String(child.pid));
    setInterval(() => {}, 1000);
    return new Promise(() => {});
  }

  const assistant = (content: unknown[], stopReason: string) =>
    emit({
      type: "assistant",
      message: { type: "message", role: "assistant", content, stop_reason: stopReason, usage },
      parent_tool_use_id: null,
      session_id: sessionId,
    });

  let turns = 0;
  let lastText = "";
  const handle = async (text: string, index: number) => {
    emit({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    turns += 1;
    if (mode === "tool" || (mode === "steer" && index === 0)) {
      assistant(
        [{ type: "tool_use", id: "TU-1", name: "code_exec", input: { code: "1+1" } }],
        "tool_use",
      );
      await Bun.sleep(mode === "steer" ? 600 : 10);
      emit({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "TU-1", content: "2", is_error: false }],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
    }
    lastText = mode === "steer" ? `DONE${index + 1}` : "Done ✓";
    assistant([{ type: "text", text: lastText }], "end_turn");
  };

  let buffer = "";
  let queue: Promise<void> = Promise.resolve();
  let index = 0;
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const text = message.message.content[0].text as string;
      const current = index++;
      queue = queue.then(() => handle(text, current));
    }
  }
  await queue;
  const failed = mode === "error-result";
  emit({
    type: "result",
    subtype: failed ? "error_during_execution" : "success",
    is_error: failed,
    duration_ms: 1234,
    num_turns: turns,
    result: failed ? "The model refused" : lastText,
    session_id: sessionId,
  });
  process.exit(failed ? 1 : 0);
}
