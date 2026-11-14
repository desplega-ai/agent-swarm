import { isExecutorAllowedByDeployment } from "../../scripts-runtime/executors/registry";
import type { ScriptRecord } from "../../types";
import { scrubObject, scrubSecrets } from "../../utils/secret-scrubber";
import { recordInlineScriptRun } from "../db";
import { getScript } from "./db";
import { type ScriptSearchResult, searchScripts } from "./embeddings";
import { runScriptAsUserWithRunCredential } from "./run-credential";
import { refuseSourceWithSecrets } from "./source-secrets";
import { scriptStdlibTypesWithGeneratedApis } from "./typecheck";

/**
 * Code mode on the user MCP: search, type and run scripts as a person, with no
 * agent and no task. A user has no agent scope, so only global scripts are
 * visible. Results mirror the `/api/scripts/*` bodies so the tools render them
 * the same way the agent-side tools do.
 */

/** `script_runs.agentId` for a user MCP run, which has no agent (like "schedule"). */
export const USER_SCRIPT_RUN_AGENT_ID = "user-mcp";

export type UserCodeModeResponse = { status: number; body: unknown };

/** The `/api/scripts/search` result rows, shared with that route. */
export function toScriptSearchResults(matches: ScriptSearchResult[]) {
  return matches.map(({ script, score }) => ({
    name: script.name,
    signature: JSON.parse(script.signatureJson),
    argsJsonSchema: script.argsJsonSchema
      ? (JSON.parse(script.argsJsonSchema) as Record<string, unknown>)
      : null,
    description: script.description,
    score,
  }));
}

export async function searchScriptsForUser(args: {
  query: string;
  limit?: number;
}): Promise<UserCodeModeResponse> {
  const matches = await searchScripts({ query: args.query, scope: "global", limit: args.limit });
  return { status: 200, body: { results: toScriptSearchResults(matches) } };
}

// A user run gets no agent connections or apps, so its types carry none.
const EMPTY_API_TYPES = "export interface ScriptApiRegistry {}\n";
const EMPTY_MCP_TYPES = "export interface ScriptMcpRegistry {}\n";

/**
 * `stdlibTypes` is the whole authoring surface: the `stdlib` module plus the
 * full `swarm-sdk` module, so it alone is enough to write a script.
 */
export async function scriptTypesForUser(name?: string): Promise<UserCodeModeResponse> {
  let script: ScriptRecord | null = null;
  if (name) {
    script = await getScript({ name, scope: "global" });
    if (!script) return { status: 404, body: { error: "Script not found" } };
  }
  const stdlibTypes = await scriptStdlibTypesWithGeneratedApis(
    EMPTY_API_TYPES,
    EMPTY_MCP_TYPES,
    "",
  );
  if (!script) return { status: 200, body: { stdlibTypes } };
  return {
    status: 200,
    body: {
      signature: JSON.parse(script.signatureJson),
      argsJsonSchema: script.argsJsonSchema
        ? (JSON.parse(script.argsJsonSchema) as Record<string, unknown>)
        : null,
      stdlibTypes,
    },
  };
}

export async function runScriptForUser(args: {
  userId: string;
  name?: string;
  source?: string;
  args?: unknown;
}): Promise<UserCodeModeResponse> {
  if (!args.name === !args.source) {
    return { status: 400, body: { error: "Pass exactly one of name or source" } };
  }

  let source = args.source as string;
  let fsMode: ScriptRecord["fsMode"] = "none";
  let executor: ScriptRecord["executor"] = null;
  if (args.name) {
    const script = await getScript({ name: args.name, scope: "global" });
    if (!script) return { status: 404, body: { error: "Script not found" } };
    ({ source, fsMode, executor } = script);
  } else {
    // The run row records the source: refuse an embedded secret before it runs or persists.
    const refusal = refuseSourceWithSecrets(source);
    if (refusal) return { status: 400, body: refusal };
  }
  if (fsMode === "workspace-rw") {
    return { status: 501, body: { error: "workspace-rw scripts are not supported in v1" } };
  }
  if (executor && !isExecutorAllowedByDeployment(executor)) {
    return {
      status: 400,
      body: {
        error: 'Executor "native" is not permitted when deployment SCRIPT_EXECUTOR="quickjs"',
      },
    };
  }

  const startedAt = new Date().toISOString();
  const output = await runScriptAsUserWithRunCredential(
    { source, args: args.args, fsMode, executor },
    args.userId,
  );
  const ok = output.exitCode === 0 && !output.error && !output.runtimeError;
  try {
    await recordInlineScriptRun({
      id: crypto.randomUUID(),
      agentId: USER_SCRIPT_RUN_AGENT_ID,
      requestedByUserId: args.userId,
      createdBy: args.userId,
      source,
      args: scrubObject(args.args ?? null),
      scriptName: args.name ?? "(inline source)",
      status: ok ? "completed" : "failed",
      output: scrubObject(output.result),
      error: ok
        ? undefined
        : scrubSecrets(
            [
              output.error,
              output.stderr || undefined,
              output.runtimeError
                ? `${output.runtimeError.name}: ${output.runtimeError.message}`
                : undefined,
            ]
              .filter(Boolean)
              .join(" — ") || `Script exited with code ${output.exitCode}`,
          ),
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  } catch {
    // The run already executed; the row is observability only.
  }

  return {
    status: 200,
    body: scrubObject({
      result: output.result,
      truncated: output.truncated,
      durationMs: output.durationMs,
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: output.exitCode,
      error: output.error,
      runtimeError: output.runtimeError,
    }),
  };
}
