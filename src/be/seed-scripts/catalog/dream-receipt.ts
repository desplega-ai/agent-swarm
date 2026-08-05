import { z } from "zod";

export const argsSchema = z.object({
  apply: z.object({
    applied: z.array(z.unknown()).optional(),
    held: z.array(z.unknown()).optional(),
    deferred: z.array(z.unknown()).optional(),
    rotationCursor: z
      .object({
        advanced: z.boolean().optional(),
        error: z.string().optional(),
        reason: z.string().optional(),
      })
      .optional(),
  }),
  date: z.string().optional().describe("Receipt date (default: current ISO date)"),
  runId: z.string().optional().describe("Dream workflow run ID"),
});

function oneLine(value: any): string {
  const agent = value?.agentId ?? value?.delta?.agentId ?? "swarm";
  const kind = value?.kind ?? value?.delta?.kind ?? "delta";
  const reason = value?.reason ? ` — ${String(value.reason)}` : "";
  const delta = value?.delta ?? {};
  const details = [
    ["file", value?.file ?? delta.file],
    ["anchor", value?.anchor ?? delta.anchor],
    ["op", value?.op ?? delta.op],
    ["action", value?.action ?? delta.action],
    ["id", value?.id ?? delta.id],
    ["memoryId", value?.memoryId ?? delta.memoryId],
    ["key", value?.key ?? delta.key],
    ["name", value?.name ?? delta.name],
    ["skillId", value?.skillId ?? delta.skillId],
    ["scope", value?.scope ?? delta.scope],
    ["contentHash", value?.contentHash ?? delta.contentHash],
  ]
    .filter((detail) => detail[1] !== undefined)
    .map(([label, nested]) => `${label}=${String(nested)}`);
  const audit = details.length > 0 ? ` [${details.join(", ")}]` : "";
  // A swallowed cursor failure means the same PR gets re-reviewed next run —
  // surface it on the receipt instead of hiding it in the raw apply output.
  const cursorError = value?.cursorError ? ` ⚠ cursor: ${String(value.cursorError)}` : "";
  return `${agent}: ${kind}${reason}${audit}${cursorError}`;
}

/** Render the durable memory/Slack body for a Dreaming apply result. */
export function renderDreamReceipt(apply: any, date: string, runId?: string): string {
  const groups: Array<[string, any[]]> = [
    ["APPLIED", apply?.applied ?? []],
    ["HELD", apply?.held ?? []],
    ["DEFERRED", apply?.deferred ?? []],
  ];
  const lines = [`🌙 Dreaming — ${date}`, ...(runId ? [`Run: ${runId}`] : [])];
  for (const [label, entries] of groups) {
    lines.push(`\n${label} (${entries.length})`);
    lines.push(...(entries.length ? entries.map(oneLine) : ["- none"]));
  }
  // Same posture as the per-delta cursorError: a stalled rotation cursor means
  // the same PR gets re-reviewed next run — say so on the durable receipt.
  if (apply?.rotationCursor?.error) {
    lines.push(`\n⚠ rotation cursor: ${String(apply.rotationCursor.error)}`);
  } else if (apply?.rotationCursor?.reason) {
    // Deliberately held, not failed — no ⚠, but the operator should still see
    // why the rotation did not move tonight.
    lines.push(`\nrotation cursor held: ${String(apply.rotationCursor.reason)}`);
  }
  return lines.join("\n");
}

function configRows(response: any): any[] {
  const payload = response?.data ?? response;
  return payload?.configs ?? [];
}

function assertSucceeded(response: any, action: string): void {
  const payload = response?.data ?? response;
  if (response?.success === false || payload?.success === false) {
    throw new Error(`${action} failed: ${payload?.error ?? response?.error ?? "unknown error"}`);
  }
}

/** Persist a Dreaming receipt and optionally announce it to configured Slack. */
export default async function dreamReceipt(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args || {});
  if (!parsed.success) return { error: `invalid args: ${parsed.error.message}` };
  const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);
  const runId = parsed.data.runId;

  // Crash-recovery re-runs this instant step if the server died between the
  // memory write and the step checkpoint — a per-run KV marker keeps the
  // duplicate receipt memory and duplicate Slack post from landing. Read fails
  // open (an unreachable KV must not silence a fresh receipt).
  // The marker is STAGED so the two side effects dedupe independently: value
  // "memory-written" gates only the memory write (Slack still pending after a
  // crash between them), "done" gates the whole step. Legacy "written" markers
  // are treated as memory-written — resuming Slack beats suppressing it forever.
  const dedupeKey = runId ? `receipt:${runId}` : null;
  let priorStage: string | null = null;
  if (dedupeKey) {
    try {
      const existing = await ctx.swarm.kv_getOrNull({ key: dedupeKey, namespace: "dreaming" });
      const value =
        existing && typeof existing === "object" ? (existing as any).value : existing;
      if (typeof value === "string") priorStage = value;
      if (priorStage === "done") {
        return { date, receipt: null, slackPosted: false, duplicateOfRun: runId };
      }
    } catch {
      // fall through — write the receipt
    }
  }

  const setMarker = async (stage: string) => {
    if (!dedupeKey) return;
    try {
      await ctx.swarm.kv_set({
        key: dedupeKey,
        value: stage,
        namespace: "dreaming",
        expiresInSec: 7 * 24 * 60 * 60,
      });
    } catch {
      // best-effort — a failed marker write only risks a duplicate on recovery
    }
  };

  const memoryAlreadyWritten = priorStage === "memory-written" || priorStage === "written";
  const receipt = renderDreamReceipt(parsed.data.apply, date, runId);
  if (!memoryAlreadyWritten) {
    const memory = await ctx.swarm.inject_learning({
      agentId: ctx.stdlib.Redacted.value(ctx.swarm.config.agentId),
      learning: receipt,
      category: "best-practice",
    });
    assertSucceeded(memory, "receipt memory write");
    await setMarker("memory-written");
  }

  const configResponse = await ctx.swarm.config_get({ key: "DREAMING_SLACK_CHANNEL" });
  assertSucceeded(configResponse, "Dreaming Slack config read");
  const configs = configRows(configResponse);
  const channelId = configs.find((config) => config?.key === "DREAMING_SLACK_CHANNEL")?.value;
  let slackPosted = false;
  if (typeof channelId === "string" && channelId.length > 0) {
    // A Slack failure must FAIL the step: returning it as data would let the
    // executor checkpoint the step as completed and the retry would never
    // happen. The marker stays at "memory-written", so a retried run skips the
    // memory write above and re-attempts only this post.
    const slack = await ctx.swarm.slack_post({ channelId, message: receipt });
    assertSucceeded(slack, "Dreaming Slack post");
    slackPosted = true;
  }
  await setMarker("done");
  return { date, receipt, slackPosted };
}
