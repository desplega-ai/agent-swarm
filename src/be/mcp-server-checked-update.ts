import type { McpServer } from "@/types";
import { getDbClient, getMcpServerById, updateMcpServer } from "./db";

export type CheckedMcpServerUpdate<Refusal> =
  | { kind: "updated"; server: McpServer }
  | { kind: "not-found" }
  | { kind: "refused"; refusal: Refusal };

/**
 * Applies an MCP server update that the caller must be authorized for. The read `check` decides
 * on, the decision and the write share one BEGIN IMMEDIATE transaction, so a concurrent edit
 * cannot change what the server runs between the decision and the write: the later writer waits,
 * then decides against the row the earlier one committed.
 *
 * `check` returns a refusal to stop the update, or null to allow it. It runs inside the
 * transaction: read only what it needs through the usual helpers (they join the transaction) and
 * do no slow I/O.
 */
export async function updateMcpServerChecked<Refusal>(
  id: string,
  updates: Parameters<typeof updateMcpServer>[1],
  check: (existing: McpServer) => Promise<Refusal | null> | Refusal | null,
): Promise<CheckedMcpServerUpdate<Refusal>> {
  return await getDbClient().transaction(async (): Promise<CheckedMcpServerUpdate<Refusal>> => {
    const existing = await getMcpServerById(id);
    if (!existing) return { kind: "not-found" };

    const refusal = await check(existing);
    if (refusal !== null) return { kind: "refused", refusal };

    const server = await updateMcpServer(id, updates);
    return server ? { kind: "updated", server } : { kind: "not-found" };
  });
}
