import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../api/types";
import { formatSpan } from "./format-duration-ms";
import {
  approvalsByPart,
  buildTurns,
  hasHandoffs,
  partSteps,
  type SessionTurns,
  type TurnPart,
  workerSummary,
} from "./session-turns";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const LEAD = "lead";

// The timeline kinds of the mockup data `demo-data-big.js`
// (agent-fs `/mockups/agent-swarm/sessions-v2/`).
type Item =
  | { kind: "human"; who: string; ago: number; text: string; via?: "slack" }
  | { kind: "reply"; who: string; ago: number; text: string }
  | { kind: "lead"; ago: number; status: string; text: string }
  | { kind: "work"; agent: string; taskType: string; ago: number; status: string; text: string }
  | { kind: "internal"; type: string; ago: number; text: string };

const h = (who: string, ago: number, text: string, via?: "slack"): Item => ({
  kind: "human",
  who,
  ago,
  text,
  via,
});
const rp = (who: string, ago: number, text: string): Item => ({ kind: "reply", who, ago, text });
const l = (ago: number, status: string, text: string): Item => ({
  kind: "lead",
  ago,
  status,
  text,
});
const w = (agent: string, taskType: string, ago: number, status: string, text: string): Item => ({
  kind: "work",
  agent,
  taskType,
  ago,
  status,
  text,
});
const fu = (ago: number, text: string): Item => ({
  kind: "internal",
  type: "follow-up",
  ago,
  text,
});
const it = (type: string, ago: number, text: string): Item => ({
  kind: "internal",
  type,
  ago,
  text,
});

const STATUS: Record<string, AgentTask["status"]> = {
  completed: "completed",
  failed: "failed",
  running: "in_progress",
};

function task(fields: Partial<AgentTask> & Pick<AgentTask, "id" | "createdAt">): AgentTask {
  return {
    key: "shared/northwind/pricing/",
    agentId: LEAD,
    task: "",
    status: "completed",
    source: "mcp",
    tags: [],
    priority: 50,
    dependsOn: [],
    lastUpdatedAt: fields.createdAt,
    isLeadTask: true,
    ...fields,
  };
}

/**
 * Converts demo items to a chain the way the swarm writes one:
 * - A person's message is one lead task. Its output is the reply.
 * - Each worker completion wakes the lead with a `system` follow-up under
 *   that worker. A later lead line is the output of the lead task it came
 *   from: the last follow-up, or the wake-up.
 * - The demo's `deferred` / `resume` pair is one wake-up: the schedule
 *   creates a `deferred` task when it fires, under the task that waited, and
 *   its output is the resumed answer.
 * - Workers hang under the lead task that sent them. A step ends at the next
 *   item that is not a worker, as in the mockup (`stepEnd`).
 */
