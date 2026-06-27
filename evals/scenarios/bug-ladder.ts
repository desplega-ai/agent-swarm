import type { TestGroup } from "../src/judge/deterministic.ts";
import { testGroupsGreen } from "../src/judge/deterministic.ts";
import type { CheckResult, DeterministicCheck, Scenario } from "../src/types.ts";

/**
 * bug-ladder (v8.0 round-11, Code, 1 worker, budgetUsd: 1.5)
 * ---------------------------------------------------------
 * Calibrated spread: TODO(calibration) — fill frontierAvg / budgetAvg / gap from
 * the round-11 sweep (anchors: claude-opus-4.8, codex-5.5 vs pi-deepseek-flash,
 * claude-haiku). Ship gate: frontierAvg − budgetAvg ≥ 0.2. Target ~0.35 → 0.9.
 *
 * Round-11 hardening: the original five-bug ladder SATURATED — budget models tied
 * frontier at correctness 1.00 — so two MORE subtle bugs (a slug
 * collapse/edge-trim bug and a greedy word-wrap with an off-by-one + dropped
 * over-long word) were added as test groups bug6/bug7. They are the kind of
 * edge-case/logic flaw a weaker model ships a plausible-but-wrong first pass for,
 * so correctness becomes a graded fraction over SEVEN groups that separates models
 * (frontier clears ~all; budget reliably leaves bug6/bug7 — and often bug4/bug5 —
 * red). Correctness (weight 3) is the real discriminator here.
 *
 * Also exercises the deterministic `efficiency` dimension (v8.0 §5). NOTE the
 * budget is a WASTE-GUARD, not a quality lever — see the budgetUsd comment below.
 *
 * A seeded bun project at /workspace/ladder/ ships a single source module
 * (`src/textkit.ts`) with SEVEN planted bugs of graded difficulty — typo →
 * off-by-one → logic → edge case → subtle Unicode → slug collapse/trim → greedy
 * word-wrap — and SEVEN independent test files (`test/bug1..bug7.test.ts`), one
 * per bug, each its own graded test group. A single worker fixes the
 * implementation (never the tests) until each group is green. Reuses the
 * `seed.exec` heredoc test-suite machinery + `dependsOn` + per-test-group green
 * checks from the old `build-verify-fix` scenario, generalized to a GRADED ladder
 * so a config that fixes 5 of 7 bugs ranks above one that fixes 3
 * (`testGroupsGreen` → score = green/total).
 *
 * Grading:
 *   - `correctness` (weight 3): the FRACTION of the seven per-bug test groups
 *       that pass — graded via `testGroupsGreen` (partial credit). Each group is
 *       `bun test test/bugN.test.ts`; exit 0 == green.
 *   - `instruction-following` (weight 1): a deterministic check that the seven
 *       SEEDED test files are byte-for-byte UNMODIFIED (the worker was told to
 *       fix the implementation, never the tests) AND that no stray dependency was
 *       added (no node_modules/package install beyond the seeded bun project) —
 *       so a config can't "win" correctness by weakening or deleting the tests.
 *   - `efficiency` (weight 1, deterministic — v8.0 §5): scored from the attempt's
 *       REAL cost vs the $1.5 budget as a WASTE-GUARD only. Unpriced attempts
 *       re-normalize this dimension OUT (never scored 0).
 *
 * Anti-gaming (checklist applied to THIS scenario):
 *   - The tests-UNMODIFIED instruction-following check (weight 1) is the guard
 *     against tampering: a config that edits, weakens, deletes, or `skip`s a test
 *     file to make `bun test` exit 0 scores proportionally on instruction-
 *     following (the check compares each test file byte-for-byte to its seeded
 *     content, so any tamper is caught). Note the correctness groups run the
 *     ON-DISK test files, NOT a pristine copy — so a config that weakens a test
 *     still scores full correctness on the gutted on-disk test; it is the separate
 *     instruction-following dimension that penalizes the tamper.
 *   - The CORRECT implementation of each bug is NOT derivable from the task
 *     prompt — the prompt names no function, no expected value, and no fix. The
 *     only source of truth is running the seeded tests and reading their failing
 *     assertions; ground truth lives in the seeded `test/` bodies, never in the
 *     task text.
 *   - Grading is by TEST EXECUTION (exit code), not self-report — a worker can't
 *     claim green; the harness re-runs each group against the real sandbox.
 *   - The grading rubric / per-group thresholds are NOT shown to the worker.
 *   - The bugs span difficulty so the score is continuous: the typo is trivially
 *     fixable (budget configs clear it), while the subtle Unicode/grapheme bug,
 *     the off-by-one truncation edge, the slug separator-run/edge-trim bug, and the
 *     word-wrap off-by-one/dropped-word edge separate frontier from budget.
 */

