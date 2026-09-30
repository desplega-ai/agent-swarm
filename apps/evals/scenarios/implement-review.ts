import type {
  CheckResult,
  DeterministicCheck,
  JudgeContext,
  OutcomeSpec,
  Scenario,
  SwarmTask,
} from "../src/types.ts";
import { soloVariant, workerTasks } from "./orchestration-utils.ts";

/**
 * implement-review (swarm-evals plan v2, Phase 8; lead + coder + reviewer, sequential)
 * -------------------------------------------------------------------------------
 * A tiny TypeScript repo (`/workspace/repo`, a cart total) carries two bugs:
 *   - bug 1 (the task): `applyCoupon` treats 15 as 1500%. The visible tests fail.
 *   - bug 2 (planted for review): free shipping starts ABOVE $50.00, while the
 *     spec says "$50.00 or more". No visible test sits on the boundary.
 * The coder (worker 0) and the reviewer (worker 1) each hold a copy of the repo.
 * Only the reviewer holds the spec and its acceptance tests (`/workspace/review/`,
 * seeded through `seed.workerExec`), so the coder has no reason to touch the
 * shipping rule and the reviewer should request changes once. The lead relays
 * the coder's diff to the reviewer, the findings back to the coder, and may only
 * say SHIPPED after an APPROVE. `implement-review-solo` gives one worker the repo
 * AND the review material (the team's information combined, plan Q6).
 *
 * Graded deterministically:
 *   - gate `visible-tests-green`: the grader's own pristine copy of the visible
 *     tests passes against the coder's `src/cart.ts`.
 *   - `tests` (3): grader-owned test groups on the coder's sandbox, `visible`
 *     (bug 1) and `planted` (bug 2), plus the seeded test file unmodified. The
 *     grader runs them itself; nothing the agents report is trusted.
 *   - `review` (3, swarm only): a reviewer task says REQUEST_CHANGES and names the
 *     shipping boundary (R1), a coder task was created after that review ended
 *     (R2), and a later reviewer task says APPROVE (R3).
 *   - `process` (2, swarm only): every lead result that says SHIPPED ended after
 *     the first APPROVE, and at least one exists.
 *   - `efficiency` (1): against budgetUsd / budgetMs.
 * No LLM judge: everything here is observable in files and the task tree.
 */

const CODER = 0;
const REVIEWER = 1;
const SOLO = 0;
const REPO = "/workspace/repo";
const CART = `${REPO}/src/cart.ts`;
const VISIBLE_TEST = `${REPO}/test/cart.test.ts`;
const REVIEW_DIR = "/workspace/review";
const BUN = "/usr/local/bin/bun";
const GRADER_DIR = "/tmp/eval-grader";

// ---- the repo (bugs marked for the reader; the comments ship too, they are harmless) ----

const PACKAGE_JSON = `${JSON.stringify({ name: "cart", private: true, type: "module" }, null, 2)}\n`;

const CART_SRC = `export interface Line {
  sku: string;
  unitCents: number;
  qty: number;
}

export const FREE_SHIPPING_CENTS = 5000;
export const SHIPPING_CENTS = 499;

export function subtotalCents(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.unitCents * l.qty, 0);
}

/** Percent-off coupon: 15 means 15% off. Rounds to the nearest cent. */
export function applyCoupon(subtotal: number, percent: number): number {
  return Math.round(subtotal - subtotal * percent);
}

/** Orders over $50.00 ship free. */
export function shippingCents(discounted: number): number {
  return discounted > FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS;
}

export function totalCents(lines: Line[], couponPercent = 0): number {
  const discounted = applyCoupon(subtotalCents(lines), couponPercent);
  return discounted + shippingCents(discounted);
}
`;

