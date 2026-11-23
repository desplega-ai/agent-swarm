import { getStorage } from "../storage";

/** Active installs per MCP server id. Servers with no install are absent. */
export async function countMcpServerInstalls(): Promise<Map<string, number>> {
  const rows = await getStorage().repos.agents.countActiveMcpServerInstalls();
  return new Map(rows.map((row) => [row.mcpServerId, row.installs]));
}
