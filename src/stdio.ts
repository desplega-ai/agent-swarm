import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "@/server";
import { closeDatabase } from "./be/db";
import { setDeploymentEnvReader } from "./be/memory";
import {
  enqueueAuditRow,
  flushAuditBuffer,
  startAuditGc,
  startAuditWriter,
  stopAuditGc,
  stopAuditWriter,
} from "./be/rbac-audit";
import { getDeploymentEnvValue } from "./http/core";
import { clearAuditSink, setAuditSink } from "./rbac";

async function main() {
  // createServer() initializes the DB, so this standalone stdio transport OWNS
  // the database and serves the same gated tools as src/http — wire the RBAC
  // permission-audit sink here too (DES-445 Phase 6; plan "stdio blind spot").
  // Before any embed: the embedding provider exempts only the deployment env's
  // base URL from the SSRF check (same as src/http/index.ts).
  setDeploymentEnvReader(getDeploymentEnvValue);
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

// NOTE: main() resolves right after the transport starts (the process stays
// alive on stdin), so teardown cannot hang off main(): the database stays open
// for the transport lifetime (a Postgres engine does not reopen lazily) and
// closes after the audit drain. Audit and database teardown hang off shutdown:
// the final flush is asynchronous, so it runs from `beforeExit` (stdin closed,
// event loop drained) and from explicit SIGINT/SIGTERM handlers — both of
// which can await it, unlike the `exit` event. Supervisors stop stdio workers
// with SIGTERM; without these handlers up to 199 buffered rows would be lost.
let auditDrained = false;
async function drainAudit(): Promise<void> {
  if (auditDrained) return;
  auditDrained = true;
  stopAuditGc();
  stopAuditWriter();
  await flushAuditBuffer();
  clearAuditSink();
  await closeDatabase();
}
process.on("beforeExit", async () => {
  await drainAudit();
});
process.on("SIGINT", async () => {
  await drainAudit();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await drainAudit();
  process.exit(143);
});

main().catch(console.error);
