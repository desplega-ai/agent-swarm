// Fake Claude binary for the background-keepalive wiring tests. It speaks just
// enough of both transports: the SDK initialize handshake on stdin, and the
// stream-json stdout that the CLI and SDK sessions both parse. After one turn it
// goes silent, the way Claude does while it waits on a background job, until the
// test steps it through the control file (one command per line).
const transport = process.env.BG_FIXTURE_TRANSPORT;
const controlFile = process.env.BG_FIXTURE_CONTROL;
const withBackgroundTask = process.env.BG_FIXTURE_BACKGROUND === "1";
const sessionId = "22222222-2222-4222-8222-222222222222";

if (process.argv.includes("--version")) {
  console.log("2.1.263 (Claude Code)");
  process.exit(0);
}

if ((transport !== "cli" && transport !== "sdk") || !controlFile) {
  console.error("BG_FIXTURE_TRANSPORT (cli|sdk) and BG_FIXTURE_CONTROL are required");
  process.exit(2);
}

function writeMessage(message: Record<string, unknown>): void {
  console.log(JSON.stringify(message));
}

function backgroundTasksChanged(tasks: Array<Record<string, unknown>>): void {
  writeMessage({
    type: "system",
    subtype: "background_tasks_changed",
    tasks,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  });
}

const usage = {
  input_tokens: 10,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

let started = false;

async function runTurn(): Promise<void> {
  if (started) return;
  started = true;
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
  if (withBackgroundTask) {
    backgroundTasksChanged([
      { task_id: "bg-1", task_type: "local_bash", description: "Wait for TLC" },
    ]);
  }
  writeMessage({
    type: "assistant",
    message: {
      id: "message-1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text: "Waiting for the background job to finish." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  });
  writeMessage({
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "Waiting for the background job to finish.",
    stop_reason: "end_turn",
    total_cost_usd: 0.001,
    usage,
    modelUsage: {},
    permission_denials: [],
    queued_turn_count: 0,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  });

  // Silent from here on, except for what the test asks for.
  let handled = 0;
  for (;;) {
    const file = Bun.file(controlFile as string);
    const commands = (await file.exists()) ? (await file.text()).split("\n").filter(Boolean) : [];
    while (handled < commands.length) {
      const command = commands[handled++];
      if (command === "empty") backgroundTasksChanged([]);
      if (command === "exit") process.exit(0);
      if (command === "fail") {
        console.error("Error: fixture process crashed");
        process.exit(1);
      }
    }
    await Bun.sleep(10);
  }
}

async function readSdkInput(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line) as {
        type?: string;
        request_id?: string;
        request?: { subtype?: string };
      };
      if (message.type === "control_request" && message.request?.subtype === "initialize") {
        writeMessage({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id ?? "fixture-initialize",
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
      } else if (message.type === "user") {
        void runTurn();
      }
    }
  }
}

// The CLI transport passes the prompt with -p; the SDK sends it on stdin.
if (transport === "sdk") void readSdkInput();
else await runTurn();
