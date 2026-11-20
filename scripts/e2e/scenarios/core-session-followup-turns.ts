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
 * from `isLeadTask` on `GET /api/sessions/{rootTaskId}`. Past its walk, the
 * preamble finds the session's original ask through `GET /api/tasks/{id}/lineage`
 * and renders `task.followup.session_turns`. This pins all of them.
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

      // A chain longer than one lineage read (50 ancestors): the preamble finds
      // the original ask by re-reading lineage from the topmost task returned.
      const originalAsk = `Original ask: plan the launch ${ctx.nonce}`;
      const longRootId = await createAssignedTask(ctx, leadId, originalAsk, { source: "ui" });
      ids.push(longRootId);
      let leafId = longRootId;
      for (let i = 1; i <= 55; i++) {
        leafId = await createAssignedTask(ctx, i % 2 === 0 ? leadId : workerId, `step ${i}`, {
          parentTaskId: leafId,
        });
        ids.push(leafId);
      }
      const readLineage = async (id: string) => {
        const response = await ctx.api("GET", `/api/tasks/${id}/lineage?maxNodes=1&maxDepth=1`);
        expectStatus(response, [200], `read lineage of ${id}`);
        const body = asRecord(response.json);
        return { rootTaskId: String(body.rootTaskId), tasks: asRecords(body, "tasks") };
      };
      const first = await readLineage(leafId);
      expect(first.rootTaskId !== longRootId, "one lineage read reached past the 50-ancestor cap");
      const top = first.tasks.find((row) => row.id === first.rootTaskId);
      expect(Boolean(top?.parentTaskId), "the capped top of the first read has a parent");
      expect(
        first.tasks.every((row) => typeof row.agentId === "string" && "parentTaskId" in row),
        "lineage rows carry agentId and parentTaskId",
      );
      const second = await readLineage(first.rootTaskId);
      expect(second.rootTaskId === longRootId, `second read root is ${second.rootTaskId}`);
      const longRoot = await readTask(ctx, longRootId);
      expect(longRoot.task === originalAsk, "the original ask survives the long chain");

      // The template the worker renders keeps the root, the elision marker and the context pointer.
      const render = await ctx.api("POST", "/api/prompt-templates/render", {
        body: {
          eventType: "task.followup.session_turns",
          variables: {
            turn_count: 1,
            reply_target: "",
            root: `### Original ask (session root) (task \`${longRootId}\`, completed)\n**Asked:** ${originalAsk}\n\n`,
            elided: "### … 21 earlier turns skipped\n\n",
            turns: `### Turn 1 (task \`${leafId}\`, completed)\n`,
          },
          agentId: leadId,
        },
      });
      expectStatus(render, [200], "render the session follow-up template");
      const text = String(asRecord(render.json).text);
      const at = [originalAsk, "21 earlier turns skipped", "### Turn 1"].map((s) =>
        text.indexOf(s),
      );
      expect(
        at[0]! > -1 && at[0]! < at[1]! && at[1]! < at[2]!,
        `root, elision marker and turns render in order: ${text.slice(0, 400)}`,
      );
      expect(
        text.includes("`get-task-details` with any task id above") &&
          text.includes('`name: "task-context-gathering"`') &&
          text.includes('"queries": ["<topic>"]'),
        "the template points at get-task-details and the task-context-gathering script",
      );
    } finally {
      for (const id of ids.reverse()) await cancelQuietly(ctx, id);
      await retireAgent(ctx, leadId);
      await retireAgent(ctx, workerId);
    }
  },
};
