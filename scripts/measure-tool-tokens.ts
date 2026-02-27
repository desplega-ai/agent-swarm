#!/usr/bin/env bun
/**
 * Measures token overhead from MCP tool definitions.
 *
 * Uses a simple heuristic: ~4 characters per token (GPT/Claude approximation).
 * For exact counts, use tiktoken or the Anthropic tokenizer.
 *
 * Usage: bun scripts/measure-tool-tokens.ts
 */

import { closeDb, initDb } from "../src/be/db";
import { createServer } from "../src/server";
import { CORE_TOOLS, DEFERRED_TOOLS } from "../src/tools/tool-config";

const DB_PATH = "./measure-tokens-temp.sqlite";

// Simple token estimation: ~4 chars per token for English text + JSON
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function main() {
  // Initialize DB and server to get registered tools
  initDb(DB_PATH);
  const server = createServer();

  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;

  const toolNames = Object.keys(tools);

  // Build tool definitions as they'd appear in the tools/list response
  let totalChars = 0;
  let coreChars = 0;
  let deferredChars = 0;
  let coreCount = 0;
  let deferredCount = 0;

  const toolSizes: { name: string; chars: number; tokens: number; classification: string }[] = [];

  for (const name of toolNames) {
    const tool = tools[name] as Record<string, unknown>;
    // Serialize the tool definition as it would appear in the MCP response
    const definition = JSON.stringify({
      name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    });
    const chars = definition.length;
    const tokens = estimateTokens(definition);
    const isCore = CORE_TOOLS.has(name);
    const isDeferred = DEFERRED_TOOLS.has(name);

    totalChars += chars;
    if (isCore) {
      coreChars += chars;
      coreCount++;
    } else if (isDeferred) {
      deferredChars += chars;
      deferredCount++;
    }

    toolSizes.push({
      name,
      chars,
      tokens,
      classification: isCore ? "CORE" : isDeferred ? "DEFERRED" : "UNCLASSIFIED",
    });
  }

  // Sort by size descending
  toolSizes.sort((a, b) => b.chars - a.chars);

  console.log("=== MCP Tool Token Measurement ===\n");
  console.log(`Total registered tools: ${toolNames.length}`);
  console.log(`Core tools: ${coreCount}`);
  console.log(`Deferred tools: ${deferredCount}`);
  console.log();

  const allTokens = Math.ceil(totalChars / 4);
  const coreOnlyTokens = Math.ceil(coreChars / 4);
  const deferredOnlyTokens = Math.ceil(deferredChars / 4);
  const reduction = ((allTokens - coreOnlyTokens) / allTokens) * 100;

  console.log("--- Token Estimates (JSON serialized, ~4 chars/token) ---\n");
  console.log(`All tools:      ~${allTokens.toLocaleString()} tokens (${totalChars.toLocaleString()} chars)`);
  console.log(`Core only:      ~${coreOnlyTokens.toLocaleString()} tokens (${coreChars.toLocaleString()} chars)`);
  console.log(`Deferred only:  ~${deferredOnlyTokens.toLocaleString()} tokens (${deferredChars.toLocaleString()} chars)`);
  console.log(`\nSavings:        ~${(allTokens - coreOnlyTokens).toLocaleString()} tokens (${reduction.toFixed(1)}% reduction)`);

  console.log("\n--- Per-Tool Breakdown (sorted by size) ---\n");
  console.log("  Tool Name".padEnd(35) + "Chars".padStart(8) + "Tokens".padStart(8) + "  Class");
  console.log("-".repeat(70));
  for (const t of toolSizes) {
    const marker = t.classification === "CORE" ? "●" : "○";
    console.log(
      `  ${marker} ${t.name}`.padEnd(35) +
        String(t.chars).padStart(8) +
        String(t.tokens).padStart(8) +
        `  ${t.classification}`,
    );
  }

  // Cleanup
  closeDb();
  const { unlink } = await import("node:fs/promises");
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(DB_PATH + suffix);
    } catch {
      // ignore
    }
  }
}

main().catch(console.error);
