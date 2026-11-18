import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  cancelQuietly,
  createAssignedTask,
  readTask,
  registerLead,
  registerWorker,
  retireAgent,
} from "./core-helpers";

/**
 * The Lead's Sessions follow-up preamble walks the message's ancestors over
 * `GET /api/tasks/{id}` and keeps the Lead turns (`buildSessionTurnsPreamble`,
 * worker side). It reads `parentTaskId`, `isLeadTask`, `task`, `output` and
 * `attachments` from that response; the Sessions composer picks its parent
 * from `isLeadTask` on `GET /api/sessions/{rootTaskId}`. This pins both.
 */
export const coreSessionFollowupTurns: Scenario = {
  name: "core-session-followup-turns",
  order: 241,
  async run(ctx) {
    const leadId = await registerLead(ctx, "session-turns");
    const workerId = await registerWorker(ctx, "session-turns");
    const ids: string[] = [];
    try {
      // Lead turn -> delegated worker task -> Lead review -> Sessions message.
      const rootId = await createAssignedTask(ctx, leadId, `List the roadmap ${ctx.nonce}`, {
        source: "ui",
      });
      ids.push(rootId);
      const workerTaskId = await createAssignedTask(ctx, workerId, `Research ${ctx.nonce}`, {
        parentTaskId: rootId,
      });
      ids.push(workerTaskId);
      const reviewId = await createAssignedTask(ctx, leadId, `Review ${ctx.nonce}`, {
        parentTaskId: workerTaskId,
      });
      ids.push(reviewId);
      const messageId = await createAssignedTask(ctx, leadId, `make a board ${ctx.nonce}`, {
        parentTaskId: reviewId,
        source: "ui",
      });
      ids.push(messageId);

      // The walk from the message's parent: review (lead) -> worker (not) -> root (lead).
      const expected: [string, boolean, string | undefined][] = [
        [reviewId, true, workerTaskId],
        [workerTaskId, false, rootId],
        [rootId, true, undefined],
      ];
      for (const [id, isLead, parentId] of expected) {
        const task = await readTask(ctx, id);
        expect(task.isLeadTask === isLead, `Task ${id} isLeadTask is ${String(task.isLeadTask)}`);
        expect(
          (task.parentTaskId ?? undefined) === parentId,
          `Task ${id} parentTaskId is ${String(task.parentTaskId)}, expected ${String(parentId)}`,
        );
        expect(typeof task.task === "string", `Task ${id} has no task text`);
        expect(Array.isArray(task.attachments), `Task ${id} has no attachments array`);
      }
      const message = await readTask(ctx, messageId);
      expect(message.source === "ui", `Sessions message source is ${String(message.source)}`);

      // The composer's parent pick reads isLeadTask from the session chain.
      const session = await ctx.api("GET", `/api/sessions/${rootId}`);
      expectStatus(session, [200], "read the session");
      const chain = asRecords(asRecord(session.json), "chain");
      const leadFlags = new Map(chain.map((task) => [String(task.id), task.isLeadTask]));
      for (const [id, isLead] of [
        [rootId, true],
        [workerTaskId, false],
        [reviewId, true],
        [messageId, true],
      ] as const) {
        expect(leadFlags.get(id) === isLead, `Session chain isLeadTask for ${id} is wrong`);
      }
    } finally {
      for (const id of ids.reverse()) await cancelQuietly(ctx, id);
      await retireAgent(ctx, leadId);
      await retireAgent(ctx, workerId);
    }
  },
};
