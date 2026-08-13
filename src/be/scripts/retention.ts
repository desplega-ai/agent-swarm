import { collectScriptReferences } from "../../apps/definition";
import { listAppRecords } from "../../apps/store";
import { getDb, listWorkflows } from "../db";

const SCRATCH_RETENTION_DAYS = 14;
const SCRATCH_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

let scratchGcTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Every script id wired into an app definition, as an action or model source.
 *
 * `candidateIds` are the GC-candidate scratch scripts this call cares about.
 * A broken app (invalid stored JSON) decodes with `definition` set to the raw
 * string itself, not a merge-patch object, so `collectScriptReferences` below
 * finds nothing for it. Same substring-probe fallback the interactive delete
 * guard applies via `appScriptReferenceIssues` in src/http/scripts.ts — a
 * broken app is not consent to break it further.
 */
function appReferencedScriptIds(candidateIds: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const app of listAppRecords()) {
    for (const scriptId of collectScriptReferences(app.definition).keys()) {
      ids.add(scriptId);
    }
    if (app.definitionError === undefined) continue;
    const serialized = JSON.stringify(app.definition ?? null);
    for (const id of candidateIds) {
      if (!ids.has(id) && serialized.includes(id)) ids.add(id);
    }
  }
  return ids;
}

/**
 * Every script id bound to a durable public API endpoint. `script_apis.scriptId`
 * cascade-deletes with the script (`ON DELETE CASCADE`, src/be/migrations/102_script_apis.sql),
 * so an unreferenced-looking scratch script backing a live `/api/x/script` endpoint
 * would otherwise be silently deleted out from under it.
 */
function scriptApiReferencedScriptIds(): Set<string> {
  const rows = getDb()
    .prepare<{ scriptId: string }, []>("SELECT DISTINCT scriptId FROM script_apis")
    .all();
  return new Set(rows.map((row) => row.scriptId));
}

/**
 * `(name, agentId)` keys an enabled workflow's `swarm-script` node could resolve at
 * agent scope. A node's `config.scriptName` resolves by NAME, not id
 * (src/workflows/executors/swarm-script.ts `resolveScriptSource`), against the
 * workflow's `createdByAgentId` for `scope: "agent"` or omitted scope — so a
 * name/scope match against a workflow's owner is the only static signal available;
 * `scope: "global"` nodes can never resolve an agent-scoped scratch candidate and
 * are skipped.
 */
function workflowReferencedAgentScriptKeys(): Set<string> {
  const keys = new Set<string>();
  for (const workflow of listWorkflows()) {
    if (!workflow.createdByAgentId) continue;
    for (const node of workflow.definition.nodes) {
      if (node.type !== "swarm-script") continue;
      const scriptName = (node.config as { scriptName?: unknown }).scriptName;
      const scope = (node.config as { scope?: unknown }).scope;
      if (typeof scriptName !== "string" || scope === "global") continue;
      keys.add(`${scriptName}::${workflow.createdByAgentId}`);
    }
  }
  return keys;
}

/**
 * Script names an enabled `swarm-script` node could resolve at agent scope for a
 * workflow with no static owner (`createdByAgentId` null — no `X-Agent-ID` at
 * creation time, or a pre-migration legacy row). `SwarmScriptExecutor` falls back to
 * `trigger.agentId` at run time for these (src/workflows/executors/swarm-script.ts
 * `agentIdFromContext`), so the resolving agent isn't knowable statically — this
 * excludes by NAME alone across every agent scope, which is over-broad (it also
 * protects a same-named scratch script some *other*, unrelated agent owns) but is
 * the only sound static signal available; `scope: "global"` nodes are skipped for
 * the same reason as the owner-keyed variant above.
 */
function workflowReferencedScratchNamesForOwnerlessWorkflows(): Set<string> {
  const names = new Set<string>();
  for (const workflow of listWorkflows()) {
    if (workflow.createdByAgentId) continue;
    for (const node of workflow.definition.nodes) {
      if (node.type !== "swarm-script") continue;
      const scriptName = (node.config as { scriptName?: unknown }).scriptName;
      const scope = (node.config as { scope?: unknown }).scope;
      if (typeof scriptName !== "string" || scope === "global") continue;
      names.add(scriptName);
    }
  }
  return names;
}

/** Delete auto-saved scratch scripts that have not run within the retention window. */
export function purgeExpiredScratchScripts(now = new Date()): number {
  const cutoff = new Date(
    now.getTime() - SCRATCH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const candidates = getDb()
    .prepare<{ id: string; name: string; scopeId: string | null }, [string]>(
      `SELECT id, name, scopeId FROM scripts
       WHERE scope = 'agent'
         AND isScratch = 1
         AND name GLOB 'scratch-*'
         AND updatedAt < ?`,
    )
    .all(cutoff);
  if (candidates.length === 0) return 0;

  // A scratch script still wired into a durable reference — an app action/model
  // source, a public API endpoint, or a workflow's swarm-script node — is no
  // longer "scratch" in effect; deleting it leaves that reference dangling. Same
  // guard the interactive scripts-API delete route enforces for app references via
  // appScriptReferenceIssues, applied here to the whole sweep at once, plus the two
  // durable reference kinds that guard doesn't cover either.
  const referenced = appReferencedScriptIds(candidates.map((row) => row.id));
  const apiReferenced = scriptApiReferencedScriptIds();
  const workflowReferenced = workflowReferencedAgentScriptKeys();
  const ownerlessWorkflowReferencedNames = workflowReferencedScratchNamesForOwnerlessWorkflows();
  const idsToDelete = candidates
    .filter((row) => !referenced.has(row.id))
    .filter((row) => !apiReferenced.has(row.id))
    .filter((row) => !(row.scopeId && workflowReferenced.has(`${row.name}::${row.scopeId}`)))
    .filter((row) => !ownerlessWorkflowReferencedNames.has(row.name))
    .map((row) => row.id);
  if (idsToDelete.length === 0) return 0;

  const placeholders = idsToDelete.map(() => "?").join(",");
  return (
    getDb()
      .prepare<{ id: string }, string[]>(
        `DELETE FROM scripts WHERE id IN (${placeholders}) RETURNING id`,
      )
      // RETURNING counts scripts only; SQLite's change count includes cascaded rows.
      .all(...idsToDelete).length
  );
}

function runScratchScriptGc(label: "Initial" | "Periodic"): void {
  try {
    const purged = purgeExpiredScratchScripts();
    console.log(`[scratch-script-gc] ${label} purge removed ${purged} scratch script row(s)`);
  } catch (err) {
    console.error(`[scratch-script-gc] ${label} purge failed:`, (err as Error).message);
  }
}

/** Start the scratch-script retention GC (daily tick, immediate first run). */
export function startScratchScriptGc(intervalMs = SCRATCH_GC_INTERVAL_MS): void {
  if (scratchGcTimer) return;
  runScratchScriptGc("Initial");
  scratchGcTimer = setInterval(() => runScratchScriptGc("Periodic"), intervalMs);
  if (typeof scratchGcTimer.unref === "function") scratchGcTimer.unref();
}

export function stopScratchScriptGc(): void {
  if (!scratchGcTimer) return;
  clearInterval(scratchGcTimer);
  scratchGcTimer = null;
}
