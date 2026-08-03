import { describe, expect, test } from "bun:test";
import dreamAgentSlice from "../be/seed-scripts/catalog/dream-agent-slice";
import dreamApply from "../be/seed-scripts/catalog/dream-apply";
import dreamReceipt, { renderDreamReceipt } from "../be/seed-scripts/catalog/dream-receipt";
import {
  ApprovedDeltaSetSchema,
  applyAnchoredProfileOp,
  assertSubsetSafe,
  getH2Anchors,
  ReflectionDeltaSchema,
  validateReflectionDelta,
} from "../be/seed-scripts/dream-schemas";

describe("dream scripts", () => {
  const profile = "## Working style\nKeep changes small.\n\n## Notes\nUseful detail.\n".padEnd(
    220,
    "x",
  );

  test("an exactly-once anchor applies an append-under operation", () => {
    const result = applyAnchoredProfileOp(profile, {
      file: "SOUL",
      op: "append-under",
      anchor: "## Working style",
      content: "Prefer evidence.",
    });
    expect(result).toMatchObject({ applied: true });
    if (result.applied)
      expect(result.text).toContain(
        "## Working style\nKeep changes small.\n\nPrefer evidence.\n\n## Notes",
      );
  });

  test("fenced H2 lines are neither surfaced nor matched as anchors", () => {
    const fenced = ["```md", "## Heading", "```", "~~~md", "## Tilde hidden", "~~~", ""].join("\n");

    expect(getH2Anchors(fenced)).toEqual([]);
    expect(
      applyAnchoredProfileOp(fenced, {
        file: "CLAUDE",
        op: "replace-section",
        anchor: "## Heading",
        content: "No splice.",
      }),
    ).toEqual({ applied: false, reason: "anchor not found: ## Heading" });

    const sameHeadingOutside = `${fenced}## Heading\nBody.\n`;
    expect(getH2Anchors(sameHeadingOutside)).toEqual(["## Heading"]);
    expect(
      applyAnchoredProfileOp(sameHeadingOutside, {
        file: "CLAUDE",
        op: "replace-section",
        anchor: "## Heading",
        content: "Changed.",
      }),
    ).toMatchObject({ applied: true });
  });

  test("a trailing-whitespace heading matches a trimmed anchor", () => {
    expect(
      applyAnchoredProfileOp("## Notes   \nOld.\n", {
        file: "CLAUDE",
        op: "replace-section",
        anchor: "  ## Notes  ",
        content: "New.",
      }),
    ).toEqual({ applied: true, text: "## Notes   \nNew.\n" });
  });

  test("profile content cannot introduce an H2 heading", () => {
    expect(
      applyAnchoredProfileOp("## Notes\nOld.\n", {
        file: "CLAUDE",
        op: "append-under",
        anchor: "## Notes",
        content: "New detail.\n## Duplicate",
      }),
    ).toEqual({ applied: false, reason: "content must not introduce H2 headings" });
  });

  test("append-under adds content at the section end before the next H2 and at EOF", () => {
    expect(
      applyAnchoredProfileOp("## First\nOriginal.\n\n## Second\nOther.\n", {
        file: "CLAUDE",
        op: "append-under",
        anchor: "## First",
        content: "Appended.",
      }),
    ).toEqual({
      applied: true,
      text: "## First\nOriginal.\n\nAppended.\n\n## Second\nOther.\n",
    });
    expect(
      applyAnchoredProfileOp("## Only\nOriginal.\n", {
        file: "CLAUDE",
        op: "append-under",
        anchor: "## Only",
        content: "Appended.",
      }),
    ).toEqual({ applied: true, text: "## Only\nOriginal.\n\nAppended.\n" });
  });

  test("replace-section preserves a blank line before the next H2", () => {
    expect(
      applyAnchoredProfileOp("## First\nOld.\n\n## Second\nOther.\n", {
        file: "CLAUDE",
        op: "replace-section",
        anchor: "## First",
        content: "New.",
      }),
    ).toEqual({ applied: true, text: "## First\nNew.\n\n## Second\nOther.\n" });
  });

  test("a missing anchor is held", () => {
    expect(
      applyAnchoredProfileOp(profile, {
        file: "SOUL",
        op: "append-under",
        anchor: "## Missing",
        content: "Nope",
      }),
    ).toMatchObject({ applied: false, reason: "anchor not found: ## Missing" });
  });

  test("an ambiguous anchor is held", () => {
    expect(
      applyAnchoredProfileOp("## Same\na\n## Same\nb\n".padEnd(220, "x"), {
        file: "SOUL",
        op: "replace-section",
        anchor: "## Same",
        content: "c",
      }),
    ).toMatchObject({ applied: false, reason: "anchor is ambiguous: ## Same" });
  });

  test("remove-section removes through the next same-level heading", () => {
    const result = applyAnchoredProfileOp("## Remove\na\n### Keep nested\nb\n## Keep\nc\n", {
      file: "CLAUDE",
      op: "remove-section",
      anchor: "## Remove",
    });
    expect(result).toEqual({ applied: true, text: "## Keep\nc\n" });
  });

  test("a soul edit below the profile guard is held", () => {
    expect(
      applyAnchoredProfileOp("## Only\n".padEnd(210, "x"), {
        file: "SOUL",
        op: "replace-section",
        anchor: "## Only",
        content: "short",
      }),
    ).toMatchObject({ applied: false, reason: "SOUL would be shorter than 200 characters" });
  });

  test("shipped schemas stay in the workflow JSON-schema subset", () => {
    expect(() => assertSubsetSafe(ReflectionDeltaSchema)).not.toThrow();
    expect(() => assertSubsetSafe(ApprovedDeltaSetSchema)).not.toThrow();
    expect(() => assertSubsetSafe({ type: "object", oneOf: [] })).toThrow(
      'unsupported JSON Schema keyword "oneOf"',
    );
  });

  test("tagged-union validation rejects fields from another kind", () => {
    expect(
      validateReflectionDelta({
        kind: "memory",
        agentId: "agent-1",
        action: "write",
        content: "remember this",
        anchor: "## wrong-kind-field",
      }),
    ).toContain("unexpected field(s) for memory: anchor");
  });

  test("receipt includes held lines", () => {
    expect(
      renderDreamReceipt(
        {
          applied: [],
          held: [{ delta: { agentId: "agent-1", kind: "profile-op" }, reason: "anchor not found" }],
          deferred: [],
        },
        "2026-08-03",
      ),
    ).toContain("HELD (1)\nagent-1: profile-op — anchor not found");
  });

  test("receipt keeps the memory record when Slack posting fails", async () => {
    const memories: string[] = [];
    const result = await dreamReceipt(
      { apply: { applied: [], held: [], deferred: [] }, date: "2026-08-03" },
      {
        stdlib: { Redacted: { value: () => "agent-1" } },
        swarm: {
          config: { agentId: "redacted-agent" },
          async inject_learning({ learning }: { learning: string }) {
            memories.push(learning);
            return { success: true, data: { success: true } };
          },
          async config_get() {
            return {
              success: true,
              data: {
                configs: [
                  { key: "SOME_OTHER_CHANNEL", value: "wrong-channel" },
                  { key: "DREAMING_SLACK_CHANNEL", value: "dream-channel" },
                ],
              },
            };
          },
          async slack_post({ channelId }: { channelId: string }) {
            expect(channelId).toBe("dream-channel");
            return { success: false, data: { error: "Slack unavailable" } };
          },
        },
      },
    );

    expect(memories).toHaveLength(1);
    expect(result).toMatchObject({
      slackPosted: false,
      slackError: "Dreaming Slack post failed: Slack unavailable",
    });
  });

  test("agent slice reports workflow step retryCount instead of task-type guesses", async () => {
    const queries: string[] = [];
    const result = await dreamAgentSlice(
      { agentId: "agent-1" },
      {
        swarm: {
          async db_query({ sql }: { sql: string }) {
            queries.push(sql);
            if (sql.includes("LEFT JOIN workflow_run_steps")) {
              return {
                columns: [
                  "id",
                  "status",
                  "taskType",
                  "failureReason",
                  "createdAt",
                  "finishedAt",
                  "workflowRunStepId",
                  "retryCount",
                ],
                rows: [["task-1", "completed", "workflow", null, "now", "now", "step-1", 2]],
              };
            }
            return { columns: [], rows: [] };
          },
        },
      },
    );

    expect(queries[0]).toContain("COALESCE(wrs.retryCount, 0) AS retryCount");
    expect(result.tasks.summary).toMatchObject({ retries: 2, resumes: 0 });
    expect(result.tasks.recent[0]).toMatchObject({ workflowRunStepId: "step-1", retryCount: 2 });
  });
});

