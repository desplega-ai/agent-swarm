import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { listScriptTools } from "@/be/script-tools-db";
import { getScript } from "@/be/scripts/db";
import { runGlobalScriptByName } from "@/be/scripts/run-global";
import { createToolRegistrar } from "@/tools/utils";

/**
 * Extension system, Layer 3: register every enabled script-backed tool
 * (script_tools table) on the given MCP server. Called from createServer(),
 * which runs per MCP session — newly published tools appear on the next
 * session, same freshness contract as prompt/config changes.
 *
 * Input args are passed through to the script unvalidated at the MCP layer
 * (permissive schema); the script's own `argsSchema` (Zod, enforced by the
 * eval harness) is the validation boundary. The script's stored
 * `argsJsonSchema` is appended to the tool description so agents see the
 * expected shape.
 */
export function registerDynamicScriptTools(server: McpServer): number {
  let tools: ReturnType<typeof listScriptTools>;
  try {
    tools = listScriptTools({ enabledOnly: true });
  } catch (err) {
    // DB not migrated/initialized in this context — a server without dynamic
    // tools is better than no server.
    console.error("[ScriptTools] Failed to list script tools:", err);
    return 0;
  }

  const registrar = createToolRegistrar(server);
  let registered = 0;
  for (const tool of tools) {
    const script = getScript({ name: tool.scriptName, scope: "global" });
    if (!script) {
      console.warn(
        `[ScriptTools] Skipping '${tool.toolName}' — script '${tool.scriptName}' missing`,
      );
      continue;
    }
    let description = tool.description;
    if (script.argsJsonSchema) {
      description += `\n\nArgs JSON Schema:\n${script.argsJsonSchema}`;
    }
    registrar(
      tool.toolName,
      {
        title: tool.toolName,
        description,
        annotations: { destructiveHint: false },
        inputSchema: z.record(z.string(), z.unknown()),
        outputSchema: z.object({
          success: z.boolean(),
          result: z.unknown().optional(),
          error: z.string().optional(),
        }),
      },
      async (args, requestInfo) => {
        try {
          const { result } = await runGlobalScriptByName({
            scriptName: tool.scriptName,
            args,
            agentId: requestInfo.agentId ?? tool.createdByAgentId ?? "script-tool",
          });
          return {
            content: [
              {
                type: "text",
                text:
                  result === undefined ? "Script completed (no result)." : JSON.stringify(result),
              },
            ],
            structuredContent: { success: true, result },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Script tool failed: ${message}` }],
            structuredContent: { success: false, error: message },
          };
        }
      },
    );
    registered++;
  }
  return registered;
}