const PROJECT = "/workspace/ladder";
const SRC = `${PROJECT}/src/textkit.ts`;

// ---- The buggy seeded module. Seven planted bugs of graded difficulty. Every
// export is imported by exactly one test file. The bugs are deliberately the
// kind a plausible first-pass implementation ships, and the fixes are NOT stated
// anywhere in the task prompt — only the seeded test assertions pin them down. --
const TEXTKIT_SRC = `// textkit — small string utilities. Several functions have bugs; the test suite
// under ../test pins down the correct behavior. Fix the implementations here so
// every test passes. Do NOT change anything under test/.

// BUG 1 (typo): returns the wrong constant — should be the input reversed.
export function reverse(s: string): string {
  return s; // typo-level: forgot to actually reverse
}

// BUG 2 (off-by-one): truncate to maxLen chars and append an ellipsis "…" when
// the string is longer than maxLen. The slice boundary is off by one and the
// ellipsis is omitted.
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen + 1);
}

// BUG 3 (logic): count vowels (a, e, i, o, u — case-insensitive). The mask is
// wrong (treats "y" as a vowel and misses "u").
export function countVowels(s: string): number {
  let n = 0;
  for (const ch of s.toLowerCase()) {
    if ("aeioy".includes(ch)) n++;
  }
  return n;
}

// BUG 4 (edge case): title-case each whitespace-separated word. Works for the
// simple case but mishandles already-upper tails and leaves the rest of the word
// untouched (so "wORLD" → "WORLD" instead of "World").
export function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// BUG 5 (subtle): true length in Unicode code points (NOT UTF-16 code units), so
// astral characters (emoji) count as one. \`s.length\` counts UTF-16 units, so a
// single emoji counts as 2. The fix is to count code points (e.g. spread/iterate).
export function glyphLength(s: string): number {
  return s.length;
}

// BUG 6 (subtle): build a URL slug — lowercase, replace each RUN of one-or-more
// non-alphanumeric characters with a SINGLE hyphen, and strip any leading/trailing
// hyphens. This naive version maps each separator char to its own hyphen (no
// run-collapse) and never trims the edges, so multi-space / punctuation / edge
// separators yield doubled and dangling hyphens.
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .split("")
    .map((ch) => (/[a-z0-9]/.test(ch) ? ch : "-"))
    .join("");
}

// BUG 7 (subtle): greedy word-wrap to \`maxWidth\` columns — pack whole words onto a
// line separated by single spaces, never splitting a word, and put a word that is
// itself longer than maxWidth on its OWN line; join the lines with "\\n". Two flaws:
// the fit test forgets the +1 column the joining space costs (off-by-one that lets a
// word squeak onto a line it overflows), and an over-long word is silently DROPPED
// instead of getting its own line.
export function wordWrap(s: string, maxWidth: number): string {
  const words = s.split(/\\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (w.length > maxWidth) continue; // drops over-long words
    if (current.length === 0) {
      current = w;
    } else if (current.length + w.length <= maxWidth) {
      // off-by-one: omits the +1 for the joining space
      current += " " + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.join("\\n");
}
`;

