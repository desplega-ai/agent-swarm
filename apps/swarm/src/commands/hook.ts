import { handleHook } from "../hooks/hook";

export async function runHook(): Promise<void> {
  await handleHook();
  process.exit(0);
}
