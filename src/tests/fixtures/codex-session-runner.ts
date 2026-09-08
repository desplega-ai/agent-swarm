// Protocol double for the isolated Codex session runner.
let configured = false;
let mode = "";
let partial = "";
const decoder = new TextDecoder();
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

for await (const chunk of Bun.stdin.stream()) {
  partial += decoder.decode(chunk, { stream: true });
  let newline = partial.indexOf("\n");
  while (newline !== -1) {
    const line = partial.slice(0, newline);
    partial = partial.slice(newline + 1);
    const message = JSON.parse(line);
    if (!configured) {
      configured = true;
      mode = message.config.prompt;
      write({ kind: "event", event: { type: "session_init", sessionId: "test-codex-thread" } });
    } else if (message.kind === "steer") {
      if (mode === "exit") process.exit(7);
      write({
        kind: "steering-result",
        id: message.id,
        delivery:
          mode === "reject"
            ? { delivered: false, reason: "Turn is no longer active" }
            : { delivered: true, mode: message.delivery.mode },
      });
      write({
        kind: "event",
        event: { type: "message", role: "assistant", content: message.delivery.text },
      });
    } else if (message.kind === "abort") {
      write({ kind: "result", result: { exitCode: 0, isError: false, output: message.reason } });
      process.exit(0);
    }
    newline = partial.indexOf("\n");
  }
}
process.exit(2);
