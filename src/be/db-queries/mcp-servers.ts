import { getDbClient } from "../db";

/** Active installs per MCP server id. Servers with no install are absent. */
export async function countMcpServerInstalls(): Promise<Map<string, number>> {
  const rows = await getDbClient().query<{ mcpServerId: string; installs: number }>(
    `SELECT mcpServerId, COUNT(*) AS installs
       FROM agent_mcp_servers
      WHERE isActive = 1
      GROUP BY mcpServerId`,
    [],
  );
  return new Map(rows.map((row) => [row.mcpServerId, row.installs]));
}