function toChain(items: Item[]): AgentTask[] {
  const chain: AgentTask[] = [];
  let n = 0;
  let delegator: AgentTask | null = null;
  let lastLead: AgentTask | null = null;
  let waiting: AgentTask | null = null;
  const awaitingFollowUp: AgentTask[] = [];
  items.forEach((item, index) => {
    const id = `t${++n}`;
    const createdAt = at(item.ago);
    const leaf = chain.at(-1);
    if (item.kind === "human" || item.kind === "reply") {
      const next = items[index + 1];
      const reply = next?.kind === "lead" ? next : null;
      const t = task({
        id,
        createdAt,
        source: item.kind === "human" && item.via === "slack" ? "slack" : "ui",
        requestedByUserId: item.who,
        task: item.text,
        parentTaskId: leaf?.id,
        status: reply ? STATUS[reply.status] : "pending",
        output: reply?.status === "completed" ? reply.text : undefined,
      });
      chain.push(t);
      delegator = t;
      lastLead = t;
      awaitingFollowUp.length = 0;
      return;
    }
    if (item.kind === "lead") {
      const previous = items[index - 1];
      if (previous?.kind === "human" || previous?.kind === "reply") return;
      if (lastLead) {
        lastLead.output = item.text;
        lastLead.status = STATUS[item.status];
        delegator = lastLead;
      }
      return;
    }
    if (item.kind === "work") {
      let end: number | null = null;
      for (const later of items.slice(index + 1)) {
        if (later.kind === "work") continue;
        if (later.ago < item.ago) end = NOW - later.ago * 60_000;
        break;
      }
      const t = task({
        id,
        createdAt,
        agentId: item.agent,
        isLeadTask: false,
        taskType: item.taskType,
        task: `Do ${item.taskType}`,
        parentTaskId: delegator?.id,
        status: STATUS[item.status],
        ...(item.status === "completed" ? { output: item.text } : {}),
        ...(item.status === "failed" ? { failureReason: item.text } : {}),
        ...(end && item.status !== "running" ? { finishedAt: new Date(end).toISOString() } : {}),
      });
      chain.push(t);
      if (item.status !== "running") awaitingFollowUp.push(t);
      return;
    }
    if (item.type === "follow-up") {
      // Failed tries that were retried got no follow-up in the demo data.
      const worker = awaitingFollowUp.find((t) => t.status === "completed") ?? awaitingFollowUp[0];
      awaitingFollowUp.splice(awaitingFollowUp.indexOf(worker), 1);
      const t = task({
        id,
        createdAt,
        source: "system",
        taskType: "follow-up",
        task: "Worker task completed, review needed.",
        parentTaskId: worker.id,
        output: item.text,
      });
      chain.push(t);
      delegator = t;
      lastLead = t;
      return;
    }
    if (item.type === "deferred") {
      waiting = lastLead;
      return;
    }
    const wake = item.type === "resume" && waiting;
    const t = task({
      id,
      createdAt,
      source: wake ? "schedule" : "system",
      taskType: wake ? "deferred" : item.type,
      task: item.text,
      parentTaskId: (wake ? waiting : lastLead)?.id,
      output: item.text,
    });
    waiting = null;
    chain.push(t);
    delegator = t;
    lastLead = t;
  });
  return chain;
}

// sB1 "Q4 pricing page rewrite" (dashboard, Taras and Lena take turns).
const SB1 = toChain([
  h("taras", 1560, "Rewrite the pricing page for Q4."),
  l(1558, "completed", "Plan: research competitor tiers, draft copy, review."),
  w("researcher", "research", 1556, "completed", "Compared 6 competitors."),
  w("writer", "content", 1556, "completed", "Draft v1: three tiers."),
  fu(1530, "Researcher finished. The lead merged the findings into the plan."),
  fu(1528, "Writer finished. The lead queued a review."),
  l(1527, "completed", "Draft v1 is ready. Lena, can you review the copy?"),
  h("lena", 1440, "The Scale tier reads like enterprise."),
  l(1438, "completed", "Renaming Scale to Business. Sending it back to the Writer."),
  w("writer", "content", 1436, "completed", "Draft v2: Business tier."),
  fu(1418, "Writer finished. The lead sent draft v2 to the Reviewer."),
  w("reviewer", "review", 1416, "completed", "Brand review: 3 issues."),
  fu(1398, "Reviewer finished. The lead asked the Writer to fix the 3 issues."),
  w("writer", "review-fix", 1396, "failed", "Could not open the brand guide."),
  w("writer", "review-fix", 1380, "completed", "Fixed the 3 review issues."),
  fu(1379, "Writer finished. The lead checked the fixes."),
  l(1378, "completed", "Draft v3 passes review. I will check tomorrow morning."),
  it("deferred", 1377, "The lead scheduled a wake-up for tomorrow 09:00."),
  it("resume", 900, "Wake-up at 09:00. The lead resumed the session."),
  l(899, "completed", "Finance confirmed the numbers. Updating the table."),
  w("writer", "content", 897, "completed", "Team price set to 32 per seat."),
  fu(880, "Writer finished. The lead checked the table."),
  l(879, "completed", "The table now shows 32 per seat for Team. Nothing else changed."),
  h("taras", 600, "Add a toggle for monthly and annual."),
  l(598, "completed", "Adding the toggle. Sending it to the Coder."),
  w("coder", "implementation", 596, "failed", "Build failed: single price field."),
  w("coder", "implementation", 560, "failed", "Build failed again: a snapshot test."),
  w("coder", "implementation", 520, "completed", "Toggle added, annual is the default."),
  fu(500, "Coder finished. The lead opened the preview."),
  l(499, "completed", "The toggle is live in the preview. It took three tries."),
  h("lena", 8, "Looks good. Last thing: the FAQ answer about refunds is too long."),
  l(7, "completed", "Shortening the refund answer. Sending it to the Writer."),
  w("writer", "content", 4, "running", "Editing the refund answer."),
]);

