import { getApiKey } from "../utils/api-key";
import { scrubObject, scrubSecrets } from "../utils/secret-scrubber";
import { getScriptExecutor } from "./executors/registry";
import {
  DEFAULT_SCRIPT_RESOURCES,
  type ExecutorOutput,
  type ScriptFsMode,
  type ScriptResourcePolicy,
  type SwarmConfigPayload,
} from "./executors/types";
import { validateScriptImports } from "./import-allowlist";

export type RunScriptInput = {
  source: string;
  args?: unknown;
  fsMode?: ScriptFsMode;
  agentId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  mcpBaseUrl?: string;
  resources?: Partial<ScriptResourcePolicy>;
  userConfig?: Record<string, { value: string; isSecret: boolean }>;
};

export type RunScriptOutput = Omit<ExecutorOutput, "result" | "stdout" | "stderr"> & {
  result: unknown | undefined;
  stdout: string;
  stderr: string;
};

function buildConfigPayload(input: RunScriptInput): SwarmConfigPayload {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Swarm API key is required to run scripts");

  return {
    system: {
      apiKey: { value: apiKey, isSecret: true },
      agentId: { value: input.agentId, isSecret: false },
      mcpBaseUrl: {
        value: input.mcpBaseUrl ?? process.env.MCP_BASE_URL ?? "http://localhost:3013",
        isSecret: false,
      },
    },
    user: input.userConfig ?? {},
  };
}

export async function runScript(input: RunScriptInput): Promise<RunScriptOutput> {
  if (input.fsMode === "workspace-rw") {
    return {
      result: undefined,
      stdout: "",
      stderr: "workspace-rw not supported in scripts-runtime v1",
      truncated: { stdout: false, stderr: false },
      durationMs: 0,
      exitCode: 1,
      error: "executor_error",
    };
  }

  const imports = validateScriptImports(input.source);
  if (!imports.ok) {
    return {
      result: undefined,
      stdout: "",
      stderr: imports.diagnostic,
      truncated: { stdout: false, stderr: false },
      durationMs: 0,
      exitCode: 1,
      error: "import_violation",
    };
  }

  const resources = {
    ...DEFAULT_SCRIPT_RESOURCES,
    ...input.resources,
    ...(input.timeoutMs ? { wallClockMs: input.timeoutMs } : {}),
  };

  const output = await getScriptExecutor().run({
    source: input.source,
    args: input.args ?? null,
    configPayload: buildConfigPayload(input),
    resources,
    fsMode: input.fsMode ?? "none",
    network: "open",
    signal: input.signal,
  });

  return {
    ...output,
    result: scrubObject(output.result),
    stdout: scrubSecrets(output.stdout),
    stderr: scrubSecrets(output.stderr),
  };
}
