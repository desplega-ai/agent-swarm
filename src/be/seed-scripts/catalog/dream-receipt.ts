import { z } from "zod";

export const argsSchema = z.object({
  apply: z.object({
    applied: z.array(z.unknown()).optional(),
    held: z.array(z.unknown()).optional(),
    deferred: z.array(z.unknown()).optional(),
  }),
  date: z.string().optional().describe("Receipt date (default: current ISO date)"),
  runId: z.string().optional().describe("Dream workflow run ID"),
});

function oneLine(value: any): string {
  const agent = value?.agentId ?? value?.delta?.agentId ?? "swarm";
  const kind = value?.kind ?? value?.delta?.kind ?? "delta";
  const reason = value?.reason ? ` — ${String(value.reason)}` : "";
  return `${agent}: ${kind}${reason}`;
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
  const receipt = renderDreamReceipt(parsed.data.apply, date, parsed.data.runId);
  const memory = await ctx.swarm.inject_learning({
    agentId: ctx.stdlib.Redacted.value(ctx.swarm.config.agentId),
    learning: receipt,
    category: "best-practice",
  });
  assertSucceeded(memory, "receipt memory write");

  const configResponse = await ctx.swarm.config_get({ key: "DREAMING_SLACK_CHANNEL" });
  assertSucceeded(configResponse, "Dreaming Slack config read");
  const configs = configRows(configResponse);
  const channelId = configs.find((config) => config?.key === "DREAMING_SLACK_CHANNEL")?.value;
  let slackPosted = false;
  let slackError: string | undefined;
  if (typeof channelId === "string" && channelId.length > 0) {
    try {
      const slack = await ctx.swarm.slack_post({ channelId, message: receipt });
      assertSucceeded(slack, "Dreaming Slack post");
      slackPosted = true;
    } catch (error) {
      slackError = error instanceof Error ? error.message : String(error);
    }
  }
  return { date, receipt, slackPosted, ...(slackError ? { slackError } : {}) };
}
