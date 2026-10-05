/**
 * A stand-in for the `amp` CLI, run by Bun (`src/tests/amp-adapter.test.ts`
 * prepends the shebang). It speaks the slice of the protocol the adapter uses,
 * as observed from the real binary (0.0.1791187719-g319a37):
 *
 *   amp usage                      -> exit 0, or 1 with "Invalid or missing API key"
 *   amp threads export <id>        -> thread JSON with per-request usage and model
 *   amp threads usage <id> --details -> `AMP_TEST_USAGE` (markdown), else exit 1
 *   amp -x --stream-json [...]     -> JSONL events; with --stream-json-input it
 *                                     reads user messages from stdin and emits
 *                                     `result` only once stdin closes.
 *
 * The steering modes load the generated plugin and run its `tool.result` hook
 * on each tool result, as Amp does; `steer-crash` exits right after that hook.
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

if (args[0] === "threads" && args[1] === "usage") {
  if (process.env.AMP_TEST_USAGE === undefined) process.exit(1);
  console.log(process.env.AMP_TEST_USAGE);
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
  // Amp runs shell commands in a session of its own, outside the process group.
  // Return only once the child has left: a group kill that lands before its
  // setsid() would take it down and hide a leak.
  const startDetachedChild = async () => {
    const child = Bun.spawn(["setsid", "sleep", "300"], { stdout: "ignore", stderr: "ignore" });
    const session = () => {
      const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
    };
    for (let i = 0; i < 100 && session() !== child.pid; i++) await Bun.sleep(20);
    writeFileSync(`${dir}/child.pid`, String(child.pid));
  };
  if (mode === "mcp-fail-child") await startDetachedChild();
  const mcpFailed = mode === "mcp-fail" || mode === "mcp-fail-child";
  emit({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId,
    tools: ["code_exec", "tool_search"],
    mcp_servers: [{ name: "agent-swarm", status: mcpFailed ? "failed" : "connected" }],
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
  if (mode === "unknown-provider") {
    // Amp fails the pin at once but, like the real CLI, waits for input to end before exiting.
    emit({
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 2027,
      is_error: true,
      num_turns: 0,
      error: "Unknown model provider: qa-bogus",
      session_id: sessionId,
    });
    for await (const _ of Bun.stdin.stream()) {
      // Drain until EOF.
    }
    process.exit(0);
  }
  if (mode === "bad-key") {
    console.error("Error: Invalid or missing API key. Run 'amp login' to authenticate.");
    process.exit(1);
  }
  if (mcpFailed || mode === "hang") {
    setInterval(() => {}, 1000);
    return new Promise(() => {});
  }
  if (mode === "abort") {
    await startDetachedChild();
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

  const hooks = new Map<string, (event: unknown) => unknown>();
  if (mode.startsWith("steer")) {
    const plugin = await import(`${xdg}/amp/plugins/agent-swarm.ts`);
    plugin.default({
      on: (name: string, handler: (event: unknown) => unknown) => hooks.set(name, handler),
      registerAgentMode: () => {},
      createAgent: () => ({ definition: {} }),
    });
  }
  const toolResult = async (output: unknown) => {
    const hooked = (await hooks.get("tool.result")?.({
      toolUseID: "TU-1",
      tool: "code_exec",
      input: {},
      status: "done",
      output,
      thread: { id: sessionId },
    })) as { output?: unknown } | undefined;
    return hooked?.output ?? output;
  };

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
    const steerTool = mode === "steer" || mode === "steer-crash";
    if (mode === "tool" || (steerTool && index === 0)) {
      assistant(
        [{ type: "tool_use", id: "TU-1", name: "code_exec", input: { code: "1+1" } }],
        "tool_use",
      );
      await Bun.sleep(steerTool ? 600 : 10);
      emit({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "TU-1",
              content: await toolResult("2"),
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      // Dies after the hook handed the steer to Amp, before the model answers.
      if (mode === "steer-crash") process.exit(1);
    }
    // A shell command the turn left running, then a clean finish.
    if (mode === "success-child") await startDetachedChild();
    // A turn that thinks for a while with no tool call.
    if (mode === "steer-no-tool") await Bun.sleep(600);
    lastText = mode.startsWith("steer") ? `DONE${index + 1}` : "Done ✓";
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
  if (mode === "linger") {
    // Input closed, but amp never emits `result` or exits: the exit watchdog's case.
    await startDetachedChild();
    setInterval(() => {}, 1000);
    return new Promise(() => {});
  }
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
