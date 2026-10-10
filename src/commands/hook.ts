import { handleHook } from "../hooks/hook";

export async function runHook(): Promise<void> {
  await handleHook();
  // Exit code 2 from a PreToolUse guard blocks the tool call.
  process.exit(process.exitCode ?? 0);
}