/** The visible suite, with the module path as a parameter so the grader can run a pristine copy. */
function visibleTests(cartPath: string): string {
  return `import { describe, expect, test } from "bun:test";
import { applyCoupon, shippingCents, subtotalCents, totalCents } from "${cartPath}";

describe("cart", () => {
  test("subtotal sums unit price times quantity", () => {
    expect(subtotalCents([{ sku: "a", unitCents: 1500, qty: 2 }, { sku: "b", unitCents: 250, qty: 4 }])).toBe(4000);
  });
  test("a percent coupon takes that percent off", () => {
    expect(applyCoupon(10000, 15)).toBe(8500);
    expect(applyCoupon(999, 10)).toBe(899);
  });
  test("no coupon leaves the subtotal alone", () => {
    expect(applyCoupon(4200, 0)).toBe(4200);
  });
  test("small orders pay shipping, large orders do not", () => {
    expect(shippingCents(4999)).toBe(499);
    expect(shippingCents(6000)).toBe(0);
  });
  test("total applies the coupon, then shipping", () => {
    expect(totalCents([{ sku: "a", unitCents: 1500, qty: 2 }], 10)).toBe(3199);
  });
});
`;
}

/** The planted bug: the spec's free-shipping boundary (graded; the reviewer's acceptance tests cover it too). */
function plantedTests(cartPath: string): string {
  return `import { expect, test } from "bun:test";
import { shippingCents, totalCents } from "${cartPath}";

test("an order of exactly $50.00 ships free", () => {
  expect(shippingCents(5000)).toBe(0);
  expect(totalCents([{ sku: "a", unitCents: 5000, qty: 1 }])).toBe(5000);
});
test("the free-shipping check uses the discounted amount", () => {
  expect(totalCents([{ sku: "a", unitCents: 6250, qty: 1 }], 20)).toBe(5000);
});
`;
}

const REPO_VISIBLE_TEST = visibleTests("../src/cart.ts");

const SPEC_MD = `# Cart pricing spec

1. Amounts are integer cents.
2. A coupon is percent-off: 15 means 15% off the subtotal. Round to the nearest cent.
3. Orders of $50.00 or more, after the coupon, ship free. Below that, shipping is $4.99.
4. The total is the discounted subtotal plus shipping.
`;

const ACCEPTANCE_TEST = `import { expect, test } from "bun:test";
import { applyCoupon, shippingCents, totalCents } from "${CART}";

test("coupons are percent-off", () => {
  expect(applyCoupon(10000, 15)).toBe(8500);
});
test("an order of exactly $50.00 ships free", () => {
  expect(shippingCents(5000)).toBe(0);
});
test("the free-shipping check uses the discounted amount", () => {
  expect(totalCents([{ sku: "a", unitCents: 6250, qty: 1 }], 20)).toBe(5000);
});
`;

function writeFile(path: string, content: string): string {
  const b64 = Buffer.from(content).toString("base64");
  return `mkdir -p "$(dirname ${path})" && echo '${b64}' | base64 -d > ${path}`;
}

/** Repo on one sandbox: files, an initial commit (so `git diff` works), writable by the agent user. */
function repoCommands(): string[] {
  return [
    writeFile(`${REPO}/package.json`, PACKAGE_JSON),
    writeFile(CART, CART_SRC),
    writeFile(VISIBLE_TEST, REPO_VISIBLE_TEST),
    `cd ${REPO} && git init -q && git add -A && git -c user.email=seed@evals -c user.name=seed commit -qm "initial" && chmod -R a+rwX ${REPO} && git config --system --add safe.directory '*'`,
  ];
}

function reviewCommands(): string[] {
  return [
    writeFile(`${REVIEW_DIR}/SPEC.md`, SPEC_MD),
    writeFile(`${REVIEW_DIR}/acceptance.test.ts`, ACCEPTANCE_TEST),
    `chmod -R a+rwX ${REVIEW_DIR}`,
  ];
}

// ---- grader test groups (run on the coder's sandbox, grader-owned copies) ----

interface GraderGroup {
  name: string;
  file: string;
  content: string;
}

