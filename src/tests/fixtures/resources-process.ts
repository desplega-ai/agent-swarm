import { closeDb, initDb } from "../../be/db";
import { resolveResourceAccess } from "../../be/resources/access";
import { claimOperation } from "../../be/resources/operations";
import { ResourceService } from "../../be/resources/service";
import { createFakeResourceProvider } from "../../resource-providers/fake";

const [dbPath, agentId, taskId, mode, reference] = Bun.argv.slice(2);
if (!dbPath || !agentId || !taskId) throw new Error("Database, agent, and task are required.");
initDb(dbPath);
const now = () => new Date("2026-11-08T12:00:00.000Z");
const adapter = createFakeResourceProvider("sandbox", now);
let calls = 0;
adapter.create = async () => {
  calls++;
  throw new Error("Admission must not call the provider.");
};
const service = new ResourceService({ ownerId: "swarm-test", now, provider: async () => adapter });
const access = (await resolveResourceAccess({ kind: "agent", agentId }, taskId))!;
try {
  const result =
    mode === "claim"
      ? await claimOperation(reference!, now(), crypto.randomUUID())
      : mode === "resume"
        ? await service.action(access, reference!, "resume", crypto.randomUUID())
        : await service.create(access, {
            kind: "sandbox",
            provider: "fake",
            key: crypto.randomUUID(),
          });
  console.log(JSON.stringify({ accepted: !!result, calls }));
} catch {
  console.log(JSON.stringify({ accepted: false, calls }));
} finally {
  closeDb();
}
