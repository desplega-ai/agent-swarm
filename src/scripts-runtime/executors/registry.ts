import { NativeScriptExecutor } from "./native";
import { QuickJSScriptExecutor } from "./quickjs";
import type { ScriptExecutor, ScriptExecutorName } from "./types";

const EXECUTORS: Record<ScriptExecutorName, () => ScriptExecutor> = {
  native: () => new NativeScriptExecutor(),
  quickjs: () => new QuickJSScriptExecutor(),
};

export function getDeploymentScriptExecutorName(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SCRIPT_EXECUTOR ?? "native").trim();
}

/**
 * Operator sandbox ceiling: when the deployment sets `SCRIPT_EXECUTOR=quickjs`,
 * individual scripts or agent calls may not escalate to the less-restricted
 * `native` executor. When the deployment runs `native` (the default), scripts
 * may opt down into `quickjs`.
 */
export function isExecutorAllowedByDeployment(
  requested: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!requested) return true;
  if (getDeploymentScriptExecutorName(env) === "quickjs" && requested.trim() === "native") {
    return false;
  }
  return true;
}

function registeredName(name: string): ScriptExecutorName {
  const trimmed = name.trim();
  if (trimmed === "native" || trimmed === "quickjs") return trimmed;
  throw new Error(
    `Unknown SCRIPT_EXECUTOR: ${name}. Available: ${Object.keys(EXECUTORS).join(", ")}`,
  );
}

export function getScriptExecutor(name = process.env.SCRIPT_EXECUTOR ?? "native"): ScriptExecutor {
  return EXECUTORS[registeredName(name)]();
}

export function resolveScriptExecutorName(
  requested?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ScriptExecutorName {
  if (!isExecutorAllowedByDeployment(requested, env)) {
    throw new Error('Executor "native" is not permitted when deployment SCRIPT_EXECUTOR="quickjs"');
  }
  return registeredName(requested ?? env.SCRIPT_EXECUTOR ?? "native");
}

export function resolveScriptExecutor(
  requested?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ScriptExecutor {
  return EXECUTORS[resolveScriptExecutorName(requested, env)]();
}
