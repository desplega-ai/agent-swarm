// Child process for gap-codex-slot-auth-error: run the REAL Codex adapter (bundled codex binary)
// on a pool slot whose stored token is bogus, with an isolated HOME. Prints one JSON line.
// Usage: HOME=<tmp> bun scripts/e2e-gap/codex-slot-probe.ts <apiUrl> <apiKey> <slot|none>
import { mkdirSync, writeSync } from "node:fs";
import { CodexAdapter } from "../../src/providers/codex-adapter";

// The adapter re-runs this entry file as `codex-session-runner`: host it like src/cli.tsx does,
// and never fall through to the probe body (that would respawn itself without end).
if (process.argv[2] === "codex-session-runner") {
  const { runCodexSessionRunner } = await import("../../src/commands/codex-session-runner");
  await runCodexSessionRunner();
  process.exit(0);
}
const [apiUrl, apiKey, slotArg] = process.argv.slice(2);
const home = process.env.HOME as string;
const cwd = `${home}/work`;
mkdirSync(cwd, { recursive: true });
const adapter = new CodexAdapter();
const session = await adapter.createSession({
  prompt: "Reply with the single word ok.",
  systemPrompt: "",
  model: "gpt-5.4",
  role: "worker",
  agentId: "00000000-0000-4000-8000-000000000001",
  taskId: "00000000-0000-4000-8000-000000000002",
  apiUrl,
  apiKey,
  cwd,
  logFile: `${home}/codex.log`,
  env: { HOME: home, PATH: process.env.PATH ?? "" },
  ...(slotArg === "none" ? {} : { codexSlot: Number(slotArg) }),
});
session.onEvent((event) => writeSync(2, `EV ${JSON.stringify(event).slice(0, 300)}\n`));
const result = await Promise.race([
  session.waitForCompletion(),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("probe timeout 90s")), 90_000),
  ),
]);
console.log(
  `PROBE_RESULT ${JSON.stringify({
    isError: result.isError,
    errorCategory: result.errorCategory ?? null,
    failureReason: (result.failureReason ?? "").slice(0, 400),
  })}`,
);
process.exit(0);
