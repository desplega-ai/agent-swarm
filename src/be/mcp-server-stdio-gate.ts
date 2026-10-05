import type { McpServer } from "@/types";

/** The fields of an MCP server update that decide whether a stdio command runs, and which one. */
export type McpServerStdioUpdate = {
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  envConfigKeys?: unknown;
  isEnabled?: unknown;
};

const differs = (next: unknown, current: unknown): boolean =>
  next !== undefined && next !== current;

/**
 * True when applying `updates` to `existing` leaves a stdio server whose command, arguments or
 * environment the caller changed, or that the caller switched on. Those changes need
 * `mcp-server.stdio.write`, the same authorization as creating one. Anything that ends as an
 * http or sse server, and switching a stdio server off, stays open to the owner.
 */
export function updateTouchesStdioExecution(
  existing: Pick<McpServer, "transport" | "command" | "args" | "envConfigKeys" | "isEnabled">,
  updates: McpServerStdioUpdate,
): boolean {
  const resulting = updates.transport ?? existing.transport;
  if (resulting === "http" || resulting === "sse") return false;
  return (
    differs(updates.transport, existing.transport) ||
    differs(updates.command, existing.command) ||
    differs(updates.args, existing.args) ||
    differs(updates.envConfigKeys, existing.envConfigKeys) ||
    (updates.isEnabled !== undefined && Boolean(updates.isEnabled) && !existing.isEnabled)
  );
}
