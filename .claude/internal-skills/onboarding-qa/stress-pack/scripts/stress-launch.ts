// Start stress workflows without waiting for them. A schedule runs its target
// inline, one schedule at a time, so a slow workflow started directly from a
// schedule holds every other schedule back. This script returns at once and
// the engine walks the runs in the background.
type LaunchArgs = { workflows?: string[] };

export default async function (args: LaunchArgs | undefined, ctx: ScriptContext) {
  return stressRun(ctx, "launch", async (t) => {
    const wanted = args?.workflows ?? [];
    const listed = (await ctx.swarm.workflow_list({})) as Sdk;
    const all: Any[] = Array.isArray(listed.data) ? listed.data : (listed.data?.workflows ?? []);
    const started: Record<string, string> = {};
    for (const name of wanted) {
      const wf = all.find((item) => item.name === name);
      if (!t.ok(`workflow-exists:${name}`, wf?.id, { listStatus: listed.status })) continue;
      const res = (await ctx.swarm.workflow_trigger({
        id: String(wf.id),
        wait: false,
        triggerData: { launchedBy: "stress-launch", at: new Date().toISOString() },
      })) as Sdk;
      t.ok(`trigger-accepted:${name}`, res.status === 201 && typeof res.data?.runId === "string", {
        status: res.status,
        body: JSON.stringify(res.data).slice(0, 200),
      });
      t.ok(`trigger-not-skipped:${name}`, res.data?.skipped === false, {
        skipped: res.data?.skipped,
      });
      if (res.data?.runId) started[name] = res.data.runId;
    }
    return { started };
  });
}