// sB2 "Release checklist for v2.5" (Slack thread, Marco and Taras, plus one dashboard reply).
const SB2 = toChain([
  h("marco", 260, "@swarm can you run the release checklist for v2.5?", "slack"),
  l(258, "completed", "Running it: four workers in parallel."),
  w("coder", "implementation", 257, "completed", "Changelog drafted from 23 merged PRs."),
  w("reviewer", "review", 257, "completed", "Migration 241 is additive."),
  w("researcher", "research", 257, "completed", "Dependency audit: 2 minor bumps."),
  w("coder", "docs", 256, "failed", "The docs link check timed out."),
  w("coder", "docs", 250, "completed", "Docs link check passed after a retry."),
  fu(246, "Coder finished the changelog."),
  fu(245, "Reviewer finished."),
  fu(244, "Researcher finished."),
  fu(243, "Coder finished the link check."),
  l(242, "completed", "The checklist is green."),
  h("taras", 238, "also bump the chart version please", "slack"),
  l(237, "completed", "Adding the chart bump. Sending it to the Coder."),
  w("reviewer", "review", 236, "completed", "Chart lint is clean."),
  w("coder", "implementation", 236, "failed", "The OpenAPI spec was stale."),
  w("coder", "implementation", 230, "failed", "appVersion did not match."),
  w("coder", "implementation", 220, "completed", "Bumped the chart. All checks pass."),
  fu(219, "Reviewer finished. The lead waited for the Coder."),
  fu(218, "Coder finished. The lead checked the chart version."),
  l(217, "completed", "The chart is bumped to 2.5.0 and all checks pass."),
  h("marco", 200, "can we get release notes for the blog too?", "slack"),
  l(199, "completed", "Sending the highlights to the Researcher and the draft to the Writer."),
  w("researcher", "research", 198, "completed", "Pulled 5 highlights."),
  w("writer", "content", 190, "failed", "The draft is 1,900 words."),
  w("writer", "content", 182, "completed", "Release notes drafted: 640 words."),
  w("reviewer", "review", 181, "completed", "1 claim needs a link."),
  fu(180, "Researcher finished."),
  fu(179, "Writer finished."),
  fu(178, "Reviewer finished."),
  l(177, "completed", "Release notes are ready."),
  h("marco", 150, "smoke test on staging?", "slack"),
  l(149, "completed", "Running it now."),
  w("reviewer", "review", 148, "completed", "Staging config matches."),
  w("coder", "test", 148, "failed", "Smoke test timed out."),
  w("coder", "test", 135, "failed", "Smoke test timed out again."),
  w("coder", "test", 120, "completed", "Staging smoke test passed: 42 of 42."),
  fu(119, "Reviewer finished."),
  fu(118, "Coder finished."),
  l(117, "completed", "The staging smoke test passed on the third run."),
  rp("taras", 100, "Run it again against the release candidate build."),
  l(99, "completed", "Running the smoke test against the release candidate."),
  w("coder", "test", 98, "completed", "Release candidate smoke test: 42 of 42."),
  w("reviewer", "review", 97, "completed", "p95 is 4% lower."),
  fu(57, "Coder finished."),
  fu(56, "Reviewer finished."),
  l(55, "completed", "The release candidate passes. The release is ready."),
]).map((t, i) => (i === 0 ? { ...t, key: "shared/slack/c0a1eng/thread:1/" } : t));

const summary = (part: TurnPart) => workerSummary(part, NOW);
const span = (part: TurnPart) => formatSpan(summary(part)?.durationMs ?? 0);
const stepShape = (part: TurnPart) =>
  partSteps(part).map((s) => `${s.agentId}:${s.taskType}:${s.tries.length}`);
/** The answers a part shows: the reply, then the result. */
const answers = (part: TurnPart) => [part.reply.output, part.result?.output];

