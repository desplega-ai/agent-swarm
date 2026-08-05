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
          return {
            success: true,
            data: {
              skills: [
                {
                  id: "sk-1",
                  name: "seeded-one",
                  description: "d",
                  systemDefault: 1,
                  content: "# body",
                  sourceHash: "abc",
                  createdAt: "now",
                },
              ],
            },
          };
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

    // With the workflow's own runId available (the seeded workflow passes it),
    // exclusion pivots to the durable workflow ID — an operator renaming the
    // seeded workflow keeps its schedule binding, so a name join would silently
    // stop excluding it and the gate would become self-sustaining again.
    const byId = gatherHarness({ roster: [{ id: "lead-1", name: "Lead", isLead: 1 }] });
    await dreamGather({ preflightOnly: true, runId: "run-42" }, byId.ctx);
    const byIdQuery = byId.queries.find((query) => query.sql.includes("AS completedTasks"))!;
    expect(byIdQuery.sql).toContain("SELECT workflowId FROM workflow_runs WHERE id = ?");
    expect(byIdQuery.sql).not.toContain("w.name = ?");
    expect(byIdQuery.params).toEqual(["-1 days", "run-42", "-1 days", "run-42"]);
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
      agentIds: ["lead-1"],
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
    // The catalog is projected to what the skills lane reasons about — the raw
    // rows carry every column but content, which is ~40 rows of noise post-#1083.
    expect(result.insights.skills).toEqual([
      { id: "sk-1", name: "seeded-one", description: "d", systemDefault: true },
    ]);
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
    // Skill deltas are swarm-only for the same class of reason: dream-apply runs as
    // the Lead, so an "agent"-scoped skill would bind to the Lead, never the lane.
    expect(
      validateReflectionDelta({
        kind: "skill",
        action: "create",
        content: "# skill",
        scope: "agent",
      }),
    ).toBe("skill scope must be swarm (agent-scoped skill deltas are not supported)");
    expect(
      validateReflectionDelta({
        kind: "skill",
        action: "create",
        content: "# skill",
        scope: "swarm",
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

  test("receipt keeps the memory record but fails the step when Slack posting fails", async () => {
    const kvStore = new Map<string, unknown>();
    const memories: string[] = [];
    const ctx = {
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
        async kv_getOrNull({ key }: { key: string }) {
          return kvStore.has(key) ? { key, value: kvStore.get(key) } : null;
        },
        async kv_set({ key, value }: { key: string; value: unknown }) {
          kvStore.set(key, value);
          return { success: true, data: { success: true } };
        },
      },
    };

    // A caught-and-returned Slack error would let the executor checkpoint this
    // step as completed and the post would be skipped forever — the step must
    // FAIL so a retry re-runs it.
    await expect(
      dreamReceipt(
        { apply: { applied: [], held: [], deferred: [] }, date: "2026-08-03", runId: "run-s1" },
        ctx,
      ),
    ).rejects.toThrow("Dreaming Slack post failed: Slack unavailable");
    expect(memories).toHaveLength(1);
    // Marker stays at memory-written: the retry skips the memory, retries Slack.
    expect(kvStore.get("receipt:run-s1")).toBe("memory-written");
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
            rotationCursorKey: "rotation-cursor",
            rotationCursorNamespace: "dreaming",
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

  test("a consumed rotation target advances the cursor even with no approved deltas", async () => {
    const kvStore = new Map<string, unknown>();
    const increments: unknown[] = [];
    const ctx = {
      swarm: {
        async kv_getOrNull({ key }: { key: string }) {
          return kvStore.has(key) ? { key, value: kvStore.get(key) } : null;
        },
        async kv_set({ key, value }: { key: string; value: unknown }) {
          kvStore.set(key, value);
          return { success: true, data: { success: true } };
        },
        async kv_incr(request: unknown) {
          increments.push(request);
          return { success: true, data: { value: 1 } };
        },
      },
    };
    const rotation = { available: true, key: "rotation-cursor", namespace: "dreaming" };

    // Clean review: no deltas at all, yet the target was consumed — the cursor
    // must advance or the same PR is reselected every dream.
    const clean = await dreamApply({ deltas: [], runId: "run-rot", rotation }, ctx);
    expect(clean.rotationCursor).toEqual({ advanced: true });
    expect(increments).toEqual([{ key: "rotation-cursor", namespace: "dreaming", by: 1 }]);

    // A retried run must not advance twice: the per-run marker short-circuits.
    const retried = await dreamApply({ deltas: [], runId: "run-rot", rotation }, ctx);
    expect(retried.rotationCursor).toEqual({ advanced: true });
    expect(increments).toHaveLength(1);

    // No rotation target this run → nothing to consume, cursor untouched.
    const noTarget = await dreamApply(
      { deltas: [], runId: "run-rot-2", rotation: { available: false } },
      ctx,
    );
    expect(noTarget.rotationCursor).toBeUndefined();
    expect(increments).toHaveLength(1);
  });

  test("a hygiene delta that already advanced the cursor suppresses the run-level advance", async () => {
    const increments: unknown[] = [];
    const result = await dreamApply(
      {
        rotation: { available: true, key: "rotation-cursor", namespace: "dreaming" },
        deltas: [
          {
            kind: "hygiene",
            agentId: "agent-1",
            op: "append-under",
            anchor: "## Rotation",
            content: "New rotation item.",
            rotationCursorKey: "rotation-cursor",
            rotationCursorNamespace: "dreaming",
          },
        ],
      },
      {
        swarm: {
          async db_query() {
            return { success: true, data: { rows: [["## Rotation\nExisting.\n"]] } };
          },
          async profile_update() {
            return { success: true, data: { success: true } };
          },
          async kv_incr(request: unknown) {
            increments.push(request);
            return { success: true, data: { value: 2 } };
          },
        },
      },
    );

    expect(result.applied).toHaveLength(1);
    // Exactly one advance: the delta's own, not a second run-level one.
    expect(increments).toHaveLength(1);
    expect(result.rotationCursor).toBeUndefined();
  });

  test("a runId-keyed retry skips already-applied deltas instead of re-mutating", async () => {
    const kvStore = new Map<string, unknown>();
    const writes: string[] = [];
    const ctx = {
      swarm: {
        async inject_learning({ learning }: { learning: string }) {
          writes.push(learning);
          return { success: true, data: { success: true } };
        },
        // Mirrors the real SDK contract: kv_getOrNull resolves to the KV entry
        // object itself (the REST body — NOT the MCP tool's { entry } wrapper),
        // or null when the key is missing.
        async kv_getOrNull({ key }: { key: string }) {
          return kvStore.has(key) ? { key, value: kvStore.get(key) } : null;
        },
        async kv_set({ key, value }: { key: string; value: unknown }) {
          kvStore.set(key, value);
          return { success: true, data: { success: true } };
        },
      },
    };
    const args = {
      runId: "run-77",
      deltas: [{ kind: "memory", agentId: "agent-1", action: "write", content: "learned it" }],
    };

    const first = await dreamApply(args, ctx);
    expect(first.applied).toEqual([expect.objectContaining({ kind: "memory" })]);
    expect(first.applied[0]?.idempotentSkip).toBeUndefined();
    expect(writes).toEqual(["learned it"]);
    expect(kvStore.size).toBe(1);
    expect([...kvStore.keys()][0]).toStartWith("apply:run-77:");

    // The retry re-runs the whole loop (crash/timeout after checkpoint loss) —
    // the receipt must prevent a duplicate memory write.
    const second = await dreamApply(args, ctx);
    expect(second.applied).toEqual([
      expect.objectContaining({ kind: "memory", idempotentSkip: true }),
    ]);
    expect(writes).toEqual(["learned it"]);

    // Without a runId there is no receipt to consult and the delta applies.
    const third = await dreamApply({ deltas: args.deltas }, ctx);
    expect(third.applied[0]?.idempotentSkip).toBeUndefined();
    expect(writes).toEqual(["learned it", "learned it"]);
  });

  test("a memory delete is held unless it targets the declared agent's swarm-scoped memory", async () => {
    const deletes: unknown[] = [];
    const makeCtx = (owner: unknown, scope: unknown = "swarm", found = true) => ({
      swarm: {
        async db_query({ sql }: { sql: string }) {
          expect(sql).toContain("FROM agent_memory");
          return { success: true, data: { rows: found ? [[owner, scope]] : [] } };
        },
        async memory_delete(request: unknown) {
          deletes.push(request);
          return { success: true, data: { success: true } };
        },
      },
    });
    const deleteDelta = (agentId: string) => ({
      deltas: [{ kind: "memory", agentId, action: "delete", id: "mem-9" }],
    });

    const crossLane = await dreamApply(deleteDelta("agent-1"), makeCtx("agent-2"));
    expect(deletes).toEqual([]);
    expect(crossLane.held).toEqual([
      expect.objectContaining({
        kind: "memory",
        reason: "memory mem-9 belongs to agent agent-2, not the declared agent",
      }),
    ]);

    const missing = await dreamApply(deleteDelta("agent-1"), makeCtx(undefined, "swarm", false));
    expect(deletes).toEqual([]);
    expect(missing.held).toEqual([
      expect.objectContaining({ reason: "memory mem-9 was not found" }),
    ]);

    // The owner check alone passes for the declared agent's own PRIVATE memory,
    // but Dreaming only ever writes swarm-scoped rows — an agent-scoped target is
    // outside anything the critique reviewed and must be held, not deleted.
    const privateMemory = await dreamApply(deleteDelta("agent-1"), makeCtx("agent-1", "agent"));
    expect(deletes).toEqual([]);
    expect(privateMemory.held).toEqual([
      expect.objectContaining({
        reason: "memory mem-9 is agent-scoped, not a swarm memory Dreaming manages",
      }),
    ]);

    const owned = await dreamApply(deleteDelta("agent-1"), makeCtx("agent-1"));
    expect(owned.applied).toEqual([expect.objectContaining({ kind: "memory" })]);
    expect(deletes).toEqual([{ id: "mem-9" }]);
  });

  test("skill deltas land in the swarm catalog, never on the Lead identity", async () => {
    const creates: Array<Record<string, unknown>> = [];
    const ctx = {
      swarm: {
        async skill_create(request: Record<string, unknown>) {
          creates.push(request);
          return { success: true, data: { success: true } };
        },
      },
    };

    // skill-create defaults an omitted scope to "agent" (the requesting identity =
    // the Lead running this script), so the apply must pin scope to swarm.
    const created = await dreamApply(
      { deltas: [{ kind: "skill", action: "create", content: "# Playbook" }] },
      ctx,
    );
    expect(created.applied).toHaveLength(1);
    expect(creates).toEqual([{ content: "# Playbook", scope: "swarm" }]);

    // An explicitly agent-scoped skill delta cannot be honored (no target agentId
    // semantics — it would bind to the Lead), so it is held, not misdelivered.
    const agentScoped = await dreamApply(
      { deltas: [{ kind: "skill", action: "create", content: "# Private", scope: "agent" }] },
      ctx,
    );
    expect(agentScoped.applied).toEqual([]);
    expect(agentScoped.held).toEqual([
      expect.objectContaining({
        reason: "skill scope must be swarm (agent-scoped skill deltas are not supported)",
      }),
    ]);
    expect(creates).toHaveLength(1);
  });

  test("skill updates only touch targets already in the swarm catalog", async () => {
    const updates: unknown[] = [];
    const makeCtx = (scope: unknown, found = true, systemDefault: unknown = 0) => ({
      swarm: {
        async db_query({ sql }: { sql: string }) {
          expect(sql).toContain("FROM skills");
          return { success: true, data: { rows: found ? [[scope, systemDefault]] : [] } };
        },
        async skill_update(request: unknown) {
          updates.push(request);
          return { success: true, data: { success: true } };
        },
      },
    });
    const fullSkillMd = "---\nname: sk-one\ndescription: playbook\n---\n\n# v2\n\nSteps.";
    const updateDelta = {
      deltas: [{ kind: "skill", action: "update", skillId: "sk-1", content: fullSkillMd }],
    };

    // A stale/hallucinated skillId pointing at an agent-personal skill must not
    // be rewritten (skill-update authorizes the Lead to edit any owner's skill).
    const personal = await dreamApply(updateDelta, makeCtx("agent"));
    expect(updates).toEqual([]);
    expect(personal.held).toEqual([
      expect.objectContaining({
        reason: "skill sk-1 is agent-scoped, not part of the swarm catalog",
      }),
    ]);

    const missing = await dreamApply(updateDelta, makeCtx(undefined, false));
    expect(updates).toEqual([]);
    expect(missing.held).toEqual([expect.objectContaining({ reason: "skill sk-1 was not found" })]);

    // Since the baked-skills->DB migration (#1083) nearly every swarm skill is
    // seeded and systemDefault, and skill-update hard-rejects content edits on
    // those. Held as policy so the receipt says why instead of surfacing a raw
    // tool error in DEFERRED every night.
    const seeded = await dreamApply(updateDelta, makeCtx("swarm", true, 1));
    expect(updates).toEqual([]);
    expect(seeded.held).toEqual([
      expect.objectContaining({
        reason:
          "skill sk-1 is system-managed (seeded from a repo template) and cannot be edited — propose a new skill or a repo change instead",
      }),
    ]);

    // skill_update replaces the WHOLE SKILL.md — a delta authored from catalog
    // metadata alone (no frontmatter, partial body) would wipe the playbook.
    const partial = await dreamApply(
      { deltas: [{ kind: "skill", action: "update", skillId: "sk-1", content: "# v2 only" }] },
      makeCtx("swarm"),
    );
    expect(updates).toEqual([]);
    expect(partial.held).toEqual([
      expect.objectContaining({
        reason:
          "skill update content must be a complete SKILL.md (frontmatter with name + body) — partial content would replace the entire skill",
      }),
    ]);

    const catalog = await dreamApply(updateDelta, makeCtx("swarm"));
    expect(catalog.applied).toHaveLength(1);
    expect(updates).toEqual([{ skillId: "sk-1", content: fullSkillMd, scope: undefined }]);
  });

  test("agent-targeted deltas outside the gathered roster are held", async () => {
    const writes: string[] = [];
    const ctx = {
      swarm: {
        async inject_learning({ learning }: { learning: string }) {
          writes.push(learning);
          return { success: true, data: { success: true } };
        },
      },
    };
    const result = await dreamApply(
      {
        agentIds: ["agent-1"],
        deltas: [
          { kind: "memory", agentId: "agent-1", action: "write", content: "in roster" },
          { kind: "memory", agentId: "agent-ghost", action: "write", content: "hallucinated" },
        ],
      },
      ctx,
    );

    expect(writes).toEqual(["in roster"]);
    expect(result.applied).toHaveLength(1);
    expect(result.held).toEqual([
      expect.objectContaining({
        agentId: "agent-ghost",
        reason: "agent agent-ghost is not in this run's gathered roster",
      }),
    ]);
  });

  test("hygiene cursor coordinates are pinned to the cursor Dreaming owns", () => {
    const base = {
      kind: "hygiene",
      agentId: "agent-1",
      op: "remove-section",
      anchor: "## Watch: something",
    };
    expect(validateReflectionDelta({ ...base, rotationCursorKey: "unrelated-counter" })).toContain(
      'rotationCursorKey must be "rotation-cursor"',
    );
    expect(
      validateReflectionDelta({
        ...base,
        rotationCursorKey: "rotation-cursor",
        rotationCursorNamespace: "prod-billing",
      }),
    ).toContain('rotationCursorNamespace must be "dreaming"');
    // Omitting the namespace is NOT a pass: kv_incr would fall back to the agent
    // namespace and the shared rotation cursor would silently never advance.
    expect(validateReflectionDelta({ ...base, rotationCursorKey: "rotation-cursor" })).toContain(
      "requires rotationCursorNamespace",
    );
    expect(
      validateReflectionDelta({
        ...base,
        rotationCursorKey: "rotation-cursor",
        rotationCursorNamespace: "dreaming",
        rotationCursorBy: 5,
      }),
    ).toContain("rotationCursorBy must be 1");
    expect(
      validateReflectionDelta({
        ...base,
        rotationCursorKey: "rotation-cursor",
        rotationCursorNamespace: "dreaming",
        rotationCursorBy: 1,
      }),
    ).toBeNull();
  });

  test("a crash between the memory write and the Slack post resumes Slack on recovery", async () => {
    for (const priorStage of ["memory-written", "written"]) {
      const kvStore = new Map<string, unknown>([["receipt:run-9", priorStage]]);
      const memories: string[] = [];
      const slackPosts: unknown[] = [];
      const ctx = {
        stdlib: { Redacted: { value: (value: unknown) => value } },
        swarm: {
          config: { agentId: "lead-1" },
          async inject_learning({ learning }: { learning: string }) {
            memories.push(learning);
            return { success: true, data: { success: true } };
          },
          async config_get() {
            return {
              success: true,
              data: { configs: [{ key: "DREAMING_SLACK_CHANNEL", value: "C123" }] },
            };
          },
          async slack_post(request: unknown) {
            slackPosts.push(request);
            return { success: true, data: { ok: true } };
          },
          async kv_getOrNull({ key }: { key: string }) {
            return kvStore.has(key) ? { key, value: kvStore.get(key) } : null;
          },
          async kv_set({ key, value }: { key: string; value: unknown }) {
            kvStore.set(key, value);
            return { success: true, data: { success: true } };
          },
        },
      };
      const args = { apply: { applied: [], held: [], deferred: [] }, runId: "run-9" };

      const resumed = await dreamReceipt(args, ctx);
      expect(memories).toHaveLength(0);
      expect(slackPosts).toHaveLength(1);
      expect(resumed.slackPosted).toBe(true);
      expect(kvStore.get("receipt:run-9")).toBe("done");

      const third = await dreamReceipt(args, ctx);
      expect(third).toMatchObject({ duplicateOfRun: "run-9", slackPosted: false });
      expect(memories).toHaveLength(0);
      expect(slackPosts).toHaveLength(1);
    }
  });

  test("the agent slice fails loud when an evidence query fails", async () => {
    await expect(
      dreamAgentSlice(
        { agentId: "agent-1" },
        {
          swarm: {
            async db_query() {
              return { success: false, data: { error: "no such column: t.bogus" } };
            },
          },
        },
      ),
    ).rejects.toThrow("evidence query failed");
  });

  test("a snapshot fetch outage returns an error result instead of throwing", async () => {
    const result = await ghPrSnapshot(
      { repo: "desplega-ai/agent-swarm", number: 1 },
      {
        stdlib: {
          async fetchJson() {
            throw new Error("ECONNRESET");
          },
        },
        swarm: {
          async config_get() {
            return { success: true, data: { configs: [] } };
          },
          async secret_get() {
            return { success: true, data: {} };
          },
        },
      },
    );
    expect(result.error).toContain("snapshot fetch failed");
  });

  test("a recovered receipt re-run does not duplicate the memory or the Slack post", async () => {
    const kvStore = new Map<string, unknown>();
    const memories: string[] = [];
    const slackPosts: unknown[] = [];
    const ctx = {
      stdlib: { Redacted: { value: (v: unknown) => v } },
      swarm: {
        config: { agentId: "lead-1" },
        async inject_learning({ learning }: { learning: string }) {
          memories.push(learning);
          return { success: true, data: { success: true } };
        },
        async config_get() {
          return {
            success: true,
            data: { configs: [{ key: "DREAMING_SLACK_CHANNEL", value: "C123" }] },
          };
        },
        async slack_post(request: unknown) {
          slackPosts.push(request);
          return { success: true, data: { ok: true } };
        },
        async kv_getOrNull({ key }: { key: string }) {
          return kvStore.has(key) ? { key, value: kvStore.get(key) } : null;
        },
        async kv_set({ key, value }: { key: string; value: unknown }) {
          kvStore.set(key, value);
          return { success: true, data: { success: true } };
        },
      },
    };
    const args = { apply: { applied: [], held: [], deferred: [] }, runId: "run-9" };

    const first = await dreamReceipt(args, ctx);
    expect(first.receipt).toContain("Run: run-9");
    expect(memories).toHaveLength(1);
    expect(slackPosts).toHaveLength(1);

    // Crash-recovery re-runs the instant step when the server died before the
    // checkpoint — the per-run marker must keep both side effects single-shot.
    const second = await dreamReceipt(args, ctx);
    expect(second).toMatchObject({ duplicateOfRun: "run-9", slackPosted: false });
    expect(memories).toHaveLength(1);
    expect(slackPosts).toHaveLength(1);
  });
});
