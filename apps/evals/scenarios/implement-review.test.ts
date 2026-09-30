import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBaselinePairs, validateScenario } from "../src/registry.ts";
import type { SwarmTask } from "../src/types.ts";
import {
  child,
  fixture,
  REFERENCE_CHILDREN,
  REVIEW_APPROVE,
  REVIEW_CHANGES,
  __test__ as ref,
} from "./grader-fixtures/implement-review.ts";
import { makeContext, nullTasks } from "./grader-validation-support.ts";
import {
  __test__,
  implementReview,
  implementReviewSolo,
  namesPlantedBug,
  verdictOf,
} from "./implement-review.ts";

const { CART_SRC, visibleTests, plantedTests, ACCEPTANCE_TEST, CART, reviewCheck, processCheck } =
  __test__;

// ---- the fixture repo, run for real: the grader's claims about it must hold ----

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const FIX_COUPON: [string, string] = [
  "return Math.round(subtotal - subtotal * percent);",
  "return Math.round(subtotal - (subtotal * percent) / 100);",
];
const FIX_SHIPPING: [string, string] = [
  "return discounted > FREE_SHIPPING_CENTS",
  "return discounted >= FREE_SHIPPING_CENTS",
];

/** Which suites pass against a cart.ts with the given fixes applied. */
async function suites(fixes: [string, string][]) {
  const dir = mkdtempSync(join(tmpdir(), "implement-review-"));
  dirs.push(dir);
  let src = CART_SRC;
  for (const [from, to] of fixes) {
    expect(src).toContain(from);
    src = src.replace(from, to);
  }
  const cart = join(dir, "cart.ts");
  writeFileSync(cart, src);
  writeFileSync(join(dir, "visible.test.ts"), visibleTests(cart));
  writeFileSync(join(dir, "planted.test.ts"), plantedTests(cart));
  writeFileSync(join(dir, "acceptance.test.ts"), ACCEPTANCE_TEST.replaceAll(CART, cart));
  const run = async (file: string) => {
    const proc = Bun.spawn([process.execPath, "test", `./${file}`], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  };
  return {
    visible: await run("visible.test.ts"),
    planted: await run("planted.test.ts"),
    acceptance: await run("acceptance.test.ts"),
  };
}

describe("implement-review fixture repo (run with bun test)", () => {
  test("as seeded, every suite fails", async () => {
    expect(await suites([])).toEqual({ visible: false, planted: false, acceptance: false });
  });

  test("fixing only the coupon greens the visible tests; the reviewer's acceptance tests still fail", async () => {
    expect(await suites([FIX_COUPON])).toEqual({
      visible: true,
      planted: false,
      acceptance: false,
    });
  });

  test("fixing both bugs greens every suite", async () => {
    expect(await suites([FIX_COUPON, FIX_SHIPPING])).toEqual({
      visible: true,
      planted: true,
      acceptance: true,
    });
  });

  test("the repo's own test file is the visible suite, relative import", () => {
    expect(__test__.REPO_VISIBLE_TEST).toBe(visibleTests("../src/cart.ts"));
  });
});

// ---- rubric ----

const [leadSeed] = nullTasks(implementReview);

function ctxWith(children: SwarmTask[], leadResult = `SHIPPED\n${ref.DIFF}`, leadFinish = 300) {
  return makeContext(implementReview, {
    tasks: [
      {
        ...(leadSeed as SwarmTask),
        agentId: ref.LEAD,
        result: leadResult,
        finishedAt: ref.at(leadFinish),
      },
      ...children,
    ],
    exec: ref.green,
    files: ref.files,
  });
}

describe("implement-review verdict parsing", () => {
  test.each([
    ["VERDICT: APPROVE\nok", "approve"],
    ["**VERDICT:** REQUEST_CHANGES", "request-changes"],
    ["verdict: request changes", "request-changes"],
    ["Looks good to me", null],
  ])("%p -> %p", (text, verdict) => {
    expect(verdictOf(text)).toBe(verdict as ReturnType<typeof verdictOf>);
  });

  test("the planted bug is named by shipping plus the boundary", () => {
    expect(namesPlantedBug(REVIEW_CHANGES)).toBe(true);
    expect(namesPlantedBug("Free shipping must start at $50.00 or more")).toBe(true);
    expect(namesPlantedBug("Please rename applyCoupon")).toBe(false);
    expect(namesPlantedBug("shipping looks fine")).toBe(false);
  });
});

describe("implement-review review rubric", () => {
  test("the reference loop scores 1.0 on review and process", async () => {
    const ctx = fixture.reference();
    expect((await reviewCheck.fn(ctx)).score).toBe(1);
    expect((await processCheck.fn(ctx)).score).toBe(1);
  });

  test("a reviewer that approves the first diff misses the planted bug: review 0", async () => {
    const res = await reviewCheck.fn(
      ctxWith([
        child("coder-1", 0, "diff", 10, 100),
        child("review-1", 1, REVIEW_APPROVE, 105, 160),
      ]),
    );
    expect(res.score).toBe(0);
    expect(res.detail).toContain("planted bug caught=0");
  });

  test("changes requested for another reason do not count as catching the planted bug", async () => {
    const res = await reviewCheck.fn(
      ctxWith([
        child("coder-1", 0, "diff", 10, 100),
        child("review-1", 1, "VERDICT: REQUEST_CHANGES\nAdd a comment to applyCoupon.", 105, 160),
        child("coder-2", 0, "diff", 165, 220),
        child("review-2", 1, REVIEW_APPROVE, 225, 260),
      ]),
    );
    expect(res.score).toBe(0);
  });

  test("caught but never sent back to the coder nor re-approved: half credit", async () => {
    const res = await reviewCheck.fn(
      ctxWith([
        child("coder-1", 0, "diff", 10, 100),
        child("review-1", 1, REVIEW_CHANGES, 105, 160),
      ]),
    );
    expect(res.score).toBe(0.5);
  });

  test("SHIPPED before the approval zeroes process; no SHIPPED at all zeroes it too", async () => {
    expect((await processCheck.fn(ctxWith(REFERENCE_CHILDREN, "SHIPPED", 200))).score).toBe(0);
    expect((await processCheck.fn(ctxWith(REFERENCE_CHILDREN, "All done."))).score).toBe(0);
    expect(
      (await processCheck.fn(ctxWith(REFERENCE_CHILDREN.slice(0, 2), "SHIPPED", 400))).detail,
    ).toBe("SHIPPED without any APPROVE review");
  });
});

describe("implement-review registration", () => {
  test("both variants validate and pair as a baseline", () => {
    expect(validateScenario(implementReview)).toEqual([]);
    expect(validateScenario(implementReviewSolo)).toEqual([]);
    expect(validateBaselinePairs([implementReview, implementReviewSolo])).toEqual([]);
  });

  test("only the reviewer holds the spec; the solo worker holds everything", () => {
    const coderSeed = (implementReview.seed?.exec ?? []).join("\n");
    const reviewerSeed = (implementReview.seed?.workerExec ?? [])
      .filter((e) => e.worker === __test__.REVIEWER)
      .flatMap((e) => e.commands)
      .join("\n");
    expect(coderSeed).not.toContain(__test__.REVIEW_DIR);
    expect(reviewerSeed).toContain(`${__test__.REVIEW_DIR}/SPEC.md`);
    expect((implementReviewSolo.seed?.exec ?? []).join("\n")).toContain(
      `${__test__.REVIEW_DIR}/SPEC.md`,
    );
  });
});
