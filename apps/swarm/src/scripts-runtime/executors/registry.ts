import { NativeScriptExecutor } from "./native";
import type { ScriptExecutor } from "./types";

const EXECUTORS: Record<string, () => ScriptExecutor> = {
  native: () => new NativeScriptExecutor(),
};

export function getScriptExecutor(name = process.env.SCRIPT_EXECUTOR ?? "native"): ScriptExecutor {
  const factory = EXECUTORS[name];
  if (!factory) {
    throw new Error(
      `Unknown SCRIPT_EXECUTOR: ${name}. Available: ${Object.keys(EXECUTORS).join(", ")}`,
    );
  }
  return factory();
}
