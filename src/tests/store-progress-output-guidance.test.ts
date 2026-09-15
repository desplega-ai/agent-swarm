import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type * as z from "zod";
import { registerStoreProgressTool } from "../tools/store-progress";

describe("store-progress output guidance", () => {
  const server = new McpServer({ name: "output-guidance-test", version: "1.0.0" });
  registerStoreProgressTool(server);
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { inputSchema: z.ZodObject }>;
    }
  )._registeredTools;
  const outputSchema = tools["store-progress"].inputSchema.shape.output;

  test("the exposed output field carries the same budget and exceptions as the prompts", () => {
    expect(outputSchema.description).toContain("Keep free-text output under 120 words by default");
    expect(outputSchema.description).toContain("published verbatim in the thread's outcome card");
    expect(outputSchema.description).toContain("every artifact link");
    expect(outputSchema.description).toContain("Link documents instead of inlining them");
    expect(outputSchema.description).toContain(
      "requested depth, enumerated results, essential evidence",
    );
    expect(outputSchema.description).toContain("the task's outputSchema requires longer output");
    expect(outputSchema.description).toContain("output must be JSON matching it");
  });

  test("the style target does not reject longer requested or schema-constrained output", () => {
    const longResult = "Required result. ".repeat(150);
    for (const output of [longResult, JSON.stringify({ results: [longResult] })]) {
      expect(outputSchema.parse(output)).toBe(output);
    }
  });
});
