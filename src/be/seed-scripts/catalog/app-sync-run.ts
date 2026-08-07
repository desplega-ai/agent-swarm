import { z } from "zod";

export const argsSchema = z.object({
  appId: z.string().describe("App id to sync"),
  model: z.string().optional().describe("Only sync this model (default: every model with sources)"),
  source: z.string().optional().describe("Only sync this named source (default: every source)"),
});

/** Run an app's sync passes — the schedulable entry point for refreshing source-backed app rows. */
export default async function appSyncRun(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) throw new Error("invalid args: " + parsed.error.message);
  const { appId, model, source } = parsed.data;
  const result: any = await ctx.swarm.app_sync({
    appId,
    ...(model ? { model } : {}),
    ...(source ? { source } : {}),
  });
  // The bridge serializes a FAILED sync as structured content in an HTTP 200:
  // returning it would exit 0 and the scheduler would record a successful run.
  // Throw so schedule error accounting sees the failure.
  const payload = result && result.data !== undefined ? result.data : result;
  const failed =
    !result ||
    result.success === false ||
    (payload && (payload.success === false || payload.ok === false));
  if (failed) {
    const why = payload && typeof payload.error === "string" ? payload.error : "sync pass failed";
    throw new Error("app sync failed: " + why);
  }
  return result;
}
