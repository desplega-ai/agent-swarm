import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createScriptRun,
  getDbClient,
  getRunningScriptRuns,
  getScriptRunJournalStep,
  initDb,
  listScriptRunJournalSteps,
  recordInlineScriptRun,
  updateScriptRun,
  updateScriptRunIfNotTerminal,
  updateScriptRunIfRunning,
  upsertScriptRunJournalStep,
} from "../be/db";
import { breaksJsonValidity, scrubJsonValue } from "../be/scrub-json";
import { isSealedJson } from "../be/sealed-json";
import {
  localProcessScriptExecutor,
  type ScriptExecutionResult,
  type StartScriptExecutionInput,
} from "../script-workflows/executor";
import { setScriptRunExecutor, startScriptRunProcess } from "../script-workflows/supervisor";
import { refreshSecretScrubberCache, scrubSecrets } from "../utils/secret-scrubber";
import { randomToken, type SyntheticSecret, syntheticSecret } from "./synthetic-secret-helpers";

const TEST_DB_PATH = "./test-script-runs-scrub.sqlite";
const AGENT_ID = "5c2b0000-0000-4000-8000-0000000012c0";
// Distinctive non-secret context that must survive redaction.
const CONTEXT = "wombatlantern";

let known: SyntheticSecret;
let ghToken: string;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
}

/** Free text carrying a registered known value and a structural GitHub token. */
function secretText(label: string): string {
  return `${label} ${CONTEXT} known=${known.value} gh=${ghToken} end`;
}

function expectRedacted(value: string | null | undefined, where: string): void {
  expect(value, where).toBeString();
  expect(value!.includes(known.value), `${where} still holds the known value`).toBe(false);
  expect(value!.includes(ghToken), `${where} still holds the token`).toBe(false);
  expect(value!, where).toContain("[REDACTED:");
  expect(value!, where).toContain(CONTEXT);
}

async function runRow(id: string) {
  return getDbClient().get<{ args: string; output: string | null; error: string | null }>(
    "SELECT args, output, error FROM script_runs WHERE id = ?",
    [id],
  );
}

async function seedRun(): Promise<string> {
  const id = crypto.randomUUID();
  await createScriptRun({ id, agentId: AGENT_ID, source: "export default () => 1", args: null });
  await updateScriptRun(id, { status: "running" });
  return id;
}

