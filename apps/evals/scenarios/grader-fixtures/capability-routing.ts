import type { SwarmTask } from "../../src/types.ts";
import { capabilityRouting, __test__ as key } from "../capability-routing.ts";
import { type GraderFixture, makeContext, nullTasks } from "../grader-validation-support.ts";

/**
 * Reference: a lead that reads get-swarm and sends each job once, to its
 * owner: translation to Cy (worker 2), on-call to Ana (worker 0), refunds to
 * Bo (worker 1). It writes the three answer lines to its own sandbox (index 3).
 * Answer key derived from the scenario's seeded data.
 */

const LEAD = "lead";
const T0 = Date.UTC(2026, 8, 30, 10, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

export const ANSWERS = [
  "Spanish: Los encargos ahora se reintentan automáticamente. / El enjambre comparte un espacio común.",
  `On-call ${key.ON_CALL_SERVICE} ${key.ON_CALL_DATE}: ${key.ON_CALL}`,
  `Refunded orders: ${key.REFUND_COUNT}, total ${key.REFUND_TOTAL}`,
].join("\n");

export const JOB_TEXT: Record<string, string> = {
  translation: `Translate into Spanish with the product glossary: "${key.RELEASE_LINES.join('" and "')}"`,
  "on-call": `Who is on call for ${key.ON_CALL_SERVICE} on ${key.ON_CALL_DATE}? Check the rota.`,
  orders: "Count the orders with status refunded and sum their amount in cents.",
};

export function child(id: string, worker: number, text: string, createdAt: number): SwarmTask {
  return {
    id,
    title: text.slice(0, 40),
    description: text,
    status: "completed",
    agentId: `worker-${worker}`,
    creatorAgentId: LEAD,
    parentTaskId: "task-0",
    result: "done",
    createdAt: at(createdAt),
    finishedAt: at(createdAt + 60),
    origin: "run",
  };
}

export const REFERENCE_CHILDREN: SwarmTask[] = [
  child("job-translation", 2, JOB_TEXT.translation as string, 10),
  child("job-on-call", 0, JOB_TEXT["on-call"] as string, 11),
  child("job-orders", 1, JOB_TEXT.orders as string, 12),
];

const [leadSeed] = nullTasks(capabilityRouting);

export function routingContext(children: SwarmTask[], answers = ANSWERS) {
  return makeContext(capabilityRouting, {
    tasks: [{ ...(leadSeed as SwarmTask), agentId: LEAD, result: "Answers written." }, ...children],
    files: { [`w${key.LEAD_INDEX}:${key.ANSWERS_FILE}`]: answers },
  });
}

export const fixture: GraderFixture = {
  reference: () => routingContext(REFERENCE_CHILDREN),
};