// ---- Seven per-bug test files, each a standalone group (\`bun test test/bugN.test.ts\`).
// Graded difficulty: bug1 (typo) → bug2 (off-by-one) → bug3 (logic) → bug4 (edge)
// → bug5 (subtle Unicode) → bug6 (slug collapse/edge-trim) → bug7 (greedy word-wrap
// off-by-one + dropped over-long word). These bodies are the ONLY source of ground
// truth; they are checked byte-for-byte unmodified by the instruction-following
// dimension. ----
const TEST_BUG1 = `import { expect, test } from "bun:test";
import { reverse } from "../src/textkit.ts";

test("reverse: simple ascii", () => {
  expect(reverse("abc")).toBe("cba");
});

test("reverse: palindrome unchanged", () => {
  expect(reverse("level")).toBe("level");
});

test("reverse: empty string", () => {
  expect(reverse("")).toBe("");
});
`;

const TEST_BUG2 = `import { expect, test } from "bun:test";
import { truncate } from "../src/textkit.ts";

test("truncate: shorter than max is unchanged", () => {
  expect(truncate("hi", 5)).toBe("hi");
});

test("truncate: exactly max is unchanged", () => {
  expect(truncate("hello", 5)).toBe("hello");
});

test("truncate: longer than max keeps maxLen chars plus an ellipsis", () => {
  // "hello world" truncated to 5 -> the first 5 chars plus a single ellipsis.
  expect(truncate("hello world", 5)).toBe("hello…");
});
`;

const TEST_BUG3 = `import { expect, test } from "bun:test";
import { countVowels } from "../src/textkit.ts";

test("countVowels: counts a e i o u case-insensitively", () => {
  expect(countVowels("Education")).toBe(5);
});

test("countVowels: y is NOT a vowel", () => {
  expect(countVowels("rhythm")).toBe(0);
});

test("countVowels: u IS counted", () => {
  expect(countVowels("uuu")).toBe(3);
});
`;

const TEST_BUG4 = `import { expect, test } from "bun:test";
import { titleCase } from "../src/textkit.ts";

test("titleCase: simple words", () => {
  expect(titleCase("hello world")).toBe("Hello World");
});

test("titleCase: normalizes the tail of an already-upper word", () => {
  expect(titleCase("wORLD")).toBe("World");
});

test("titleCase: leaves extra spacing between words intact", () => {
  expect(titleCase("a b")).toBe("A B");
});
`;

const TEST_BUG5 = `import { expect, test } from "bun:test";
import { glyphLength } from "../src/textkit.ts";

test("glyphLength: plain ascii equals char count", () => {
  expect(glyphLength("abc")).toBe(3);
});

test("glyphLength: a single astral emoji counts as one", () => {
  expect(glyphLength("🚀")).toBe(1);
});

test("glyphLength: mixed ascii + emoji counts code points", () => {
  expect(glyphLength("a🚀b")).toBe(3);
});
`;

const TEST_BUG6 = `import { expect, test } from "bun:test";
import { slugify } from "../src/textkit.ts";

test("slugify: simple phrase with trailing punctuation", () => {
  expect(slugify("Hello, World!")).toBe("hello-world");
});

test("slugify: collapses separator runs and trims edge hyphens", () => {
  expect(slugify("  Spaced   Out  ")).toBe("spaced-out");
});

test("slugify: mixed separators collapse to single hyphens", () => {
  expect(slugify("Foo_Bar / Baz--Qux")).toBe("foo-bar-baz-qux");
});
`;

const TEST_BUG7 = `import { expect, test } from "bun:test";
import { wordWrap } from "../src/textkit.ts";

test("wordWrap: greedily packs words within the width", () => {
  expect(wordWrap("the quick brown fox", 10)).toBe("the quick\\nbrown fox");
});

test("wordWrap: a word only fits if the joining space also fits", () => {
  expect(wordWrap("abc de fg", 5)).toBe("abc\\nde fg");
});

test("wordWrap: a word longer than the width takes its own line", () => {
  expect(wordWrap("supercalifragilistic is here", 8)).toBe("supercalifragilistic\\nis here");
});
`;