/** Every task sits in exactly one place: a reply, a try, a handoff, a result, a live line, or rest. */
function placedIds({ turns, rest }: SessionTurns): string[] {
  return [
    ...turns.flatMap((turn) =>
      turn.parts.flatMap((part) => [
        part.reply.id,
        ...partSteps(part).flatMap((step) => step.tries.map((t) => t.id)),
        ...part.internal.map((t) => t.id),
        ...(part.result ? [part.result.id] : []),
        ...(part.live ? [part.live.id] : []),
      ]),
    ),
    ...rest.map((t) => t.id),
  ];
}

describe("buildTurns on sB1 (dashboard, two people)", () => {
  const model = buildTurns(SB1);
  const { turns, rest } = model;

  test("a turn per person message, with the person's own task as the first reply", () => {
    expect(rest).toEqual([]);
    expect(turns.map((t) => t.person?.requestedByUserId)).toEqual([
      "taras",
      "lena",
      "taras",
      "lena",
    ]);
    for (const turn of turns) expect(turn.parts[0].reply).toBe(turn.person as AgentTask);
    expect(turns.map((t) => t.parts.length)).toEqual([1, 2, 1, 1]);
  });

  test("each part shows its reply and its latest completed answer, as the mockup does", () => {
    expect(answers(turns[0].parts[0])).toEqual([
      "Plan: research competitor tiers, draft copy, review.",
      "Draft v1 is ready. Lena, can you review the copy?",
    ]);
    // Lena's turn: the overnight wake-up opens a second part.
    expect(answers(turns[1].parts[0])).toEqual([
      "Renaming Scale to Business. Sending it back to the Writer.",
      "Draft v3 passes review. I will check tomorrow morning.",
    ]);
    expect(answers(turns[1].parts[1])).toEqual([
      "Finance confirmed the numbers. Updating the table.",
      "The table now shows 32 per seat for Team. Nothing else changed.",
    ]);
    expect(turns[1].parts[1].reply.taskType).toBe("deferred");
    expect(answers(turns[2].parts[0])[1]).toBe(
      "The toggle is live in the preview. It took three tries.",
    );
    expect(turns[3].parts[0].result).toBeUndefined();
    // Status notes that only sent more work stay with the handoffs.
    expect(turns[1].parts[0].internal.map((t) => t.output)).toEqual([
      "Writer finished. The lead sent draft v2 to the Reviewer.",
      "Reviewer finished. The lead asked the Writer to fix the 3 issues.",
    ]);
    expect(turns[0].parts[0].internal.map((t) => t.taskType)).toEqual(["follow-up"]);
    expect(hasHandoffs(turns)).toBe(true);
  });

  test("worker lines match the mockup spans: one per part, never across the wait", () => {
    // "2 workers worked for 26m"
    expect(summary(turns[0].parts[0])).toMatchObject({
      agentIds: ["researcher", "writer"],
      state: "done",
      retries: 0,
    });
    expect(span(turns[0].parts[0])).toBe("26m");
    // "2 workers worked for 57m · 1 retry", then "Writer worked for 17m".
    expect(stepShape(turns[1].parts[0])).toEqual([
      "writer:content:1",
      "reviewer:review:1",
      "writer:review-fix:2",
    ]);
    expect(summary(turns[1].parts[0])).toMatchObject({
      agentIds: ["writer", "reviewer"],
      retries: 1,
    });
    expect(span(turns[1].parts[0])).toBe("57m");
    expect(stepShape(turns[1].parts[1])).toEqual(["writer:content:1"]);
    expect(span(turns[1].parts[1])).toBe("17m");
    // "Coder worked for 1h 36m · 2 retries"
    expect(stepShape(turns[2].parts[0])).toEqual(["coder:implementation:3"]);
    expect(summary(turns[2].parts[0])).toMatchObject({ retries: 2, state: "done" });
    expect(span(turns[2].parts[0])).toBe("1h 36m");
    // "Writer is working · 4m"
    expect(summary(turns[3].parts[0])).toMatchObject({
      state: "working",
      activeAgentIds: ["writer"],
    });
    expect(span(turns[3].parts[0])).toBe("4m");
  });

  test("every task sits in one place", () => {
    const ids = placedIds(model);
    expect(ids.length).toBe(SB1.length);
    expect(new Set(ids).size).toBe(SB1.length);
  });
});