describe("script run writers scrub at write", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    ghToken = ["ghp", randomToken(36)].join("_");
  });

  afterAll(async () => {
    known.cleanup();
    refreshSecretScrubberCache();
    closeDb();
    await removeDbFiles();
  });

  beforeEach(async () => {
    // The test preload clears volatile secrets after every test.
    known = syntheticSecret("scriptrun");
    refreshSecretScrubberCache();
    await getDbClient().run("DELETE FROM script_run_journal");
    await getDbClient().run("DELETE FROM script_runs");
  });

  test("recordInlineScriptRun redacts args, output and error", async () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await recordInlineScriptRun({
      id,
      agentId: AGENT_ID,
      source: "export default () => 1",
      args: { note: secretText("args") },
      status: "failed",
      output: { lines: [secretText("output")] },
      error: scrubSecrets(secretText("error")),
      startedAt: now,
      finishedAt: now,
    });
    const row = await runRow(id);
    expectRedacted(row?.args, "args");
    expectRedacted(row?.output, "output");
    expectRedacted(row?.error, "error");
    // JSON columns still parse for readers.
    expect((JSON.parse(row!.args) as { note: string }).note).toContain(CONTEXT);
    expect((JSON.parse(row!.output!) as { lines: string[] }).lines[0]).toContain(CONTEXT);
  });

  test("createScriptRun seals args: nothing readable at rest, redacted for callers", async () => {
    const id = crypto.randomUUID();
    const args = { note: secretText("launch") };
    const { run } = await createScriptRun({
      id,
      agentId: AGENT_ID,
      source: "export default () => 1",
      args,
    });
    const stored = (await runRow(id))?.args ?? "";
    expect(isSealedJson(stored)).toBe(true);
    expect(stored.includes(known.value)).toBe(false);
    expect(stored.includes(ghToken)).toBe(false);
    expect(stored.includes(CONTEXT)).toBe(false);
    expectRedacted((run.args as { note: string }).note, "run.args");
  });

  test("a relaunch after restart executes with the exact sealed args", async () => {
    const id = crypto.randomUUID();
    const args = { note: secretText("relaunch"), n: 3 };
    await createScriptRun({ id, agentId: AGENT_ID, source: "export default () => 1", args });
    await updateScriptRun(id, { status: "running" });

    // A restarted API sees the run as running with no live process and
    // relaunches it from the row, as reconcileScriptRuns does.
    const [recovered] = await getRunningScriptRuns();
    expect(recovered?.id).toBe(id);
    expectRedacted((recovered!.args as { note: string }).note, "recovered.args");

    let launched: StartScriptExecutionInput | undefined;
    let exit!: (result: ScriptExecutionResult) => void;
    setScriptRunExecutor({
      async start(input) {
        launched = input;
        return {
          pid: null,
          tmpdir: "/tmp",
          startedAtMs: Date.now(),
          exited: new Promise((resolve) => {
            exit = resolve;
          }),
          async terminate() {},
          async cleanup() {},
        };
      },
      isRunning: () => false,
      async terminatePid() {},
    });
    try {
      await startScriptRunProcess(recovered!, "http://127.0.0.1:1", "test-key");
      expect(launched?.run.args).toEqual(args);
    } finally {
      exit({ exitCode: 0, stderr: "" });
      setScriptRunExecutor(localProcessScriptExecutor);
    }
  });

  test("updateScriptRun redacts output and error", async () => {
    const id = await seedRun();
    await updateScriptRun(id, {
      status: "failed",
      output: { summary: secretText("output") },
      error: secretText("error"),
    });
    const row = await runRow(id);
    expectRedacted(row?.output, "output");
    expectRedacted(row?.error, "error");
    expect((JSON.parse(row!.output!) as { summary: string }).summary).toContain(CONTEXT);
  });

  test("updateScriptRunIfRunning redacts the supervisor's stderr error", async () => {
    const id = await seedRun();
    const claimed = await updateScriptRunIfRunning(id, {
      status: "failed",
      pid: null,
      finishedAt: new Date().toISOString(),
      error: `Traceback\n${secretText("stderr")}\n`,
    });
    expect(claimed).toBe(true);
    expectRedacted((await runRow(id))?.error, "error");
  });

  test("updateScriptRunIfNotTerminal redacts output", async () => {
    const id = await seedRun();
    const claimed = await updateScriptRunIfNotTerminal(id, {
      status: "completed",
      output: secretText("output"),
    });
    expect(claimed).toBe(true);
    const output = (await runRow(id))?.output;
    expectRedacted(output, "output");
    expect(JSON.parse(output!)).toContain(CONTEXT);
  });

  test("null error and output still clear the columns", async () => {
    const id = await seedRun();
    await updateScriptRun(id, { output: { a: 1 }, error: "boom" });
    await updateScriptRun(id, { output: undefined, error: null });
    const row = await runRow(id);
    expect(row?.output).toBeNull();
    expect(row?.error).toBeNull();
  });

  test("upsertScriptRunJournalStep redacts config and error, seals result for replay", async () => {
    const id = await seedRun();
    const result = { text: secretText("result") };
    await upsertScriptRunJournalStep({
      runId: id,
      stepKey: "fetch",
      stepType: "raw-llm",
      config: { prompt: secretText("config") },
      status: "failed",
      result,
      error: scrubSecrets(secretText("error")),
    });
    const row = await getDbClient().get<{
      config: string;
      result: string | null;
      error: string | null;
    }>("SELECT config, result, error FROM script_run_journal WHERE runId = ?", [id]);
    expectRedacted(row?.config, "config");
    expectRedacted(row?.error, "error");
    expect((JSON.parse(row!.config) as { prompt: string }).prompt).toContain(CONTEXT);
    // Replay contract: the harness returns this verbatim as the step result,
    // so it is sealed at rest and opened exactly only on the replay route.
    expect(isSealedJson(row?.result ?? "")).toBe(true);
    expect(row!.result!.includes(known.value)).toBe(false);
    expect(row!.result!.includes(ghToken)).toBe(false);
    expect((await getScriptRunJournalStep(id, "fetch"))?.result).toEqual(result);
    const [listed] = await listScriptRunJournalSteps(id);
    expectRedacted((listed?.result as { text: string }).text, "listed result");
  });
});

describe("scrubJsonValue", () => {
  test("output always parses and keeps non-secret structure", () => {
    known = syntheticSecret("jsonguard");
    refreshSecretScrubberCache();
    try {
      const value = { a: [`k=${known.value}`, 2], b: { c: CONTEXT }, d: null };
      const out = scrubJsonValue(value);
      expect(out.includes(known.value)).toBe(false);
      expect(out).toContain("[REDACTED:");
      expect(JSON.parse(out)).toEqual({
        a: [expect.stringContaining("[REDACTED:"), 2],
        b: { c: CONTEXT },
        d: null,
      });
    } finally {
      known.cleanup();
      refreshSecretScrubberCache();
    }
  });

  test("breaksJsonValidity flags only a valid-to-invalid change", () => {
    expect(breaksJsonValidity('{"a":"x"}', '{"a":"[REDACTED:x]')).toBe(true);
    expect(breaksJsonValidity('{"a":"x"}', '{"a":"[REDACTED:x]"}')).toBe(false);
    expect(breaksJsonValidity("not json", "still not")).toBe(false);
  });
});
