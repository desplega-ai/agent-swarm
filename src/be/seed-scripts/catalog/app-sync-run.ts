import { z } from "zod";

export const argsSchema = z.object({
  appId: z.string().describe("App id to sync"),
  model: z.string().optional().describe("Only sync this model (default: every model with sources)"),
  source: z.string().optional().describe("Only sync this named source (default: every source)"),
});

/** Run an app's sync passes — the schedulable entry point for refreshing source-backed app rows. */
export default async function appSyncRun(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const { appId, model, source } = parsed.data;
  return await ctx.swarm.app_sync({
    appId,
    ...(model ? { model } : {}),
    ...(source ? { source } : {}),
  });
}