// Seeded test files keyed by their on-disk path. The instruction-following check
// re-reads each and asserts it is BYTE-FOR-BYTE the seeded content (tamper guard).
const SEEDED_TESTS: { path: string; content: string }[] = [
  { path: `${PROJECT}/test/bug1.test.ts`, content: TEST_BUG1 },
  { path: `${PROJECT}/test/bug2.test.ts`, content: TEST_BUG2 },
  { path: `${PROJECT}/test/bug3.test.ts`, content: TEST_BUG3 },
  { path: `${PROJECT}/test/bug4.test.ts`, content: TEST_BUG4 },
  { path: `${PROJECT}/test/bug5.test.ts`, content: TEST_BUG5 },
  { path: `${PROJECT}/test/bug6.test.ts`, content: TEST_BUG6 },
  { path: `${PROJECT}/test/bug7.test.ts`, content: TEST_BUG7 },
];

// ---- Correctness: seven independent graded test groups (one per bug). The fraction
// that pass is the dimension sub-score (partial credit via testGroupsGreen). The
// two hardest groups (bug6 slug, bug7 word-wrap) are the round-11 hardening that
// breaks the saturation budget models hit on the original five. ----
const TEST_GROUPS: TestGroup[] = SEEDED_TESTS.map((_t, i) => ({
  name: `bug${i + 1}`,
  // Relative to the cwd passed to testGroupsGreen (PROJECT), so each group runs
  // exactly one seeded test file.
  cmd: `bun test test/bug${i + 1}.test.ts`,
}));

const correctnessChecks: DeterministicCheck = testGroupsGreen(TEST_GROUPS, 0, PROJECT);

// ---- instruction-following: the seeded test files must be byte-for-byte
// UNMODIFIED. Graded (score = unmodified/total) so deleting/weakening some tests
// costs proportionally; pass only when all seven are pristine. This is the
// primary anti-gaming guard — a config can't make `bun test` pass by editing
// tests, because tampering tanks this dimension AND the seeded assertions are
// what define a green correctness group. ----
const testsUnmodified: DeterministicCheck = {
  name: "tests-unmodified",
  fn: async (ctx): Promise<CheckResult> => {
    const total = SEEDED_TESTS.length;
    const tampered: string[] = [];
    for (const t of SEEDED_TESTS) {
      const onDisk = await ctx.readFile(t.path);
      // Missing OR changed both count as tampered (a deleted test file can't be
      // verified and is the most blatant gaming).
      if (onDisk === null || onDisk !== t.content) {
        tampered.push(t.path.replace(`${PROJECT}/`, ""));
      }
    }
    const pristine = total - tampered.length;
    const score = pristine / total;
    return {
      pass: tampered.length === 0,
      score,
      detail:
        tampered.length === 0
          ? `all ${total} seeded test files unmodified`
          : `${pristine}/${total} test files pristine (tampered: ${tampered.join(", ")})`,
    };
  },
};

// ---- Gate: the implementation file must exist (required output surface). The
// synthetic tasks-completed gate is prepended by the runner; the project src is
// pre-seeded, so we additionally gate that it is still present (a worker that
// deleted the module rather than fixing it fails the gate). ----
const srcExists: DeterministicCheck = {
  name: "src-exists",
  fn: async (ctx): Promise<CheckResult> => {
    const content = await ctx.readFile(SRC);
    if (content === null) return { pass: false, detail: `${SRC} not found` };
    return { pass: true, detail: `${SRC} (${content.length} bytes)` };
  },
};

