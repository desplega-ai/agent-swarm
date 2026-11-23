// Backward compatibility of code-match nodes and wait filters. Every case
// pins the result the pre-QuickJS evaluator (host `new Function`) gave for an
// existing workflow definition: the routed port, the stored rawResult, failure
// status and message prefix, and string and object wait filter matches. The
// cases pass on main before the sandbox change and on the branch after it.
// Error wording after the prefix comes from the JS engine, so only the prefix
// and the thrown message are pinned.
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  createWorkflow,
  getRunDetail,
  type RunDetail,
  stepOf,
  triggerWorkflow,
  waitForRun,
} from "./workflow-helpers";

const PROMISE_PORT = "[object Promise]";
const PORTS = [
  "true",
  "false",
  "a",
  "1",
  "0",
  "null",
  "undefined",
  "[object Object]",
  "1,2",
  "NaN",
  PROMISE_PORT,
  "run",
  "skip",
  "sync",
  "drop",
  "done",
];

type CodeCase = {
  label: string;
  code: string;
  trigger?: Record<string, unknown>;
  // Completed cases: the port taken and the stored rawResult (`absent` when
  // the value does not survive JSON, such as undefined).
  port?: string;
  raw?: unknown;
  // Failed cases: the exact error, or a prefix it starts with.
  error?: string;
  errorPrefix?: string;
};

const ABSENT = Symbol("absent");

const GITHUB_ROUTER = `(input) => {
  const t = (input && input.trigger) || {};
  const repos = ['acme/app', 'acme/lib'];
  const repo = t.repository && t.repository.full_name;
  if (repos.indexOf(repo) < 0) return 'drop';
  if (t.merge_group) {
    const ref = t.merge_group.head_ref;
    return (t.action === 'destroyed' && typeof ref === 'string' && /\\/pr-\\d+-[0-9a-f]{40}$/.test(ref)) ? 'run' : 'drop';
  }
  const pr = t.pull_request;
  if (!pr || typeof pr.number !== 'number') return 'drop';
  if (t.action === 'synchronize') return (typeof t.before === 'string' && typeof t.after === 'string') ? 'sync' : 'drop';
  return 'skip';
}`;

const UNIQUE_BATCHES = `(input) => { try { const p = input.trigger.p; if (!p || typeof p !== 'object' || p.skipReason || !Array.isArray(p.batches) || p.batches.length === 0) return 'skip'; const ids = p.batches.map((b) => (b && typeof b === 'object' ? b.batchId : null)); if (ids.some((x) => typeof x !== 'string' || !x) || new Set(ids).size !== ids.length) return 'skip'; return 'run'; } catch (e) { return 'skip'; } }`;

