import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "@/server";
import { closeDb, whenDbReady } from "./be/db";
import {
  enqueueAuditRow,
  flushAuditBuffer,
  startAuditGc,
  startAuditWriter,
  stopAuditGc,
  stopAuditWriter,
} from "./be/rbac-audit";
import { clearAuditSink, setAuditSink } from "./rbac";
import { scrubSecrets } from "./utils/secret-scrubber";

async function main() {
  // createServer() initializes the DB, so this standalone stdio transport OWNS
  // the database and serves the same gated tools as src/http — wire the RBAC
  // permission-audit sink here too (DES-445 Phase 6; plan "stdio blind spot").
  await whenDbReady();
  const server = await createServer();
  setAuditSink(enqueueAuditRow);
  startAuditWriter();
  await startAuditGc();

  const transport = new StdioServerTransport();

  await server.connect(transport);

  await server.sendLoggingMessage({
    level: "info",
    data: "MCP server connected via stdio",
  });
}

// Stdio owns the database until stdin closes or a signal requests shutdown.
let auditDrained = false;
async function drainAudit(): Promise<void> {
  if (auditDrained) return;
  auditDrained = true;
  stopAuditGc();
  stopAuditWriter();
  await flushAuditBuffer();
  clearAuditSink();
  await closeDb();
}
async function shutdown(exitCode?: number): Promise<void> {
  try {
    await drainAudit();
    if (exitCode !== undefined) process.exit(exitCode);
  } catch (error) {
    console.error("[shutdown] Stdio shutdown failed:", scrubSecrets(String(error)));
    process.exit(1);
  }
}
process.on("beforeExit", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown(130);
});
process.on("SIGTERM", () => {
  void shutdown(143);
});

main().catch(console.error);
