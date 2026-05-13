#!/usr/bin/env bun
import { complete, getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";

const present = (k: string) => (process.env[k] && process.env[k]!.length > 0 ? "set" : "MISSING");
console.log("Credentials snapshot:");
console.log("  OPENROUTER_API_KEY:", present("OPENROUTER_API_KEY"));
console.log("  ANTHROPIC_API_KEY: ", present("ANTHROPIC_API_KEY"));
console.log("  OPENAI_API_KEY:    ", present("OPENAI_API_KEY"));

const summaryTool = {
  name: "record_summary",
  description: "Record a one-line summary of the input.",
  parameters: Type.Object({
    summary: Type.String(),
    confidence: Type.Number(),
  }),
} as const;

const SummaryZod = z.object({
  summary: z.string(),
  confidence: z.number(),
});

async function tryProvider(provider: string, modelId: string, apiKey: string | undefined) {
  if (!apiKey) {
    console.log(`\n--- ${provider}/${modelId}: skipped (no key)`);
    return;
  }
  console.log(`\n--- ${provider}/${modelId}: calling complete() ...`);
  try {
    const model = getModel(provider as never, modelId as never);
    const msg = await complete(
      model,
      {
        systemPrompt: "You always call the record_summary tool. Never reply with text.",
        messages: [{ role: "user", content: "Summarize this in one sentence: 'The cat sat on the mat.'" }],
        tools: [summaryTool],
      },
      { apiKey },
    );
    console.log(`  stopReason: ${msg.stopReason}`);
    console.log(`  content blocks:`, msg.content.map((c: { type: string }) => c.type));
    const toolCall = msg.content.find((c: { type: string }) => c.type === "toolCall") as
      | { type: "toolCall"; name: string; arguments: Record<string, unknown> }
      | undefined;
    if (!toolCall) {
      console.log("  NO TOOL CALL — text-only response:", JSON.stringify(msg.content).slice(0, 300));
      return;
    }
    console.log(`  toolCall.name: ${toolCall.name}`);
    console.log(`  toolCall.arguments:`, toolCall.arguments);
    const parsed = SummaryZod.safeParse(toolCall.arguments);
    console.log(`  zod-validated: ${parsed.success}`);
    if (parsed.success) console.log(`  parsed.data:`, parsed.data);
    else console.log(`  zod error:`, parsed.error.message);
  } catch (err) {
    console.log(`  ERROR:`, (err as Error).message);
  }
}

await tryProvider("openrouter", "google/gemini-3-flash-preview", process.env.OPENROUTER_API_KEY);
await tryProvider("openai", "gpt-5.4-mini", process.env.OPENAI_API_KEY);
await tryProvider("anthropic", "claude-haiku-4-5", process.env.ANTHROPIC_API_KEY);

console.log("\n=== Spike done ===");
