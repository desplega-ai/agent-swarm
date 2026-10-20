import { normalizeAssetKey } from "../assets/key";
import { getLeadAgent } from "../be/db";
import { getScriptById } from "../be/scripts/db";
import { getSavedScriptOwnerAgentId, runSavedScriptAsAgent } from "../be/scripts/run-saved";
import { resolveTemplate } from "../prompts/resolver";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { scrubObject } from "../utils/secret-scrubber";
import type { AppActionCaller } from "./action-caller";
import type { AppRecord } from "./store";
import { runAppSync } from "./sync";

/**
 * One `error` string for a sync result, or undefined when every pass succeeded.
 * Each failed pair is named so a multi-pair sync says which one broke; the pass
 * list in `result.passes` carries the rest.
 */
function syncPassError(sync: Awaited<ReturnType<typeof runAppSync>>): string | undefined {
  const failed = sync.passes.filter((pass) => pass.error !== undefined);
  if (failed.length === 0) return undefined;
  return failed.map((pass) => `${pass.model}.${pass.source}: ${pass.error}`).join("; ");
}

export async function runAppAction({
  app,
  name,
  input = {},
  parentTaskId,
  caller,
  actor,
}: {
  app: AppRecord;
  name: string;
  input?: Record<string, unknown>;
  /** Task-kind actions only: chains the created task under an existing one. The HTTP route rejects it (400) for script and sync actions, which never read it. */
  parentTaskId?: string;
  caller: AppActionCaller;
  actor: string;
}) {
  const actions = app.definition.actions;
  if (!actions || !Object.hasOwn(actions, name)) {
    return { status: 404 as const, body: { error: "app action not found" } };
  }

  const action = actions[name]!;

  if (action.kind === "script") {
    const script = await getScriptById(action.scriptId);
    if (!script) {
      return {
        status: 400 as const,
        body: {
          error: "invalid app action",
          issues: [
            {
              path: `actions.${name}.scriptId`,
              message: `script "${action.scriptId}" no longer exists`,
            },
          ],
        },
      };
    }

    // Script actions use the owner's bindings. Definition validation checks
    // which scripts an agent can wire into an app.
    const runAsAgentId = getSavedScriptOwnerAgentId(script);
    if (!runAsAgentId) {
      return {
        status: 400 as const,
        body: { error: "agentId is required: this script has no owning agent to run as" },
      };
    }

    const output = await runSavedScriptAsAgent({
      script,
      input: { ...action.args, ...input, app: { id: app.id }, caller },
      agentId: runAsAgentId,
    });
    const ok = output.exitCode === 0 && !output.error && !output.runtimeError;
    const error = ok
      ? undefined
      : output.runtimeError
        ? `${output.runtimeError.name}: ${output.runtimeError.message}`
        : (output.error ?? `Script exited with code ${output.exitCode}`);
    return {
      status: 200 as const,
      body: scrubObject({
        ok,
        result: output.result,
        stdout: output.stdout,
        ...(error === undefined ? {} : { error }),
        durationMs: output.durationMs,
      }),
    };
  }

  if (action.kind === "sync") {
    const startedAt = Date.now();
    const sync = await runAppSync({
      appId: app.id,
      ...(action.model === undefined ? {} : { model: action.model }),
      ...(action.source === undefined ? {} : { source: action.source }),
      invokedBy: actor,
    });
    const durationMs = Date.now() - startedAt;
    if (sync.issues && sync.issues.length > 0) {
      return { status: 400 as const, body: { error: "invalid sync action", issues: sync.issues } };
    }
    // Deliberately the SCRIPT-action response shape, minus `taskId`:
    // app-surface.tsx branches on `taskId` first, so omitting it gives the
    // dashboard running -> ok/error + refetchAll() with zero UI changes.
    const error = syncPassError(sync);
    return {
      status: 200 as const,
      body: scrubObject({
        ok: sync.ok,
        result: { passes: sync.passes },
        ...(error === undefined ? {} : { error }),
        durationMs,
      }),
    };
  }

  const lead = action.agentId ? null : await getLeadAgent();
  const taskPrompt = resolveTemplate("task.app.action", {
    prompt: action.prompt,
    app_id: app.id,
    action_name: name,
    input_json: JSON.stringify(input),
    caller_json: JSON.stringify(caller),
  });
  const task = await createTaskWithSiblingAwareness(
    taskPrompt.text,
    {
      source: "api",
      agentId: action.agentId ?? lead?.id,
      routingReason: action.agentId ? "human_pinned" : lead ? "skill" : undefined,
      routingSource: action.agentId || lead ? "engine_default" : undefined,
      // App-spawned tasks group under the app's asset namespace so a
      // swarm-tasks source can pull them back via config.assetKey.
      key: normalizeAssetKey(`shared/app:${app.id}/action:${name}/`),
      ...(actor.startsWith("user:") ? { requestedByUserId: actor.slice("user:".length) } : {}),
      ...(parentTaskId ? { parentTaskId } : {}),
    },
    { origin: "app" },
  );
  return {
    status: 200 as const,
    body: { ok: true as const, taskId: task.id, status: task.status },
  };
}
