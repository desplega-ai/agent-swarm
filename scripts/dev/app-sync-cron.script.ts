import type { ScriptContext } from "swarm-sdk";

// Spike-3 schedule leg: saved as a swarm script and referenced by a schedule row with
// targetType "script" (scriptName "app-sync-cron", scriptArgs { appId, model?, source? }).
// The schedule runs it in-process on the API host; the script reaches the sync engine
// through the app_sync MCP tool. Runs as the schedule's createdByAgentId — create the
// schedule under a registered agent or the MCP call fails auth.
export default async function appSyncCron(args: any, ctx: ScriptContext) {
  if (!args?.appId) return { error: "appId is required" };
  const res: any = await ctx.swarm.app_sync({
    appId: args.appId,
    ...(args.model ? { model: args.model } : {}),
    ...(args.source ? { source: args.source } : {}),
  });
  return res;
}