const CODE_CASES: CodeCase[] = [
  // Return shapes and their port mapping.
  { label: "boolean true", code: "(input) => true", port: "true", raw: true },
  { label: "boolean false", code: "(input) => false", port: "false", raw: false },
  {
    label: "Boolean() of trigger field",
    code: "(input) => Boolean(input.trigger.flag && input.trigger.n > 2)",
    port: "true",
    raw: true,
  },
  { label: "string port", code: "() => 'a'", port: "a", raw: "a" },
  { label: "number 1", code: "() => 1", port: "1", raw: 1 },
  { label: "number 0", code: "() => 0", port: "0", raw: 0 },
  { label: "null", code: "() => null", port: "null", raw: null },
  { label: "undefined", code: "() => undefined", port: "undefined", raw: ABSENT },
  { label: "empty object", code: "() => ({})", port: "[object Object]", raw: {} },
  { label: "array", code: "() => [1, 2]", port: "1,2", raw: [1, 2] },
  { label: "NaN", code: "() => NaN", port: "NaN", raw: null },
  {
    label: "object with custom toString",
    code: "() => ({ toString() { return 'a'; } })",
    port: "a",
    raw: {},
  },
  { label: "async predicate", code: "async () => true", port: PROMISE_PORT, raw: {} },
  // Strict mode and the shadowed host globals.
  { label: "strict this", code: "(input) => (this === undefined ? 'a' : 'skip')", port: "a" },
  {
    label: "console stays callable",
    code: "(input) => { console.log('debug', input.trigger.n); return 'a'; }",
    port: "a",
  },
  {
    label: "host globals are hidden",
    code: "() => [typeof process, typeof require, typeof Bun, typeof fetch, typeof setTimeout, typeof setInterval].every((t) => t === 'undefined')",
    port: "true",
  },
  // ctx access: trigger fields, nested arrays, standard library.
  {
    label: "nested trigger access",
    code: "(input) => (input.trigger.arr.map((x) => typeof x).join() === 'number,number,object' && input.trigger.arr[2].k === 'v' ? 'a' : 'skip')",
    port: "a",
  },
  {
    label: "regex, Set, nullish",
    code: "(input) => (/h(?<x>i)/.exec(input.trigger.s).groups.x === 'i' && new Set([1, 1]).size === 1 && (input.trigger.none ?? 'd') === 'd' ? 'a' : 'skip')",
    port: "a",
  },
  {
    label: "deep recursion",
    code: "() => { const f = (n) => (n < 1 ? 0 : 1 + f(n - 1)); return f(3000) === 3000 ? 'a' : 'skip'; }",
    port: "a",
  },
  // Production-shaped routers.
  {
    label: "github router, synchronize",
    code: GITHUB_ROUTER,
    trigger: {
      action: "synchronize",
      repository: { full_name: "acme/app" },
      pull_request: { number: 7, state: "open" },
      before: "a",
      after: "b",
    },
    port: "sync",
  },
  {
    label: "github router, merge_group regex",
    code: GITHUB_ROUTER,
    trigger: {
      action: "destroyed",
      repository: { full_name: "acme/lib" },
      merge_group: { head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${"a".repeat(40)}` },
    },
    port: "run",
  },
  {
    label: "github router, other repo",
    code: GITHUB_ROUTER,
    trigger: { repository: { full_name: "other/x" } },
    port: "drop",
  },
  {
    label: "unique batch ids",
    code: UNIQUE_BATCHES,
    trigger: { p: { batches: [{ batchId: "x" }, { batchId: "y" }] } },
    port: "run",
  },
  {
    label: "duplicate batch ids",
    code: UNIQUE_BATCHES,
    trigger: { p: { batches: [{ batchId: "x" }, { batchId: "x" }] } },
    port: "skip",
  },
  { label: "nullish chain default", code: "(i) => i.tickRoute ?? i.startRoute ?? 'done'", port: "done" },
  // Failures.
  {
    label: "port not declared",
    code: "() => 'nope'",
    error: `code-match returned "nope" which is not in outputPorts: [${PORTS.join(", ")}]`,
  },
  {
    label: "thrown Error",
    code: "() => { throw new Error('boom'); }",
    error: "code-match execution error: boom",
  },
  {
    label: "thrown string",
    code: "() => { throw 'str'; }",
    error: "code-match execution error: str",
  },
  {
    label: "TypeError on a missing field",
    code: "(input) => input.missing.deep",
    errorPrefix: "code-match execution error: ",
  },
  {
    label: "syntax error",
    code: "(input) => {",
    errorPrefix: "code-match execution error: ",
  },
  {
    label: "strict-mode assignment to an undeclared name",
    code: "() => { undeclaredName = 1; return 'a'; }",
    errorPrefix: "code-match execution error: ",
  },
];

const BASE_TRIGGER = { n: 3, s: "hi", flag: true, arr: [1, 2, { k: "v" }] };

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function runCodeCase(ctx: ScenarioContext, c: CodeCase, index: number): Promise<void> {
  const workflowId = await createWorkflow(ctx, `predicate-compat-code-${index}`, {
    nodes: [{ id: "cm", type: "code-match", config: { code: c.code, outputPorts: PORTS } }],
  });
  const { runId } = await triggerWorkflow(ctx, workflowId, c.trigger ?? BASE_TRIGGER);
  const wanted = c.port === undefined ? "failed" : "completed";
  const detail = await waitForRun(ctx, runId, wanted, 15_000, `code-match "${c.label}"`);
  const step = stepOf(detail, "cm");
  if (c.port !== undefined) {
    const output = asRecord(step.output);
    expect(
      step.nextPort === c.port && output.port === c.port,
      `"${c.label}": port ${String(step.nextPort)}, want ${c.port}`,
    );
    if (c.raw === ABSENT) {
      expect(output.rawResult === undefined, `"${c.label}": rawResult should be absent`);
    } else if ("raw" in c) {
      expect(
        sameJson(output.rawResult, c.raw),
        `"${c.label}": rawResult ${JSON.stringify(output.rawResult)}, want ${JSON.stringify(c.raw)}`,
      );
    }
    return;
  }
  const error = String(step.error ?? "");
  if (c.error !== undefined) {
    expect(error === c.error, `"${c.label}": error ${JSON.stringify(error)}, want ${c.error}`);
  } else {
    expect(
      error.startsWith(c.errorPrefix ?? "") && error.length > (c.errorPrefix ?? "").length,
      `"${c.label}": error ${JSON.stringify(error)}, want prefix ${c.errorPrefix}`,
    );
  }
}

// The upstream node's output reaches a downstream code-match through `inputs`.
async function runInputsCase(ctx: ScenarioContext): Promise<void> {
  const workflowId = await createWorkflow(ctx, "predicate-compat-inputs", {
    nodes: [
      {
        id: "first",
        type: "code-match",
        config: { code: "(input) => (input.trigger.n > 2 ? 'a' : 'skip')", outputPorts: PORTS },
        next: { a: "second" },
      },
      {
        id: "second",
        type: "code-match",
        inputs: { up: "first" },
        config: {
          code: "(input) => (input.up.port === 'a' && input.up.rawResult === 'a' ? 'run' : 'skip')",
          outputPorts: PORTS,
        },
      },
    ],
  });
  const { runId } = await triggerWorkflow(ctx, workflowId, BASE_TRIGGER);
  const detail = await waitForRun(ctx, runId, "completed", 15_000, "code-match inputs");
  expect(stepOf(detail, "second").nextPort === "run", "downstream code-match read inputs.up");
}

const PAYLOAD = { go: true, n: 5, s: "hi", tags: ["a", "b"], o: { k: 1 } };

type FilterCase = { label: string; filter: unknown; match: boolean };

const FILTER_CASES: FilterCase[] = [
  // String filters: `!!` of the return value.
  { label: "strict equality", filter: "(p) => p.go === true", match: true },
  { label: "false return", filter: "(p) => p.go === false", match: false },
  { label: "truthy number", filter: "(p) => p.n", match: true },
  { label: "zero", filter: "() => 0", match: false },
  { label: "non-empty string", filter: "() => 'yes'", match: true },
  { label: "empty string", filter: "() => ''", match: false },
  { label: "null", filter: "() => null", match: false },
  { label: "undefined", filter: "() => undefined", match: false },
  { label: "object", filter: "() => ({})", match: true },
  { label: "empty array", filter: "() => []", match: true },
  {
    label: "array and nested access",
    filter: "(p) => p.tags.includes('a') && p.o.k === 1 && Object.keys(p).length === 5",
    match: true,
  },
  { label: "function expression", filter: "function (p) { return p.n > 1; }", match: true },
  { label: "regex", filter: "(p) => /^h/.test(p.s)", match: true },
  { label: "console stays callable", filter: "(p) => { console.log(p); return true; }", match: true },
  { label: "thrown Error", filter: "() => { throw new Error('x'); }", match: false },
  { label: "missing field TypeError", filter: "(p) => p.missing.x", match: false },
  { label: "async filter", filter: "async () => true", match: false },
  {
    label: "host globals are hidden",
    filter: "() => typeof process !== 'undefined' || typeof require !== 'undefined'",
    match: false,
  },
  // Object filters: every key deep-equal.
  { label: "object one key", filter: { go: true }, match: true },
  { label: "object several keys", filter: { go: true, n: 5 }, match: true },
  { label: "object nested", filter: { o: { k: 1 }, tags: ["a", "b"] }, match: true },
  { label: "object type mismatch", filter: { n: "5" }, match: false },
  { label: "object missing key", filter: { missing: 1 }, match: false },
];

async function parkedAt(ctx: ScenarioContext, runId: string): Promise<boolean> {
  return pollUntil(
    async () => {
      const { run, steps } = await getRunDetail(ctx, runId);
      return run.status === "waiting" && steps.some((s) => s.nodeId === "wait");
    },
    10_000,
    100,
  );
}

async function runFilterCase(ctx: ScenarioContext, c: FilterCase, index: number): Promise<void> {
  const eventName = `e2e.predicate.compat.${ctx.nonce}.${index}`;
  const workflowId = await createWorkflow(ctx, `predicate-compat-filter-${index}`, {
    nodes: [
      {
        id: "wait",
        type: "wait",
        config: { mode: "event", eventName, scope: "global", filter: c.filter },
      },
    ],
  });
  const { runId } = await triggerWorkflow(ctx, workflowId);
  expect(await parkedAt(ctx, runId), `filter "${c.label}": the run never parked`);
  const sent = await ctx.api("POST", "/api/workflow-events", {
    body: { name: eventName, payload: PAYLOAD },
  });
  expectStatus(sent, [200], `filter "${c.label}": send event`);
  if (c.match) {
    const done = await waitForRun(ctx, runId, "completed", 10_000, `filter "${c.label}"`);
    const payload = asRecord(asRecord(stepOf(done, "wait").output).payload);
    expect(sameJson(payload, PAYLOAD), `filter "${c.label}": wait output carries the payload`);
  } else {
    const detail: RunDetail = await getRunDetail(ctx, runId);
    expect(detail.run.status === "waiting", `filter "${c.label}" matched; it should not`);
  }
}

// A filter that mutates its argument must not change the payload the wait stores.
async function runMutationCase(ctx: ScenarioContext): Promise<void> {
  await runFilterCase(
    ctx,
    { label: "mutating filter", filter: "(p) => { p.go = false; p.n = 0; return true; }", match: true },
    FILTER_CASES.length,
  );
}

// A string filter that does not parse fails the wait node at init.
async function runCompileErrorCase(ctx: ScenarioContext): Promise<void> {
  const workflowId = await createWorkflow(ctx, "predicate-compat-filter-syntax", {
    nodes: [
      {
        id: "wait",
        type: "wait",
        config: {
          mode: "event",
          eventName: `e2e.predicate.compat.${ctx.nonce}.syntax`,
          scope: "global",
          filter: "(p) => {",
        },
      },
    ],
  });
  const { runId } = await triggerWorkflow(ctx, workflowId);
  const detail = await waitForRun(ctx, runId, "failed", 10_000, "filter syntax error");
  const error = String(stepOf(detail, "wait").error ?? "");
  expect(error.includes("wait filter compile error"), `filter syntax error: ${error}`);
}

export const workflowPredicateCompat: Scenario = {
  name: "workflow-predicate-compat",
  order: 328,
  async run(ctx) {
    await Promise.all([
      ...CODE_CASES.map((c, i) => runCodeCase(ctx, c, i)),
      runInputsCase(ctx),
      ...FILTER_CASES.map((c, i) => runFilterCase(ctx, c, i)),
      runMutationCase(ctx),
      runCompileErrorCase(ctx),
    ]);
  },
};