describe("buildTurns on sB2 (Slack thread, a dashboard reply)", () => {
  const model = buildTurns(SB2);
  const { turns, rest } = model;

  test("Slack messages and the dashboard reply each open a turn", () => {
    expect(rest).toEqual([]);
    expect(turns.map((t) => `${t.person?.source}:${t.person?.requestedByUserId}`)).toEqual([
      "slack:marco",
      "slack:taras",
      "slack:marco",
      "slack:marco",
      "ui:taras",
    ]);
    expect(turns.every((t) => t.parts.length === 1)).toBe(true);
  });

  test("parallel workers, retries, spans, and answers", () => {
    const parts = turns.map((t) => t.parts[0]);
    expect(stepShape(parts[0])).toEqual([
      "coder:implementation:1",
      "reviewer:review:1",
      "researcher:research:1",
      "coder:docs:2",
    ]);
    expect(summary(parts[0])).toMatchObject({
      agentIds: ["coder", "reviewer", "researcher"],
      retries: 1,
    });
    expect(span(parts[0])).toBe("11m");
    expect(summary(parts[1])).toMatchObject({ agentIds: ["reviewer", "coder"], retries: 2 });
    expect(summary(parts[2])).toMatchObject({ agentIds: ["researcher", "writer", "reviewer"] });
    expect(summary(parts[3])?.retries).toBe(2);
    expect(parts.map((p) => p.result?.output)).toEqual([
      "The checklist is green.",
      "The chart is bumped to 2.5.0 and all checks pass.",
      "Release notes are ready.",
      "The staging smoke test passed on the third run.",
      "The release candidate passes. The release is ready.",
    ]);
    expect(parts.map((p) => p.internal.length)).toEqual([3, 1, 2, 1, 1]);
  });

  test("every task sits in one place", () => {
    expect(placedIds(model).length).toBe(SB2.length);
  });
});

describe("live lead work never replaces a shown answer", () => {
  const base = [
    task({ id: "r", createdAt: at(60), source: "ui", requestedByUserId: "alex", output: "On it." }),
    task({ id: "w", createdAt: at(59), agentId: "forge", isLeadTask: false, parentTaskId: "r" }),
    task({
      id: "f1",
      createdAt: at(50),
      source: "system",
      taskType: "follow-up",
      parentTaskId: "w",
      output: "Done: the draft is ready.",
    }),
  ];

  test("a follow-up that runs now shows under the latest answer", () => {
    const chain = [
      ...base,
      task({
        id: "w2",
        createdAt: at(49),
        agentId: "forge",
        isLeadTask: false,
        parentTaskId: "f1",
      }),
      task({
        id: "f2",
        createdAt: at(40),
        source: "system",
        taskType: "follow-up",
        parentTaskId: "w2",
        status: "in_progress",
      }),
    ];
    const part = buildTurns(chain).turns[0].parts[0];
    expect(part.result?.id).toBe("f1");
    expect(part.live?.id).toBe("f2");
    expect(part.internal.map((t) => t.id)).toEqual([]);
  });

  test("a pending follow-up after the reply alone shows under the reply", () => {
    const chain = [
      base[0],
      base[1],
      task({
        id: "f1",
        createdAt: at(50),
        source: "system",
        taskType: "follow-up",
        parentTaskId: "w",
        status: "pending",
      }),
    ];
    const part = buildTurns(chain).turns[0].parts[0];
    expect(part.result).toBeUndefined();
    expect(part.live?.id).toBe("f1");
  });
});

