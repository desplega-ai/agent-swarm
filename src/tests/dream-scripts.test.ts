import { describe, expect, test } from "bun:test";
import dreamAgentSlice from "../be/seed-scripts/catalog/dream-agent-slice";
import dreamApply from "../be/seed-scripts/catalog/dream-apply";
import dreamGather from "../be/seed-scripts/catalog/dream-gather";
import dreamReceipt, { renderDreamReceipt } from "../be/seed-scripts/catalog/dream-receipt";
import ghPrSnapshot from "../be/seed-scripts/catalog/gh-pr-snapshot";
import {
  ApprovedDeltaSetSchema,
  applyAnchoredProfileOp,
  assertSubsetSafe,
  getH2Anchors,
  ReflectionDeltaSchema,
  validateReflectionDelta,
} from "../be/seed-scripts/dream-schemas";

const SLIM_GATHER_RESULT = {
  enabled: false,
  hasActivity: false,
  agents: [],
  leadAgentId: null,
  insights: null,
  blockers: [],
};

function gatherHarness({
  configValue,
  activity = { completedTasks: 1, failedTasks: 0 },
  roster = [],
}: {
  configValue?: string;
  activity?: { completedTasks: number; failedTasks: number };
  roster?: Array<Record<string, unknown>>;
} = {}) {
  const calls: string[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    queries,
    ctx: {
      swarm: {
        async config_get() {
          calls.push("config_get");
          return {
            success: true,
            data: {
              configs:
                configValue === undefined ? [] : [{ key: "DREAMING_ENABLED", value: configValue }],
            },
          };
        },
        async db_query({ sql, params = [] }: { sql: string; params?: unknown[] }) {
          queries.push({ sql, params });
          if (sql.includes("AS completedTasks")) {
            calls.push("activity_query");
            return { success: true, data: { rows: [activity] } };
          }
          if (sql.includes("FROM agents")) {
            calls.push("roster_query");
            return { success: true, data: { rows: roster } };
          }
          calls.push("expensive_query");
          return { success: true, data: { rows: [] } };
        },
        async script_run() {
          calls.push("compound_insights");
          return { success: true, data: { exitCode: 0, result: { summary: "ok" } } };
        },
        async skill_list() {
          calls.push("skill_list");
          return { success: true, data: { skills: [] } };
        },
        async kv_getOrNull() {
          calls.push("kv_getOrNull");
          return null;
        },
      },
    },
  };
}

