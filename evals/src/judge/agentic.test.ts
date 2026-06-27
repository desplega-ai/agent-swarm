import { describe, expect, test } from "bun:test";
import type { JudgeContext, JudgeWorkerContext } from "../types.ts";
import { readWorkerFile, runWorkerCommand } from "./agentic.ts";
import { renderRosterManifest, truncateMiddle } from "./llm.ts";

/** A JudgeWorkerContext whose exec/readFile echo their target index. */
function worker(index: number, over: Partial<JudgeWorkerContext> = {}): JudgeWorkerContext {
  return {
    index,
    agentId: `agent-${index}`,
    exec: async (cmd) => ({ exitCode: 0, stdout: `w${index}:${cmd}`, stderr: "" }),
    readFile: async (path) => `w${index}:${path}`,
    ...over,
  };
}

function ctxWith(workers: JudgeWorkerContext[]): JudgeContext {
  return {
    tasks: [],
    transcript: "",
    exec: workers[0]?.exec ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    readFile: workers[0]?.readFile ?? (async () => null),
    apiGet: async () => ({}),
    workers,
  };
}

describe("renderRosterManifest", () => {
  test("renders every worker with name/template/role and marks the lead", () => {
    const workers = [
      worker(0, { name: "scribe-a", template: "researcher", role: "worker", isLead: false }),
      worker(1, { name: "auditor-b", template: "coder", role: "worker", isLead: false }),
      worker(2, { name: "Lead", template: "coordinator", role: "lead", isLead: true }),
    ];
    const manifest = renderRosterManifest(workers);
    // Every worker rendered, in order, with its labels.
    expect(manifest).toContain("## Workers in this attempt");
    expect(manifest).toContain('- worker 0: name "scribe-a", template "researcher", role worker');
    expect(manifest).toContain('- worker 1: name "auditor-b", template "coder", role worker');
    expect(manifest).toContain('- worker 2: name "Lead", template "coordinator", role lead');
    // Exactly one worker is flagged as the lead.
    expect(manifest.match(/← LEAD/g) ?? []).toHaveLength(1);
    expect(manifest).toContain("role lead  ← LEAD");
    // One bullet per worker.
    expect(manifest.split("\n").filter((l) => l.startsWith("- worker"))).toHaveLength(3);
  });

  test("falls back to placeholders for missing metadata and infers lead from role", () => {
    const manifest = renderRosterManifest([worker(0, { role: "lead" })]);
    expect(manifest).toContain(
      '- worker 0: name "worker-0", template "(default)", role lead  ← LEAD',
    );
  });

  test("renders nothing for an empty roster (back-compat)", () => {
    expect(renderRosterManifest([])).toBe("");
  });
});

describe("worker tool dispatch", () => {
  test("run_command targets the requested worker", async () => {
    const ctx = ctxWith([worker(0), worker(1), worker(2)]);
    // (a) worker: 1 dispatches to ctx.workers[1].exec
    expect(await runWorkerCommand(ctx, "ls", 1)).toMatchObject({ stdout: "w1:ls" });
    // default selects worker 0 (back-compat)
    expect(await runWorkerCommand(ctx, "pwd")).toMatchObject({ stdout: "w0:pwd" });
  });

  test("read_file targets the requested worker", async () => {
    const ctx = ctxWith([worker(0), worker(1)]);
    expect(await readWorkerFile(ctx, "/x", 1)).toMatchObject({
      exists: true,
      content: "w1:/x",
    });
  });

  test("out-of-range worker returns an error object, not a throw", async () => {
    const ctx = ctxWith([worker(0)]);
    // (b) out-of-range returns { error }, never throws
    expect(await runWorkerCommand(ctx, "ls", 5)).toEqual({ error: "no such worker: 5" });
    expect(await readWorkerFile(ctx, "/x", 9)).toEqual({ error: "no such worker: 9" });
  });
});

describe("transcript truncation (agentic uses head+tail like llm.ts)", () => {
  test("a >60k transcript retains a tail sentinel after truncateMiddle", () => {
    const TAIL = "FINAL_REPORT_SENTINEL_END";
    // Build a transcript well past the 60k cap with a sentinel at the very end.
    const transcript = `${"head ".repeat(20_000)}${TAIL}`;
    expect(transcript.length).toBeGreaterThan(60_000);

    const truncated = truncateMiddle(transcript, 60_000);
    // (d) the tail (final-report text) survives — head-only slicing would drop it.
    expect(truncated).toContain(TAIL);
    expect(truncated).toContain("chars truncated");
    // Head is also present, and the result stays bounded (head + tail + marker).
    expect(truncated.startsWith("head ")).toBe(true);
    expect(truncated.length).toBeLessThan(61_000);
  });

  test("short transcripts pass through unchanged", () => {
    expect(truncateMiddle("short", 60_000)).toBe("short");
  });
});