export const bugLadder: Scenario = {
  id: "bug-ladder",
  name: "Bug ladder",
  description: [
    "Seeds a bun project at /workspace/ladder with a single source module (src/textkit.ts)",
    "carrying seven planted bugs of graded difficulty — typo, off-by-one, logic, edge case, a",
    "subtle Unicode bug, a slug-normalization bug, and a greedy word-wrap bug — and seven",
    "independent test files (test/bug1..bug7.test.ts), one per bug. A single worker fixes the",
    "implementation (never the tests) until each test group is green. Graded on the fraction of",
    "test groups that pass (correctness, 3×), the seeded tests staying byte-for-byte unmodified",
    "(instruction-following, 1×), and cost vs a $1.5 budget (efficiency, 1×).",
  ].join(" "),
  seed: {
    exec: [
      // Plant the buggy source module.
      [
        `mkdir -p ${PROJECT}/src ${PROJECT}/test`,
        `cat > ${SRC} <<'TEXTKIT_EOF'`,
        TEXTKIT_SRC.trimEnd(),
        "TEXTKIT_EOF",
      ].join("\n"),
      // Plant the seven per-bug test files.
      ...SEEDED_TESTS.map((t) =>
        [`cat > ${t.path} <<'TEST_EOF'`, t.content.trimEnd(), "TEST_EOF"].join("\n"),
      ),
      // Make the project writable by the worker.
      `chmod -R a+rwX ${PROJECT}`,
    ],
  },
  tasks: [
    {
      title: "Survey the failing test suite",
      description: [
        `A bun project lives at ${PROJECT}. Its source module is \`src/textkit.ts\` and there are`,
        "seven test files under `test/` (test/bug1.test.ts … test/bug7.test.ts). Several functions",
        "in `src/textkit.ts` are buggy. Run each test group to see what is failing:",
        "",
        `  cd ${PROJECT} && bun test test/bug1.test.ts`,
        "  (…and likewise for bug2…bug7)",
        "",
        "Do NOT fix anything yet in this task — just run the groups and report, via store-progress,",
        "which test groups are currently red and a one-line note on what each failing test expects.",
      ].join("\n"),
    },
    {
      title: "Fix the implementation until every test group is green",
      dependsOn: [0],
      description: [
        `Fix the implementations in \`${SRC}\` so that EACH of the seven test groups passes:`,
        "",
        `  cd ${PROJECT} && bun test test/bug1.test.ts   # … through test/bug7.test.ts`,
        "",
        "Constraints (these matter):",
        "  - Modify ONLY src/textkit.ts. Do NOT edit, delete, rename, add `.skip`/`.only` to, or",
        "    otherwise weaken ANY file under test/. The test files are the spec.",
        "  - Do NOT add new dependencies or scaffold a new project — fix the existing module.",
        "",
        "The bugs span a range of difficulty; partial progress counts, so fix as many groups as you",
        "can rather than stopping at the first. When you have fixed as many as possible, re-run all",
        "seven groups and report the final pass/fail of each via store-progress.",
      ].join("\n"),
    },
  ],
  outcome: {
    // Gates (binary must-pass): the source module must still exist. The synthetic
    // tasks-completed gate is prepended by the runner; correctness + instruction-
    // following + efficiency are graded (not gated) so they discriminate.
    gates: [srcExists],
    dimensions: [
      {
        name: "correctness",
        weight: 3,
        // Fraction of the seven per-bug test groups that pass (partial credit).
        checks: [correctnessChecks],
      },
      {
        name: "instruction-following",
        weight: 1,
        // The seeded test files must stay byte-for-byte unmodified (anti-gaming).
        checks: [testsUnmodified],
      },
      {
        // Deterministic efficiency (v8.0 §5): no checks/judge → scored by the
        // runner from the attempt's REAL cost vs budgetUsd. Unpriced attempts
        // re-normalize this dimension OUT (never scored 0).
        name: "efficiency",
        weight: 1,
      },
    ],
  },
  // Efficiency is a WASTE-GUARD, not a quality discriminator (round-11 design
  // decision). The original $0.5 budget INVERTED the ranking: a normal frontier
  // opus run (~$0.8) blew the budget and scored efficiency ~0.93, dropping opus
  // BELOW budget models that scored 1.0 while correctness was saturated. With the
  // v8.0 §5 linear decay to 0 at EFFICIENCY_DECAY_FACTOR×budget (N=3), a $1.5
  // budget scores a normal ~$0.8 frontier run at a clean 1.0 and only bites an
  // EGREGIOUS overspend: ~2× ($3.0) → ~0.5, ≥3× ($4.5) → 0. Correctness (now
  // hardened with bug6/bug7) is the real model discriminator; efficiency only
  // penalizes a config that thrashes catastrophically, never a normal frontier
  // premium. Do NOT lower this back toward a typical frontier per-run cost.
  budgetUsd: 1.5,
  // Two-task survey → fix chain over a seven-bug ladder: weaker configs need many
  // edit/re-run cycles. Raised to 15 minutes.
  timeoutMs: 15 * 60_000,
};
