import { getLeadAgent } from "../be/db";
import { getSavedScriptOwnerAgentId } from "../be/scripts/run-saved";
import type { ScriptRecord } from "../types";

/**
 * Whose credential and connection bindings a source pull runs with.
 *
 * The script owner when there is one; otherwise the lead, because seeded
 * catalog scripts are owner-less (`scope:"global"`, no `createdByAgentId`) and
 * the whole catalog-source design depends on them being runnable. The literal
 * fallback only applies to a swarm with no lead registered yet.
 *
 * Definition validation and the sync engine both resolve through here so they
 * can never disagree about whose connections count.
 */
export function resolveSyncRunAs(script: ScriptRecord): string {
  return getSavedScriptOwnerAgentId(script) ?? getLeadAgent()?.id ?? "app-sync";
}