const GROUPS: GraderGroup[] = [
  { name: "visible", file: "visible.test.ts", content: visibleTests(CART) },
  { name: "planted", file: "planted.test.ts", content: plantedTests(CART) },
];

function groupCommand(g: GraderGroup): string {
  return `${writeFile(`${GRADER_DIR}/${g.file}`, g.content)} && cd ${GRADER_DIR} && ${BUN} test ./${g.file}`;
}

async function groupGreen(ctx: JudgeContext, worker: number, g: GraderGroup): Promise<boolean> {
  const w = ctx.workers[worker];
  if (!w) return false;
  try {
    return (await w.exec(groupCommand(g))).exitCode === 0;
  } catch {
    return false;
  }
}

function visibleGate(worker: number): DeterministicCheck {
  return {
    name: `visible-tests-green[w${worker}]`,
    fn: async (ctx): Promise<CheckResult> => {
      const green = await groupGreen(ctx, worker, GROUPS[0] as GraderGroup);
      return {
        pass: green,
        detail: green
          ? "grader copy of the visible tests passes"
          : "grader copy of the visible tests fails",
      };
    },
  };
}

function testGroups(worker: number): DeterministicCheck {
  return {
    name: `grader-test-groups[w${worker}]`,
    fn: async (ctx): Promise<CheckResult> => {
      const red: string[] = [];
      for (const g of GROUPS) if (!(await groupGreen(ctx, worker, g))) red.push(g.name);
      const score = (GROUPS.length - red.length) / GROUPS.length;
      return {
        pass: red.length === 0,
        score,
        detail:
          red.length === 0
            ? `${GROUPS.length}/${GROUPS.length} grader groups green (bug 1 and planted bug 2 fixed)`
            : `${GROUPS.length - red.length}/${GROUPS.length} grader groups green (red: ${red.join(", ")})`,
      };
    },
  };
}

function testsUnmodified(worker: number): DeterministicCheck {
  return {
    name: `tests-unmodified[w${worker}]`,
    fn: async (ctx): Promise<CheckResult> => {
      const onDisk = await ctx.workers[worker]?.readFile(VISIBLE_TEST);
      const pristine = onDisk === REPO_VISIBLE_TEST;
      return {
        pass: pristine,
        score: pristine ? 1 : 0,
        detail: pristine ? "seeded test file unmodified" : `${VISIBLE_TEST} was edited or deleted`,
      };
    },
  };
}

// ---- review paper trail (swarm only) ----

type Verdict = "approve" | "request-changes" | null;

export function verdictOf(result: string | null | undefined): Verdict {
  const m = /VERDICT:\s*\**\s*(APPROVE|REQUEST[_ ]CHANGES)/i.exec(result ?? "");
  if (!m) return null;
  return (m[1] as string).toUpperCase().startsWith("APPROVE") ? "approve" : "request-changes";
}

/** A review that names the planted bug: shipping, plus the boundary. */
export function namesPlantedBug(result: string | null | undefined): boolean {
  const text = result ?? "";
  return /ship/i.test(text) && /(5000|50(\.00)?\b|threshold|boundary|or more|>=|≥)/i.test(text);
}

