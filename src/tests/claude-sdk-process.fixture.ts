const mode = process.env.CLAUDE_SDK_FIXTURE_MODE;
const stateFile = process.env.CLAUDE_SDK_FIXTURE_STATE_FILE;
const sessionId = "11111111-1111-4111-8111-111111111111";

if (process.argv.includes("--version")) {
  if (process.env.CLAUDE_SDK_FIXTURE_UNKNOWN_VERSION === "1") process.exit(1);
  console.log("2.1.263 (Claude Code)");
  process.exit(0);
}

if (!mode || !stateFile) {
  console.error("CLAUDE_SDK_FIXTURE_MODE and CLAUDE_SDK_FIXTURE_STATE_FILE are required");
  process.exit(2);
}

function writeMessage(message: Record<string, unknown>): void {
  console.log(JSON.stringify(message));
}

function assistantMessage(text: string, turn: number): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      id: `message-${turn}`,
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: turn * 10,
        output_tokens: turn,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  };
}

function resultMessage(
  result: string,
  turn: number,
  queuedTurnCount: number,
): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    duration_ms: turn,
    duration_api_ms: turn,
    is_error: false,
    num_turns: turn,
    result,
    stop_reason: "end_turn",
    total_cost_usd: turn / 1000,
    usage: {
      input_tokens: turn * 10,
      output_tokens: turn,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    queued_turn_count: queuedTurnCount,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  };
}

function errorResultMessage(): Record<string, unknown> {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    queued_turn_count: 0,
    errors: [],
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  };
}

function emitInit(): void {
  writeMessage({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-haiku-4-5",
    tools: [],
    mcp_servers: [],
    plugins: [],
    permissionMode: "bypassPermissions",
    slash_commands: [],
    apiKeySource: "none",
    cwd: process.cwd(),
    claude_code_version: "2.1.263",
    output_style: "default",
    skills: [],
    uuid: crypto.randomUUID(),
  });
}

function answerInitialize(requestId: string): void {
  writeMessage({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        commands: [],
        agents: [],
        output_style: "default",
        available_output_styles: [],
        models: [],
        account: {},
      },
    },
  });
}

const decoder = new TextDecoder();
let buffer = "";
let initialized = false;
const userMessages: string[] = [];
const argv = process.argv.slice(2);

if (mode === "cancel") {
  const child = Bun.spawn(["/bin/sleep", "60"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await Bun.write(stateFile, JSON.stringify({ fixturePid: process.pid, childPid: child.pid }));
}

async function handleLine(line: string): Promise<boolean> {
  if (!line.trim()) return false;
  const message = JSON.parse(line) as {
    type?: string;
    request_id?: string;
    request?: { subtype?: string };
    message?: { content?: unknown };
  };
  if (message.type === "control_request" && message.request?.subtype === "initialize") {
    answerInitialize(message.request_id ?? "fixture-initialize");
    if (!initialized) {
      initialized = true;
      emitInit();
    }
    return false;
  }
  if (message.type !== "user") return false;
  const content = message.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (block): block is { type: "text"; text: string } =>
                typeof block === "object" &&
                block !== null &&
                (block as { type?: unknown }).type === "text" &&
                typeof (block as { text?: unknown }).text === "string",
            )
            .map((block) => block.text)
            .join("")
        : "";
  userMessages.push(text);

  if (mode === "stderr-error") {
    writeMessage(errorResultMessage());
    await Bun.sleep(25);
    console.error("Error: rate limit exceeded in fixture stderr tail");
    return true;
  }

  if (mode !== "queue" || userMessages.length < 3) return false;
  await Bun.write(stateFile, JSON.stringify({ argv, userMessages }));
  for (let index = 0; index < userMessages.length; index++) {
    const turn = index + 1;
    writeMessage(assistantMessage(`accepted:${userMessages[index]}`, turn));
    writeMessage(resultMessage(`accepted:${userMessages[index]}`, turn, 2 - index));
    if (turn === 2) {
      writeMessage({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 1234, post_tokens: 321 },
        uuid: crypto.randomUUID(),
        session_id: sessionId,
      });
    }
  }
  return true;
}

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (await handleLine(line)) process.exit(0);
    newline = buffer.indexOf("\n");
  }
}

if (buffer.trim()) await handleLine(buffer);
