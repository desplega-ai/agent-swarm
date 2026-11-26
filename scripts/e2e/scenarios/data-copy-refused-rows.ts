import { randomUUID } from "node:crypto";
import { plantRefusedRows } from "../db";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

// db-copy on a SQLite file as a long-lived deployment leaves it: the two tables a
// replication tool (Litestream) adds, a row whose parent is gone, a NUL byte in text, and
// JSON with half of an emoji escape. The copy skips the tool's tables and names every refused
// row in one run without a write. With --repair it fixes those rows during the copy, lists
// each fix, and leaves the SQLite file as it was.

export const dataCopyRefusedRows: Scenario = {
  name: "data-copy-refused-rows",
  order: 9_012,
  async run(ctx) {
    const pair = await ctx.startDataCopy();
    try {
      const api = pair.source;
      const agentId = randomUUID();
      const registered = await api("POST", "/api/agents", {
        agentId,
        body: { name: `refused-worker-${ctx.nonce}`, role: "worker", status: "online" },
      });
      expectStatus(registered, [200, 201], "register agent");
      const taskIds: string[] = [];
      for (const label of ["orphan", "nul", "surrogate"]) {
        const created = await api("POST", "/api/tasks", {
          body: {
            task: `refused ${label} ${ctx.nonce}`,
            agentId,
            routingReason: "human_pinned",
            source: "api",
          },
        });
        expectStatus(created, [201], `create the ${label} task`);
        taskIds.push(String(asRecord(created.json).id));
      }
      const [orphanTask, nulTask, surrogateTask] = taskIds as [string, string, string];
      const planted = { orphan: orphanTask, nul: nulTask, surrogate: surrogateTask };

      const { cli, target, sourceDb } = await pair.copy({
        args: ["--repair"],
        async beforeCopy({ sourcePath, runCopy }) {
          plantRefusedRows(sourcePath, planted);

          const refused = await runCopy();
          const output = `${refused.stderr}\n${refused.stdout}`;
          expect(
            refused.exitCode === 1,
            `db-copy on a file with refused rows exited ${refused.exitCode}, expected 1: ${output.slice(-1500)}`,
          );
          for (const line of [
            "skipped _litestream_seq: Litestream replication bookkeeping",
            "skipped _litestream_lock: Litestream replication bookkeeping",
            "orphan row: no row in users for this foreign key",
            "cannot store agent_tasks.output",
            "NUL byte in text",
            "cannot store agent_tasks.tags",
            "JSON holds an unpaired surrogate escape",
            "3 value(s) cannot be stored in Postgres; nothing was written",
            // After the first refused row the other tables are checked, not written.
            "checked, not written",
          ]) {
            expect(
              output.includes(line),
              `db-copy did not print "${line}": ${output.slice(-2500)}`,
            );
          }
          expect(
            /cannot store agent_tasks\.requestedByUserId \(rowid \d+\): orphan row/.test(output),
            `db-copy did not name the orphan row: ${output.slice(-1500)}`,
          );
          // A refusal by Postgres itself would name no row.
          expect(
            !/invalid input syntax|violates foreign key/.test(output),
            `Postgres refused a row that db-copy should have named first: ${output.slice(-1500)}`,
          );

          // Without --repair the copy says what --repair does.
          expect(
            output.includes("--repair fixes these kinds during the copy"),
            `the refused copy did not name --repair: ${output.slice(-800)}`,
          );
        },
      });

      // The refused copy left the target empty, so this copy is not refused as "holds tables".
      const copied = `${cli.stderr}\n${cli.stdout}`;
      expect(
        cli.exitCode === 0,
        `db-copy --repair exited ${cli.exitCode}: ${cli.stderr.slice(-2000)}${cli.stdout.slice(-1000)}`,
      );
      for (const line of [
        "every count and checksum equal; 3 repair(s) made by --repair",
        "skipped _litestream_seq",
        "): orphan reference set to NULL (no row in users)",
        "): 1 NUL byte(s) removed",
        "): JSON strings made storable",
      ]) {
        expect(
          copied.includes(line),
          `db-copy --repair did not print "${line}": ${copied.slice(-2500)}`,
        );
      }
      expect(
        /repaired agent_tasks\.requestedByUserId \(rowid \d+\)/.test(copied) &&
          /repaired agent_tasks\.output \(rowid \d+\)/.test(copied) &&
          /repaired agent_tasks\.tags \(rowid \d+\)/.test(copied),
        `db-copy --repair did not name each repaired row: ${copied.slice(-2500)}`,
      );

      const nul = await target("GET", `/api/tasks/${nulTask}`);
      expectStatus(nul, [200], "read the repaired NUL task on the copy");
      expect(
        asRecord(nul.json).output === "ab",
        `the repaired output is ${JSON.stringify(asRecord(nul.json).output)} on the copy`,
      );
      const surrogate = await target("GET", `/api/tasks/${surrogateTask}`);
      expectStatus(surrogate, [200], "read the repaired tags task on the copy");
      expect(
        JSON.stringify(asRecord(surrogate.json).tags) === JSON.stringify(["cut \uFFFD"]),
        `the repaired tags are ${JSON.stringify(asRecord(surrogate.json).tags)} on the copy`,
      );
      const orphan = await target("GET", `/api/tasks/${orphanTask}`);
      expectStatus(orphan, [200], "read the repaired orphan task on the copy");
      expect(
        (asRecord(orphan.json).requestedByUserId ?? null) === null,
        `the orphan reference is ${JSON.stringify(asRecord(orphan.json).requestedByUserId)} on the copy`,
      );

      // The SQLite file keeps the rows as they were: the repair is in the copy only.
      const kept = sourceDb.query<{ output: string | null; requestedByUserId: string | null }>(
        `SELECT output, "requestedByUserId" FROM agent_tasks WHERE id IN ('${nulTask}', '${orphanTask}') ORDER BY output IS NULL`,
      );
      expect(
        kept.some((row) => row.output === "a\u0000b") &&
          kept.some((row) => row.requestedByUserId === "user-that-was-deleted"),
        `the SQLite file was changed by --repair: ${JSON.stringify(kept)}`,
      );
    } finally {
      await pair.stop();
    }
  },
};