function doneWithOutput(t: SwarmTask): boolean {
  return (
    ["done", "completed"].includes(t.status) &&
    typeof t.result === "string" &&
    t.result.trim().length > 0
  );
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function byFinish(a: SwarmTask, b: SwarmTask): number {
  return (timeOf(a.finishedAt) ?? 0) - (timeOf(b.finishedAt) ?? 0);
}

function reviewTrail(ctx: JudgeContext) {
  const lead = ctx.workers.find((w) => w.isLead);
  const coder = ctx.workers[CODER];
  const reviewer = ctx.workers[REVIEWER];
  const children = workerTasks(ctx, lead?.agentId);
  const reviews = children
    .filter((t) => t.agentId === reviewer?.agentId && doneWithOutput(t))
    .sort(byFinish);
  const coderTasks = children.filter((t) => t.agentId === coder?.agentId);
  const changes = reviews.find(
    (t) => verdictOf(t.result) === "request-changes" && namesPlantedBug(t.result),
  );
  const approvals = reviews.filter((t) => verdictOf(t.result) === "approve");
  return { lead, reviews, coderTasks, changes, approvals };
}

const W_CAUGHT = 2;
const W_BACK_TO_CODER = 1;
const W_APPROVED_AFTER = 1;

const reviewCheck: DeterministicCheck = {
  name: "review-paper-trail",
  fn: async (ctx): Promise<CheckResult> => {
    const { reviews, coderTasks, changes, approvals } = reviewTrail(ctx);
    if (reviews.length === 0) {
      return { pass: false, score: 0, detail: "no completed reviewer task" };
    }
    const changesAt = timeOf(changes?.finishedAt);
    const caught = changes ? 1 : 0;
    const backToCoder =
      changesAt !== null && coderTasks.some((t) => (timeOf(t.createdAt) ?? -1) >= changesAt)
        ? 1
        : 0;
    const approvedAfter =
      changesAt !== null && approvals.some((t) => (timeOf(t.finishedAt) ?? -1) > changesAt) ? 1 : 0;
    const score =
      (W_CAUGHT * caught + W_BACK_TO_CODER * backToCoder + W_APPROVED_AFTER * approvedAfter) /
      (W_CAUGHT + W_BACK_TO_CODER + W_APPROVED_AFTER);
    const verdicts = reviews.map((t) => verdictOf(t.result) ?? "none").join(" → ");
    return {
      pass: score >= 1,
      score,
      detail: `review ${score.toFixed(2)} — reviews [${verdicts}], planted bug caught=${caught}, back to coder=${backToCoder}, approved after=${approvedAfter}`,
    };
  },
};

export const SHIPPED_RE = /^\s*[*_`#>\s]*SHIPPED\b/m;

const processCheck: DeterministicCheck = {
  name: "shipped-after-approval",
  fn: async (ctx): Promise<CheckResult> => {
    const { lead, approvals } = reviewTrail(ctx);
    const shipped = ctx.tasks.filter(
      (t) => t.agentId === lead?.agentId && SHIPPED_RE.test(t.result ?? ""),
    );
    if (shipped.length === 0)
      return { pass: false, score: 0, detail: "the lead never said SHIPPED" };
    const firstApproval = Math.min(
      ...approvals.map((t) => timeOf(t.finishedAt)).filter((v): v is number => v !== null),
    );
    if (!Number.isFinite(firstApproval)) {
      return { pass: false, score: 0, detail: "SHIPPED without any APPROVE review" };
    }
    const early = shipped.filter((t) => (timeOf(t.finishedAt) ?? 0) < firstApproval);
    if (early.length > 0) {
      return {
        pass: false,
        score: 0,
        detail: `SHIPPED before the first APPROVE (${early.length} lead result(s))`,
      };
    }
    return { pass: true, score: 1, detail: "SHIPPED only after an APPROVE review" };
  },
};

// ---- prompts ----

const REPO_BRIEF = [
  `The repo at \`${REPO}\` is a small TypeScript cart-pricing module (\`src/cart.ts\`) with tests`,
  `in \`test/\`; run them with \`cd ${REPO} && bun test\`. Some tests fail. Fix \`src/\` so that`,
  "`bun test` passes; never edit or delete a test file.",
].join("\n");

const LEAD_BRIEF = [
  "You are the LEAD of a two-person team: a coder and a reviewer (get-swarm shows who is who).",
  `Each of them has their own copy of the repo at \`${REPO}\` on their own sandbox; you have none.`,
  "The reviewer also holds the product spec and acceptance tests in",
  `\`${REVIEW_DIR}/\` on their sandbox.`,
  "",
  REPO_BRIEF,
  "",
  "Work like this:",
  "  1. Ask the coder to make the fix and to report the full `git diff` of the working tree (do not",
  "     commit).",
  "  2. Send that diff to the reviewer. The reviewer applies it to their own copy",
  "     (`git checkout -- . && git apply`), reviews it against the spec and the acceptance tests,",
  "     and answers with a first line `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`, then the",
  "     reasons.",
  "  3. On REQUEST_CHANGES, send the findings to the coder, who fixes on top of the same working",
  "     tree and reports the full `git diff` again. Send that to the reviewer. Repeat until APPROVE.",
  "  4. Only after an APPROVE, finish with a final message whose first line is `SHIPPED`,",
  "     followed by the approved diff. Never write SHIPPED before an approval.",
  "Do not write code or review it yourself.",
].join("\n");

const SOLO_BRIEF = [
  "You are working alone: do all of the work yourself.",
  "",
  REPO_BRIEF,
  "",
  `Before you finish, check your change against the product spec and acceptance tests in`,
  `\`${REVIEW_DIR}/\` and fix anything they reject. Finish with a final message whose first line`,
  "is `SHIPPED`, followed by your `git diff`.",
].join("\n");

type Dimension = NonNullable<OutcomeSpec["dimensions"]>[number];

function testsDimension(worker: number): Dimension {
  return {
    name: "tests",
    weight: 3,
    checks: [
      { ...testGroups(worker), weight: 3 },
      { ...testsUnmodified(worker), weight: 1 },
    ],
  };
}

const EFFICIENCY: Dimension = { name: "efficiency", weight: 1 };

export const implementReview: Scenario = {
  id: "implement-review",
  version: 1,
  name: "Implement and review",
  description: [
    "A lead runs a coder and a reviewer on a tiny TypeScript repo with a failing coupon test. The",
    "reviewer alone holds the spec, which exposes a second, planted bug (the free-shipping",
    "boundary), so it should request changes once before approving. Graded from grader-run tests",
    "on the coder's sandbox (tests, 3), the review paper trail in the task tree: planted bug",
    "caught, sent back to the coder, approved after (review, 3), SHIPPED only after approval",
    "(process, 2), and cost and time against budget (efficiency, 1).",
  ].join(" "),
  workers: [{ name: "coder" }, { name: "reviewer" }],
  lead: { name: "Lead", template: "lead" },
  seed: {
    exec: repoCommands(),
    workerExec: [{ worker: REVIEWER, commands: [...repoCommands(), ...reviewCommands()] }],
  },
  tasks: [
    {
      title: "Fix the cart tests through code review (lead)",
      worker: "lead",
      description: LEAD_BRIEF,
    },
  ],
  outcome: {
    gates: [visibleGate(CODER)],
    dimensions: [
      testsDimension(CODER),
      { name: "review", weight: 3, checks: [reviewCheck] },
      { name: "process", weight: 2, checks: [processCheck] },
      EFFICIENCY,
    ],
  },
  awaitSpawnedTasks: true,
  timeoutMs: 20 * 60_000,
  budgetUsd: 1,
  budgetMs: 10 * 60_000,
};

export const implementReviewSolo: Scenario = soloVariant(implementReview, {
  worker: { name: "coder" },
  seed: { exec: [...repoCommands(), ...reviewCommands()] },
  task: {
    title: "Fix the cart tests (single agent)",
    description: SOLO_BRIEF,
  },
  outcome: {
    gates: [visibleGate(SOLO)],
    dimensions: [testsDimension(SOLO), EFFICIENCY],
  },
});

// Exported for the rubric unit tests and grader fixtures.
export const __test__ = {
  CODER,
  REVIEWER,
  REPO,
  CART,
  VISIBLE_TEST,
  REVIEW_DIR,
  CART_SRC,
  PACKAGE_JSON,
  REPO_VISIBLE_TEST,
  SPEC_MD,
  ACCEPTANCE_TEST,
  GROUPS,
  groupCommand,
  visibleTests,
  plantedTests,
  reviewCheck,
  processCheck,
  repoCommands,
  reviewCommands,
};
