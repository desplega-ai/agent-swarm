import type { SwarmTask } from "../../src/types.ts";
import { type GraderFixture, makeContext, nullTasks } from "../grader-validation-support.ts";
import { implementReview, implementReviewSolo, __test__ as key } from "../implement-review.ts";

/**
 * Reference: a lead that runs the review loop. The coder fixes the coupon bug
 * and reports its diff; the reviewer applies it, runs the acceptance tests,
 * and requests changes on the free-shipping boundary; the coder fixes that on
 * top; the reviewer approves; only then does the lead's result start with
 * SHIPPED. On the coder's sandbox both grader test groups pass (the exec map
 * answers the grader's exact commands) and the seeded test file is untouched.
 *
 * The solo reference is one worker that fixes both bugs and says SHIPPED.
 */

const LEAD = "lead";
const T0 = Date.UTC(2026, 8, 30, 10, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const DIFF = [
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "-  return Math.round(subtotal - subtotal * percent);",
  "+  return Math.round(subtotal - (subtotal * percent) / 100);",
  "-  return discounted > FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS;",
  "+  return discounted >= FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS;",
].join("\n");

export const REVIEW_CHANGES =
  "VERDICT: REQUEST_CHANGES\nSPEC item 3: orders of $50.00 or more ship free, but shippingCents uses `> 5000`. The acceptance test for exactly 5000 fails.";
export const REVIEW_APPROVE = "VERDICT: APPROVE\nAll acceptance tests pass.";

export function child(
  id: string,
  worker: number,
  result: string,
  createdAt: number,
  finishedAt: number,
): SwarmTask {
  return {
    id,
    title: `Round (${id})`,
    description: "Work item from the lead.",
    status: "completed",
    agentId: `worker-${worker}`,
    creatorAgentId: LEAD,
    parentTaskId: "task-0",
    result,
    createdAt: at(createdAt),
    finishedAt: at(finishedAt),
    origin: "run",
  };
}

export const REFERENCE_CHILDREN: SwarmTask[] = [
  child(
    "coder-1",
    key.CODER,
    `Fixed applyCoupon.\n${DIFF.split("\n").slice(0, 4).join("\n")}`,
    10,
    100,
  ),
  child("review-1", key.REVIEWER, REVIEW_CHANGES, 105, 160),
  child("coder-2", key.CODER, `Fixed the boundary.\n${DIFF}`, 165, 220),
  child("review-2", key.REVIEWER, REVIEW_APPROVE, 225, 260),
];

const green = Object.fromEntries(key.GROUPS.map((g) => [key.groupCommand(g), { exitCode: 0 }]));
const files = { [`w0:${key.VISIBLE_TEST}`]: key.REPO_VISIBLE_TEST };

const [leadSeed] = nullTasks(implementReview);
const [soloSeed] = nullTasks(implementReviewSolo);

export const fixture: GraderFixture = {
  reference: () =>
    makeContext(implementReview, {
      tasks: [
        {
          ...(leadSeed as SwarmTask),
          agentId: LEAD,
          result: `SHIPPED\n${DIFF}`,
          finishedAt: at(300),
        },
        ...REFERENCE_CHILDREN,
      ],
      exec: green,
      files,
    }),
};

export const soloFixture: GraderFixture = {
  reference: () =>
    makeContext(implementReviewSolo, {
      tasks: [{ ...(soloSeed as SwarmTask), agentId: "worker-0", result: `SHIPPED\n${DIFF}` }],
      exec: green,
      files,
    }),
};

export const __test__ = { LEAD, at, DIFF, green, files };
