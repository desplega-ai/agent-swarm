#!/usr/bin/env bun

const write = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

if (process.env.FAKE_ARGS_FILE) {
  await Bun.write(process.env.FAKE_ARGS_FILE, JSON.stringify(Bun.argv.slice(2)));
}
if (process.env.FAKE_PID_FILE) {
  await Bun.write(process.env.FAKE_PID_FILE, String(process.pid));
}

let initialized = false;
let pendingServerRequest: string | number | undefined;
const keepAlive =
  process.env.FAKE_IGNORE_TERM === "true" ? setInterval(() => {}, 1_000) : undefined;
if (keepAlive) process.on("SIGTERM", () => {});

function handle(message: Record<string, unknown>): void {
  if (message.id === "server-request") {
    write({ id: pendingServerRequest, result: { serverReply: message } });
    pendingServerRequest = undefined;
    return;
  }

  if (message.method === "initialize") {
    write({ method: "configWarning", params: { message: "startup warning" } });
    write({ id: message.id, result: { userAgent: "fake-codex/0.153.4" } });
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    return;
  }
  if (!initialized) {
    write({ id: message.id, error: { code: -32000, message: "Not initialized" } });
    return;
  }

  switch (message.method) {
    case "echo":
      write({ id: message.id, result: { params: message.params, initialized } });
      break;
    case "slow":
      setTimeout(() => write({ id: message.id, result: "slow" }), 30);
      break;
    case "fast":
      write({ id: message.id, result: "fast" });
      break;
    case "notify":
      write({ method: "turn/started", params: { turn: { id: "turn-1" } }, emittedAtMs: 123 });
      write({ id: message.id, result: "notified" });
      break;
    case "rpc-error":
      write({
        id: message.id,
        error: { code: -32602, message: "bad params", data: { field: "input" } },
      });
      break;
    case "server-request":
      pendingServerRequest = message.id as string | number;
      write({
        method: "item/commandExecution/requestApproval",
        id: "server-request",
        params: { command: "false" },
      });
      break;
    case "malformed":
      process.stdout.write("{bad json\n");
      break;
    case "exit":
      process.stderr.write(`${process.env.FAKE_SECRET ?? "diagnostic"}\n`);
      setTimeout(() => process.exit(7), 5);
      break;
    case "exit-after-response":
      write({ id: message.id, result: "accepted" });
      setTimeout(() => process.exit(8), 5);
      break;
    case "hang":
      break;
    default:
      write({ id: message.id, result: null });
  }
}

const decoder = new TextDecoder();
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  let newline = buffered.indexOf("\n");
  while (newline !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line) handle(JSON.parse(line) as Record<string, unknown>);
    newline = buffered.indexOf("\n");
  }
}
if (buffered) handle(JSON.parse(buffered) as Record<string, unknown>);
if (keepAlive) await new Promise(() => {});