describe("dream-apply batches", () => {
  test("a validator-rejected delta is held while a valid sibling applies", async () => {
    const writes: string[] = [];
    const result = await dreamApply(
      {
        deltas: {
          deltas: [
            {
              kind: "memory",
              agentId: "agent-1",
              action: "write",
              content: "invalid sibling",
              anchor: "## stray field",
            },
            {
              kind: "memory",
              agentId: "agent-1",
              action: "write",
              content: "valid sibling",
            },
          ],
        },
      },
      {
        swarm: {
          async inject_learning({ learning }: { learning: string }) {
            writes.push(learning);
            return { success: true, data: { success: true } };
          },
        },
      },
    );

    expect(writes).toEqual(["valid sibling"]);
    expect(result.applied).toHaveLength(1);
    expect(result.held).toHaveLength(1);
    expect(result.held[0]?.reason).toBe("unexpected field(s) for memory: anchor");
    expect(result.deferred).toEqual([]);
  });

  test("a hygiene profile write stays applied when its cursor advance fails", async () => {
    const updates: unknown[] = [];
    const result = await dreamApply(
      {
        deltas: [
          {
            kind: "hygiene",
            agentId: "agent-1",
            op: "append-under",
            anchor: "## Rotation",
            content: "New rotation item.",
            rotationCursorKey: "dream-cursor",
          },
        ],
      },
      {
        swarm: {
          async db_query() {
            return { success: true, data: { rows: [["## Rotation\nExisting.\n"]] } };
          },
          async profile_update(update: unknown) {
            updates.push(update);
            return { success: true, data: { success: true } };
          },
          async kv_incr() {
            return { success: false, data: { error: "cursor store unavailable" } };
          },
        },
      },
    );

    expect(updates).toHaveLength(1);
    expect(result.applied).toEqual([
      expect.objectContaining({
        kind: "hygiene",
        cursorError: "rotation cursor advance failed: cursor store unavailable",
      }),
    ]);
    expect(result.deferred).toEqual([]);
  });
});