describe("dream-gather gates", () => {
  test("disabled config returns the exact slim shape before any other call", async () => {
    const harness = gatherHarness({ configValue: "false" });

    expect(await dreamGather({}, harness.ctx)).toEqual({
      ...SLIM_GATHER_RESULT,
      reason: "disabled",
    });
    expect(harness.calls).toEqual(["config_get"]);
  });

  test("invalid config warns and continues as enabled", async () => {
    const harness = gatherHarness({
      configValue: "sometimes",
      roster: [{ id: "lead-1", name: "Lead", isLead: 1 }],
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      const result = await dreamGather({}, harness.ctx);
      expect(result).toMatchObject({ enabled: true, hasActivity: true, leadAgentId: "lead-1" });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([
      'DREAMING_ENABLED has invalid boolean value "sometimes"; treating it as enabled',
    ]);
    expect(harness.calls).toContain("compound_insights");
  });

  test("no activity returns the exact slim shape before roster or expensive reads", async () => {
    const harness = gatherHarness({
      activity: { completedTasks: 0, failedTasks: 0 },
    });

    expect(await dreamGather({}, harness.ctx)).toEqual({
      ...SLIM_GATHER_RESULT,
      reason: "no-activity",
    });
    expect(harness.calls).toEqual(["config_get", "activity_query"]);
  });

  test("the activity query excludes the add-on's own runs and never counts memory writes", async () => {
    const harness = gatherHarness({ roster: [{ id: "lead-1", name: "Lead", isLead: 1 }] });
    await dreamGather({ preflightOnly: true }, harness.ctx);

    const activityQuery = harness.queries.find((query) => query.sql.includes("AS completedTasks"));
    expect(activityQuery).toBeDefined();
    // Dream's own reflection/critique tasks carry the run id; excluding them is what keeps
    // a quiet swarm quiet instead of re-arming the gate off last night's dream.
    expect(activityQuery!.sql).toContain("t.workflowRunId NOT IN");
    expect(activityQuery!.params).toEqual(["-1 days", "dream", "-1 days", "dream"]);
    // Memory writes are unattributable (inject_learning records no provenance) and the
    // receipt writes one every run, so they are deliberately not part of the signal.
    expect(activityQuery!.sql).not.toContain("agent_memory");

    const renamed = gatherHarness({ roster: [{ id: "lead-1", name: "Lead", isLead: 1 }] });
    await dreamGather({ preflightOnly: true, selfWorkflowName: "nightly-dream" }, renamed.ctx);
    expect(
      renamed.queries.find((query) => query.sql.includes("AS completedTasks"))!.params,
    ).toEqual(["-1 days", "nightly-dream", "-1 days", "nightly-dream"]);
  });

  test("no live Lead returns the exact slim shape before expensive gathering", async () => {
    const harness = gatherHarness({
      roster: [{ id: "worker-1", name: "Worker", isLead: 0 }],
    });

    expect(await dreamGather({}, harness.ctx)).toEqual({
      ...SLIM_GATHER_RESULT,
      reason: "no-lead",
    });
    expect(harness.calls).toEqual(["config_get", "activity_query", "roster_query"]);
  });

  test("multiple live Leads warn and use the first deterministic roster row", async () => {
    const harness = gatherHarness({
      roster: [
        { id: "lead-a", name: "Alpha", isLead: 1 },
        { id: "lead-b", name: "Beta", isLead: 1 },
      ],
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      expect(await dreamGather({}, harness.ctx)).toMatchObject({ leadAgentId: "lead-a" });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([
      "Dreaming found 2 live Lead agents; using lead-a by roster ordering",
    ]);
  });

  test("preflight returns the discovered Lead before nested or other expensive calls", async () => {
    const harness = gatherHarness({
      roster: [{ id: "lead-1", name: "Lead", isLead: 1 }],
    });

    expect(await dreamGather({ preflightOnly: true }, harness.ctx)).toEqual({
      enabled: true,
      hasActivity: true,
      agents: [{ id: "lead-1", name: "Lead" }],
      leadAgentId: "lead-1",
      insights: null,
      blockers: [],
      reason: "ready",
    });
    expect(harness.calls).toEqual(["config_get", "activity_query", "roster_query"]);
  });

  test("profile evidence is bounded and keeps exact fence-safe H2 anchors", async () => {
    const soul = ["```md", "## Fenced", "```", "## Visible", "x".repeat(700)].join("\n");
    const harness = gatherHarness({
      roster: [{ id: "lead-1", name: "Lead", isLead: 1, soulMd: soul }],
    });

    const result = await dreamGather({}, harness.ctx);
    expect(result.insights.profileEvidence[0].files.SOUL).toEqual({
      excerpt: `${soul.slice(0, 600)}…`,
      h2Anchors: ["## Visible"],
    });
    expect(result.blockers.rotation.target).toBeNull();
    expect(result.blockers.rotation.snapshotArgs).toEqual({ skipIfMissing: true });
  });

  test("PR snapshot skips truly absent optional coordinates", async () => {
    await expect(ghPrSnapshot({ skipIfMissing: true }, {})).resolves.toEqual({
      skipped: true,
      reason: "no pull request rotation target",
    });
  });
});

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

  test("an unterminated fence does not swallow later anchors", () => {
    expect(getH2Anchors("```md\nexample\n## Later anchor\nBody.\n")).toEqual(["## Later anchor"]);
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

  test("an agent-scoped memory write is rejected rather than silently published", () => {
    // inject_learning — the only memory write path scripts have — always stores swarm
    // scope. Accepting "agent" would expose agent-private reflection to every worker
    // while the receipt recorded the requested scope as though it had been honored.
    expect(
      validateReflectionDelta({
        kind: "memory",
        agentId: "agent-1",
        action: "write",
        content: "remember this",
        scope: "agent",
      }),
    ).toBe("memory scope must be swarm (agent-scoped memory writes are not supported)");
    expect(
      validateReflectionDelta({
        kind: "memory",
        agentId: "agent-1",
        action: "write",
        content: "remember this",
        scope: "swarm",
      }),
    ).toBeNull();
    // Skills still support both scopes — the restriction is memory-specific.
    expect(
      validateReflectionDelta({
        kind: "skill",
        action: "create",
        content: "# skill",
        scope: "agent",
      }),
    ).toBeNull();
  });

  test("receipt includes hashes, locations, and memory identifiers", () => {
    const receipt = renderDreamReceipt(
      {
        applied: [
          {
            agentId: "agent-1",
            kind: "memory",
            action: "write",
            key: "daily-learning",
            scope: "swarm",
            contentHash: "abc123",
            reason: "approved",
          },
        ],
        held: [
          {
            agentId: "agent-1",
            kind: "profile-op",
            file: "CLAUDE",
            anchor: "## Notes",
            op: "append-under",
            contentHash: "def456",
            reason: "anchor not found",
          },
        ],
        deferred: [],
      },
      "2026-08-03",
    );

    expect(receipt).toContain(
      "APPLIED (1)\nagent-1: memory — approved [action=write, key=daily-learning, scope=swarm, contentHash=abc123]",
    );
    expect(receipt).toContain(
      "HELD (1)\nagent-1: profile-op — anchor not found [file=CLAUDE, anchor=## Notes, op=append-under, contentHash=def456]",
    );
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
  test("distinct malformed profile contents have distinct held audit hashes", async () => {
    const result = await dreamApply(
      {
        deltas: [
          {
            kind: "profile-op",
            agentId: "agent-1",
            file: "CLAUDE",
            op: "append-under",
            anchor: "## Notes",
            content: { proposed: "first" },
          },
          {
            kind: "profile-op",
            agentId: "agent-1",
            file: "CLAUDE",
            op: "append-under",
            anchor: "## Notes",
            content: { proposed: "second" },
          },
        ],
      },
      { swarm: {} },
    );

    expect(result.held).toHaveLength(2);
    expect(result.held[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.held[1]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.held[0]?.contentHash).not.toBe(result.held[1]?.contentHash);
  });

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