describe("real server shapes", () => {
  test("a task-page Retry of a failed worker try is the next try of that step", () => {
    // lib/task-retry.ts: source ui, the requester, parent = the failed task, same agent, type, and prompt.
    const chain = [
      task({
        id: "r",
        createdAt: at(60),
        source: "ui",
        requestedByUserId: "alex",
        output: "Sending it to Forge.",
      }),
      task({
        id: "w",
        createdAt: at(59),
        agentId: "forge",
        isLeadTask: false,
        parentTaskId: "r",
        taskType: "content",
        task: "Draft the copy.",
        status: "failed",
      }),
      task({
        id: "retry",
        createdAt: at(40),
        agentId: "forge",
        isLeadTask: false,
        parentTaskId: "w",
        taskType: "content",
        task: "Draft the copy.",
        source: "ui",
        requestedByUserId: "alex",
      }),
    ];
    const { turns } = buildTurns(chain);
    expect(turns).toHaveLength(1);
    expect(stepShape(turns[0].parts[0])).toEqual(["forge:content:2"]);
    expect(summary(turns[0].parts[0])).toMatchObject({ retries: 1, state: "done" });
  });

  test("a Retry of the lead's reply is one more answer of that part", () => {
    const chain = [
      task({
        id: "r",
        createdAt: at(60),
        source: "ui",
        requestedByUserId: "alex",
        task: "Summarize the call.",
        status: "failed",
      }),
      task({
        id: "retry",
        createdAt: at(50),
        source: "ui",
        requestedByUserId: "alex",
        task: "Summarize the call.",
        parentTaskId: "r",
        output: "The call covered pricing.",
      }),
    ];
    const { turns } = buildTurns(chain);
    expect(turns).toHaveLength(1);
    expect(turns[0].parts[0].result?.id).toBe("retry");
  });

  test("a dashboard follow-up with no picked user still opens a turn", () => {
    const chain = [
      task({
        id: "r",
        createdAt: at(60),
        source: "ui",
        requestedByUserId: "alex",
        output: "Done.",
      }),
      task({
        id: "u",
        createdAt: at(30),
        source: "ui",
        parentTaskId: "r",
        task: "And the FAQ?",
        output: "Updated.",
      }),
    ];
    const { turns } = buildTurns(chain);
    expect(turns.map((t) => t.person?.id)).toEqual(["r", "u"]);
    expect(turns[0].parts[0].result).toBeUndefined();
  });

  test("a session a schedule started has no person bubble, and a later reply opens a turn", () => {
    const chain = [
      task({ id: "r", createdAt: at(60), source: "schedule", task: "Run the weekly audit." }),
      task({
        id: "w1",
        createdAt: at(59),
        agentId: "scout",
        isLeadTask: false,
        parentTaskId: "r",
        taskType: "research",
      }),
      task({
        id: "u",
        createdAt: at(30),
        source: "ui",
        requestedByUserId: "alex",
        parentTaskId: "w1",
      }),
    ];
    const { turns } = buildTurns(chain);
    expect(turns).toHaveLength(2);
    expect(turns[0].person).toBeUndefined();
    expect(turns[0].parts[0].reply.id).toBe("r");
    expect(stepShape(turns[0].parts[0])).toEqual(["scout:research:1"]);
    expect(turns[1].person?.id).toBe("u");
  });

  test("a task with no path to the root lands in rest, in chain order", () => {
    const chain = [
      task({ id: "r", createdAt: at(60), source: "ui", requestedByUserId: "alex" }),
      task({
        id: "lost",
        createdAt: at(50),
        parentTaskId: "gone",
        agentId: "forge",
        isLeadTask: false,
      }),
      task({ id: "orphan", createdAt: at(40) }),
    ];
    const model = buildTurns(chain);
    expect(model.turns).toHaveLength(1);
    expect(model.rest.map((t) => t.id)).toEqual(["lost", "orphan"]);
    expect(placedIds(model).length).toBe(3);
  });

  test("a worker's superseded try and its resume are one step; the lead's resume is a handoff", () => {
    const chain = [
      task({ id: "r", createdAt: at(60), source: "ui", requestedByUserId: "alex" }),
      task({
        id: "w",
        createdAt: at(55),
        agentId: "forge",
        isLeadTask: false,
        parentTaskId: "r",
        taskType: "test",
        status: "superseded",
      }),
      task({
        id: "w2",
        createdAt: at(50),
        agentId: "forge",
        isLeadTask: false,
        parentTaskId: "w",
        source: "system",
        taskType: "resume",
        finishedAt: at(45),
      }),
      task({
        id: "lr",
        createdAt: at(40),
        parentTaskId: "r",
        source: "system",
        taskType: "resume",
        status: "superseded",
      }),
    ];
    const part = buildTurns(chain).turns[0].parts[0];
    expect(stepShape(part)).toEqual(["forge:test:2"]);
    expect(summary(part)).toMatchObject({ retries: 1, state: "done" });
    expect(part.internal.map((t) => t.id)).toEqual(["lr"]);
  });

  test("a step whose last try was cancelled is cancelled, not done", () => {
    const chain = [
      task({ id: "r", createdAt: at(60), source: "ui", requestedByUserId: "alex" }),
      task({
        id: "w",
        createdAt: at(55),
        agentId: "forge",
        isLeadTask: false,
        parentTaskId: "r",
        status: "cancelled",
        finishedAt: at(50),
      }),
      task({
        id: "w2",
        createdAt: at(55),
        agentId: "scout",
        isLeadTask: false,
        parentTaskId: "r",
        finishedAt: at(52),
      }),
    ];
    expect(summary(buildTurns(chain).turns[0].parts[0])).toMatchObject({
      state: "cancelled",
      cancelled: 1,
      failed: 0,
    });
  });

  test("a failed last try marks the line failed", () => {
    const chain = [
      task({ id: "r", createdAt: at(60), source: "ui", requestedByUserId: "alex" }),
      task({
        id: "w",
        createdAt: at(55),
        agentId: "forge",
        isLeadTask: false,
        parentTaskId: "r",
        status: "failed",
        finishedAt: at(50),
      }),
    ];
    const part = buildTurns(chain).turns[0].parts[0];
    expect(summary(part)).toMatchObject({ state: "failed", failed: 1, retries: 0 });
    expect(span(part)).toBe("5m");
  });

  test("an older server without isLeadTask: the root's agent is the lead", () => {
    const strip = ({ isLeadTask: _drop, ...t }: AgentTask) => t as AgentTask;
    const { turns } = buildTurns(SB1.map(strip));
    expect(turns.map((t) => t.parts.length)).toEqual([1, 2, 1, 1]);
    expect(summary(turns[2].parts[0])).toMatchObject({ agentIds: ["coder"], retries: 2 });
  });

  test("a long chain builds in linear time", () => {
    // A 3000-task chain of follow-ups and workers: each walk stops at a known part.
    const chain: AgentTask[] = [
      task({ id: "r", createdAt: at(5000), source: "ui", requestedByUserId: "alex" }),
    ];
    for (let i = 1; i < 3000; i++) {
      chain.push(
        task({
          id: `t${i}`,
          createdAt: at(5000 - i),
          parentTaskId: chain[i - 1].id,
          ...(i % 2
            ? { agentId: "forge", isLeadTask: false }
            : { source: "system", taskType: "follow-up", output: `Step ${i}` }),
        }),
      );
    }
    const started = performance.now();
    const model = buildTurns(chain);
    expect(performance.now() - started).toBeLessThan(100);
    expect(placedIds(model).length).toBe(3000);
  });
});

describe("approvalsByPart", () => {
  test("an approval sits in the part that asked, also when a handoff asked", () => {
    const { turns } = buildTurns(SB1);
    const handoff = turns[1].parts[0].internal[0];
    const placed = approvalsByPart(turns, [
      { id: "a1", status: "pending", sourceTaskId: handoff.id, title: "Ship it?" },
      { id: "a2", status: "pending", sourceTaskId: turns[1].parts[1].reply.id, title: "Publish?" },
      { id: "a3", status: "pending", sourceTaskId: "elsewhere", title: "Other" },
    ]);
    expect(placed.get(turns[1].parts[0].id)?.map((a) => a.id)).toEqual(["a1"]);
    expect(placed.get(turns[1].parts[1].id)?.map((a) => a.id)).toEqual(["a2"]);
    expect(placed.get(null)?.map((a) => a.id)).toEqual(["a3"]);
  });
});

test("formatSpan rounds to whole minutes like the mockup", () => {
  expect(formatSpan(12_000)).toBe("12s");
  expect(formatSpan(17 * 60_000)).toBe("17m");
  expect(formatSpan(96 * 60_000)).toBe("1h 36m");
  expect(formatSpan(120 * 60_000)).toBe("2h");
  expect(formatSpan(51 * 3_600_000)).toBe("2d 3h");
});
