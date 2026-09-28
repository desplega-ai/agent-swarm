import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createPage,
  createScriptRun,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import {
  buildCitationUrl,
  CitationInputSchema,
  getTaskCitations,
  githubCitationUrl,
  MAX_TASK_CITATIONS,
  memoryQuoteMatches,
  upsertTaskCitations,
} from "../be/task-citations";
import { registerStoreProgressTool } from "../tools/store-progress";
import {
  citationDropReason,
  renderTaskCitationSources,
  renderTaskCitations,
  type TaskCitation,
  taskCitationIssues,
  taskCitationWarnings,
} from "../utils/task-citations";

const citation: TaskCitation = {
  index: 1,
  kind: "url",
  ref: "https://example.com/",
  label: "Evidence",
  resolvedUrl: "https://example.com/",
  verified: "true",
};

describe("citation links and presentation", () => {
  test("builds canonical typed URLs and rejects unsafe or unsupported refs", () => {
    expect(buildCitationUrl({ index: 1, kind: "github", ref: "desplega-ai/agent-swarm#123" })).toBe(
      "https://github.com/desplega-ai/agent-swarm/issues/123",
    );
    expect(buildCitationUrl({ index: 1, kind: "task", ref: "task-id" })).toEndWith(
      "/tasks/task-id",
    );
    expect(buildCitationUrl({ index: 1, kind: "page", ref: "page-id" })).toEndWith(
      "/pages/page-id",
    );
    for (const kind of ["memory", "script-run", "slack"] as const)
      expect(buildCitationUrl({ index: 1, kind, ref: "id" })).toBeNull();
    for (const ref of ["javascript:alert(1)", "file:///tmp/x", "not a URL"])
      expect(buildCitationUrl({ index: 1, kind: "url", ref })).toBeNull();
    expect(buildCitationUrl({ index: 1, kind: "github", ref: "https://example.com" })).toBeNull();
    expect(buildCitationUrl({ index: 1, kind: "page", ref: "\ud800" })).toBeNull();
    expect(buildCitationUrl({ index: 1, kind: "url", ref: "https://example.com" })).toBe(
      "https://example.com/",
    );
  });

  test("agent-fs reuses scoped attachment URLs and has no link without a scope", () => {
    const keys = ["AGENT_FS_DEFAULT_ORG_ID", "AGENT_FS_DEFAULT_DRIVE_ID"] as const;
    const previous = keys.map((key) => process.env[key]);
    try {
      delete process.env.AGENT_FS_DEFAULT_ORG_ID;
      delete process.env.AGENT_FS_DEFAULT_DRIVE_ID;
      expect(buildCitationUrl({ index: 1, kind: "agent-fs", ref: "thoughts/a b.md" })).toBeNull();
      process.env.AGENT_FS_DEFAULT_ORG_ID = "org";
      process.env.AGENT_FS_DEFAULT_DRIVE_ID = "drive";
      expect(buildCitationUrl({ index: 1, kind: "agent-fs", ref: "thoughts/a b.md" })).toEndWith(
        "/file/~/org/drive/thoughts/a%20b.md",
      );
    } finally {
      keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key];
        else process.env[key] = previous[i];
      });
    }
  });

  test("resolved and unchecked links render, false and unknown indices disappear", () => {
    expect(renderTaskCitations("Claim [citation:1]", [citation])).toBe(
      "Claim <https://example.com/|[1]>\n\nSources: <https://example.com/|[1]> Evidence",
    );
    expect(renderTaskCitations("[citation:1]", [{ ...citation, verified: "unchecked" }])).toContain(
      "<https://example.com/|[1]>",
    );
    expect(
      renderTaskCitations("[citation:1] [citation:9]", [{ ...citation, verified: "false" }]),
    ).toBe("");
    expect(renderTaskCitations("[citation:1]", [{ ...citation, resolvedUrl: null }])).not.toContain(
      "<",
    );
    expect(renderTaskCitations("[citation:1]", [citation], "markdown")).toContain(
      "[[1]](https://example.com/)",
    );
    expect(
      renderTaskCitations("[citation:1]", [{ ...citation, resolvedUrl: "javascript:alert(1)" }]),
    ).not.toContain("javascript:");
    expect(renderTaskCitations("Unchanged", [])).toBe("Unchanged");
    expect(renderTaskCitations("Bad [citation:1]", [{ ...citation, resolvedUrl: null }])).toBe(
      "Bad",
    );
    expect(
      renderTaskCitations("Good [citation:1]", [
        { ...citation, kind: "memory", resolvedUrl: null },
      ]),
    ).toBe("Good [1]\n\nSources: [1] Evidence");
  });

  test.each([
    "slack",
    "markdown",
  ] as const)("strips invalid runs without disrupting layout in %s", (format) => {
    const invalid = { ...citation, index: 2, verified: "false" as const, label: "Bad source" };
    for (const [input, output] of [
      ["A [citation:2] [citation:9] claim.", "A claim."],
      ["Claim [citation:9].", "Claim."],
      ["[citation:9] Claim", "Claim"],
      ["Claim [citation:9]", "Claim"],
      ["[citation:2] [citation:9]", ""],
      ["A\n  [citation:9]\n  B", "A\n\n  B"],
      ["  A  B\n\nC", "  A  B\n\nC"],
    ]) {
      expect(renderTaskCitations(input!, [invalid], format)).toBe(output!);
      expect(renderTaskCitations(input!, [invalid], format, false)).toBe(output!);
    }
    const mixed = renderTaskCitations(
      "Claim [citation:1] [citation:2] [citation:9] ends.",
      [citation, invalid],
      format,
    );
    expect(mixed).toContain("[1]");
    expect(mixed).not.toContain("[2]");
    expect(mixed).not.toContain("[9]");
    expect(mixed).not.toContain("Bad source");
    expect(mixed).not.toContain("  ");
    expect(renderTaskCitations("Done [citation:51]", [], format)).toBe("Done");
  });

  test("quote comparison normalizes whitespace but preserves words and case", () => {
    expect(memoryQuoteMatches("Before\n a   useful\tclaim after", "a useful claim")).toBe(true);
    expect(memoryQuoteMatches("a useful claim", "a different claim")).toBe(false);
    expect(memoryQuoteMatches("a useful claim", "A useful claim")).toBe(false);
    expect(CitationInputSchema.safeParse({ index: 0, kind: "url", ref: "x" }).success).toBe(false);
    expect(
      CitationInputSchema.safeParse({ index: 1, kind: "memory", ref: "x", quote: "x".repeat(301) })
        .success,
    ).toBe(false);
  });
});

describe("github refs, grouping, and accuracy issues", () => {
  const repo = "https://github.com/desplega-ai/agent-swarm";

  test.each([
    ["desplega-ai/agent-swarm#1595", `${repo}/issues/1595`],
    [`${repo}/pull/1595`, `${repo}/pull/1595`],
    [`${repo}/pull/1595/files#diff-abc`, `${repo}/pull/1595`],
    [`http://www.github.com/desplega-ai/agent-swarm/issues/42?x=1`, `${repo}/issues/42`],
    [`${repo}/commit/C172A21BC`, `${repo}/commit/c172a21bc`],
    ["desplega-ai/agent-swarm@c172a21bc", `${repo}/commit/c172a21bc`],
  ])("github ref %s resolves to %s", (ref, url) => {
    expect(buildCitationUrl({ index: 1, kind: "github", ref })).toBe(url);
  });

  test.each([
    "https://gitlab.com/desplega-ai/agent-swarm/pull/1",
    `${repo}/pulls`,
    `${repo}/tree/main`,
    "https://github.com.evil.test/desplega-ai/agent-swarm/pull/1",
    "javascript:alert(1)",
    "desplega-ai/agent-swarm",
  ])("github ref %s does not resolve", (ref) => {
    expect(githubCitationUrl(ref)).toBeNull();
  });

  test("drop reasons name the expected ref shape per kind", () => {
    const base = { index: 1, ref: "r", resolvedUrl: null, verified: "unchecked" } as const;
    expect(citationDropReason({ ...base, kind: "github" })).toContain("owner/repo#N");
    expect(citationDropReason({ ...base, kind: "url" })).toContain("http(s) URL");
    expect(citationDropReason({ ...base, kind: "slack" })).toBeNull();
    expect(citationDropReason({ ...base, kind: "task", verified: "false" })).toBe(
      'task "r" was not found',
    );
  });

  const cited: TaskCitation = { ...citation, index: 1, label: "Cited" };
  const general: TaskCitation = { ...citation, index: 2, label: "Whole", general: true };
  const loose: TaskCitation = { ...citation, index: 3, label: "Loose" };
  const broken: TaskCitation = { ...citation, index: 4, kind: "github", resolvedUrl: null };

  test("referenced citations go under Sources, the rest under General sources", () => {
    const text = "Claim [citation:1].";
    const rendered = renderTaskCitations(text, [cited, general, loose, broken]);
    expect(rendered).toBe(
      "Claim <https://example.com/|[1]>.\n\nSources: <https://example.com/|[1]> Cited\nGeneral sources: <https://example.com/|[2]> Whole · <https://example.com/|[3]> Loose",
    );
    expect(renderTaskCitationSources(text, [cited], "markdown")).toBe(
      "Sources: [[1]](https://example.com/) Cited",
    );
    expect(renderTaskCitationSources("", [cited, general], "markdown")).toBe(
      "General sources: [[1]](https://example.com/) Cited · [[2]](https://example.com/) Whole",
    );
    expect(renderTaskCitationSources(text, [broken])).toBe("");
  });

  test("issues: missing entries, invalid rows, and unreferenced non-general rows", () => {
    const issues = taskCitationIssues("A [citation:1] B [citation:7] C [citation:4]", [
      cited,
      general,
      loose,
      broken,
    ]);
    expect(issues.missingEntries).toEqual([7]);
    expect(issues.invalid.map((entry) => entry.index)).toEqual([4]);
    expect(issues.unreferenced).toEqual([3]);
    expect(taskCitationWarnings("A [citation:1]", [cited, general])).toEqual([]);
  });
});

describe("citation persistence and completion warnings", () => {
  const dbPath = `/tmp/test-task-citations-${crypto.randomUUID()}.sqlite`;
  let agentId: string;
  beforeAll(async () => {
    initDb(dbPath);
    agentId = (
      await createAgent({
        name: "Citation test",
        role: "worker",
        isLead: false,
        status: "busy",
        capabilities: [],
      })
    ).id;
  });
  afterAll(async () => {
    closeDb();
    await Promise.all(["", "-wal", "-shm"].map((suffix) => rm(dbPath + suffix, { force: true })));
  });

  test.each([
    "in_progress",
    "completed",
    "failed",
    "cancelled",
  ] as const)("only the assigned agent can insert or replace citations on a %s task", async (taskStatus) => {
    const otherAgent = await createAgent({
      name: `Other citation agent ${taskStatus}`,
      role: "worker",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("Citation ownership", { agentId, source: "system" });
    await startTask(task.id);
    const server = new McpServer({ name: "citation-ownership", version: "1" });
    registerStoreProgressTool(server);
    const handler = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              args: unknown,
              meta: unknown,
            ) => Promise<{ structuredContent: { success: boolean } }>;
          }
        >;
      }
    )._registeredTools["store-progress"]!.handler;
    const ownerMeta = { requestInfo: { headers: { "x-agent-id": agentId } } };
    const ownerCitation = { index: 1, kind: "url", ref: "https://example.com/owner" };
    await handler({ taskId: task.id, citations: [ownerCitation] }, ownerMeta);
    await getDbClient().run("UPDATE agent_tasks SET status = ? WHERE id = ?", [
      taskStatus,
      task.id,
    ]);
    const before = await getTaskCitations(task.id);
    expect(before).toHaveLength(1);

    const result = await handler(
      {
        taskId: task.id,
        progress: "Progress still saves when citations are rejected",
        citations: [
          { ...ownerCitation, ref: "https://example.com/poisoned" },
          { ...ownerCitation, index: 2, ref: "https://example.com/injected" },
        ],
      },
      { requestInfo: { headers: { "x-agent-id": otherAgent.id } } },
    );
    expect(result.structuredContent.success).toBe(true);
    expect(await getTaskCitations(task.id)).toEqual(before);
    if (taskStatus === "in_progress") {
      expect((await getTaskById(task.id))?.progress).toBe(
        "Progress still saves when citations are rejected",
      );
    }

    // Ownership applies even before the terminal-result guard, and owners
    // retain the ability to add or correct citations after completion.
    await handler(
      { taskId: task.id, citations: [{ ...ownerCitation, label: "Owner correction" }] },
      ownerMeta,
    );
    expect((await getTaskCitations(task.id))[0]?.label).toBe("Owner correction");
  });

  test("existing pages and script runs verify by DB lookup", async () => {
    const task = await createTaskExtended("Existing source control", { agentId });
    const page = await createPage({
      agentId,
      slug: "citation-source",
      title: "Source",
      contentType: "text/html",
      body: "Source",
    });
    const { run } = await createScriptRun({
      id: crypto.randomUUID(),
      agentId,
      source: "return 1",
      args: {},
    });
    await upsertTaskCitations(task.id, [
      { index: 1, kind: "page", ref: page.id },
      { index: 2, kind: "script-run", ref: run.id },
    ]);
    expect((await getTaskCitations(task.id)).map((entry) => entry.verified)).toEqual([
      "true",
      "true",
    ]);
  });

  test("bounds batches, strings, and accumulated rows without blocking completion", async () => {
    const task = await createTaskExtended("Bounded citations", { agentId, source: "system" });
    await startTask(task.id);
    const server = new McpServer({ name: "citation-limits", version: "1" });
    registerStoreProgressTool(server);
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            inputSchema: { parse: (args: unknown) => unknown };
            handler: (
              args: unknown,
              meta: unknown,
            ) => Promise<{ structuredContent: { success: boolean } }>;
          }
        >;
      }
    )._registeredTools["store-progress"]!;
    const entries = Array.from({ length: MAX_TASK_CITATIONS }, (_, i) => ({
      index: i + 1,
      kind: "url" as const,
      ref: "https://example.com/",
    }));
    await upsertTaskCitations(task.id, entries);
    await upsertTaskCitations(task.id, [
      { index: 51, kind: "url", ref: "https://example.com/" },
      { ...entries[0]!, label: "Updated at capacity" },
    ]);
    expect(await getTaskCitations(task.id)).toHaveLength(MAX_TASK_CITATIONS);
    expect((await getTaskCitations(task.id))[0]?.label).toBe("Updated at capacity");
    for (const citations of [
      [...entries, { ...entries[0]!, index: 51 }],
      [{ ...entries[0]!, ref: "x".repeat(2049) }],
      [{ ...entries[0]!, label: "x".repeat(201) }],
    ]) {
      const args = tool.inputSchema.parse({
        taskId: task.id,
        status: "completed",
        output: `Done ${entries.map((entry) => `[citation:${entry.index}]`).join(" ")}`,
        citations,
      });
      const result = await tool.handler(args, {
        requestInfo: { headers: { "x-agent-id": agentId } },
      });
      expect(result.structuredContent.success).toBe(true);
      expect(await getTaskCitations(task.id)).toHaveLength(MAX_TASK_CITATIONS);
    }
    expect((await getTaskById(task.id))?.status).toBe("completed");
  });

  test.each([
    "oversized",
    "invalid",
  ])("ignored %s batches complete and render no markers", async (kind) => {
    const task = await createTaskExtended("Ignored citation batch", { agentId, source: "system" });
    await startTask(task.id);
    const server = new McpServer({ name: "ignored-citations", version: "1" });
    registerStoreProgressTool(server);
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            inputSchema: { parse: (args: unknown) => unknown };
            handler: (
              args: unknown,
              meta: unknown,
            ) => Promise<{ structuredContent: { success: boolean; details?: string } }>;
          }
        >;
      }
    )._registeredTools["store-progress"]!;
    const citations =
      kind === "oversized"
        ? Array.from({ length: 51 }, (_, i) => ({
            index: i + 1,
            kind: "url",
            ref: "https://example.com/",
          }))
        : [{ index: 1, kind: "url", ref: "x".repeat(2049) }];
    const result = await tool.handler(
      tool.inputSchema.parse({
        taskId: task.id,
        status: "completed",
        output: "Done [citation:1] [citation:51] now",
        citations,
      }),
      { requestInfo: { headers: { "x-agent-id": agentId } } },
    );
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.details).toContain("removed from rendered output");
    const stored = await getTaskCitations(task.id);
    expect(stored).toEqual([]);
    const completed = await getTaskById(task.id);
    expect(completed?.status).toBe("completed");
    expect(renderTaskCitations(completed!.output!, stored)).toBe("Done now");
  });

  test("accumulates, upserts by index, verifies memory quotes, refuses once, then completes despite bad citations", async () => {
    const task = await createTaskExtended("Citation handler test", { agentId, source: "system" });
    await startTask(task.id);
    const memoryId = crypto.randomUUID();
    await getDbClient().run(
      "INSERT INTO agent_memory (id, agentId, scope, name, content, source, createdAt, accessedAt) VALUES (?, ?, 'agent', 'source', ?, 'manual', datetime('now'), datetime('now'))",
      [memoryId, agentId, "A grounded\n  statement."],
    );
    const server = new McpServer({ name: "citation-test", version: "1" });
    registerStoreProgressTool(server);
    const handler = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              args: unknown,
              meta: unknown,
            ) => Promise<{ structuredContent: { success: boolean; details?: string } }>;
          }
        >;
      }
    )._registeredTools["store-progress"]!.handler;
    const meta = { requestInfo: { headers: { "x-agent-id": agentId } } };
    expect(
      (
        await handler(
          {
            taskId: task.id,
            citations: [
              { index: 1, kind: "task", ref: task.id },
              { index: 2, kind: "memory", ref: memoryId, quote: "grounded statement." },
            ],
          },
          meta,
        )
      ).structuredContent.success,
    ).toBe(true);
    expect((await getTaskCitations(task.id)).map((entry) => entry.verified)).toEqual([
      "true",
      "true",
    ]);
    const completion = {
      taskId: task.id,
      status: "completed",
      output: "Done [citation:1] [citation:9]",
      citations: [
        { index: 2, kind: "memory", ref: memoryId, quote: "invented statement" },
        { index: 3, kind: "page", ref: "missing-page" },
        { index: 4, kind: "url", ref: "javascript:alert(1)" },
      ],
    };
    const refused = (await handler(completion, meta)) as unknown as {
      structuredContent: { success: boolean; message: string };
    };
    expect(refused.structuredContent.success).toBe(false);
    expect(refused.structuredContent.message).toContain("Completion refused");
    expect(refused.structuredContent.message).toContain(
      "[citation:9] is in the output but has no citation entry.",
    );
    expect(refused.structuredContent.message).toContain(
      'Citation 3 fails validation: page "missing-page" was not found.',
    );
    expect(refused.structuredContent.message).toContain(
      "Citation 4 fails validation: ref does not resolve to a link; expected an http(s) URL.",
    );
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    // The refused call still stored its citations so the author can fix them.
    expect(await getTaskCitations(task.id)).toHaveLength(4);

    const result = await handler(completion, meta);
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.details).toContain(
      "WARNING: [citation:9] has no citation entry; its marker is removed from rendered output.",
    );
    expect((await getTaskById(task.id))?.status).toBe("completed");
    const rows = await getTaskCitations(task.id);
    expect(rows).toHaveLength(4);
    expect(rows[1]?.verified).toBe("false");
    expect(rows[2]?.verified).toBe("false");
    expect(rows[3]?.resolvedUrl).toBeNull();
    expect(result.structuredContent.details).toContain("citation 2 failed validation");
    const rendered = renderTaskCitations("Done [citation:2] [citation:3] [citation:9]", rows);
    expect(rendered).not.toContain("[2]");
    expect(rendered).not.toContain("[3]");
    expect(rendered).not.toContain("[4]");
    expect(rendered).not.toContain("[9]");
    await upsertTaskCitations(task.id, [
      { index: 5, kind: "script-run", ref: "missing-run" },
      { index: 6, kind: "memory", ref: "missing-memory" },
    ]);
    expect((await getTaskCitations(task.id)).slice(4).map((entry) => entry.verified)).toEqual([
      "false",
      "false",
    ]);
  });

  test("completion check: general sources pass, unreferenced ones are refused once, fixes complete", async () => {
    const server = new McpServer({ name: "citation-accuracy", version: "1" });
    registerStoreProgressTool(server);
    const handler = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              args: unknown,
              meta: unknown,
            ) => Promise<{ structuredContent: { success: boolean; message: string } }>;
          }
        >;
      }
    )._registeredTools["store-progress"]!.handler;
    const meta = { requestInfo: { headers: { "x-agent-id": agentId } } };
    const pr = "https://github.com/desplega-ai/agent-swarm/pull/1595";

    // A general source may stay unreferenced; a full GitHub URL resolves.
    const generalTask = await createTaskExtended("General source", { agentId, source: "system" });
    await startTask(generalTask.id);
    const ok = await handler(
      {
        taskId: generalTask.id,
        status: "completed",
        output: "Answer.",
        citations: [{ index: 1, kind: "github", ref: pr, general: true }],
      },
      meta,
    );
    expect(ok.structuredContent.success).toBe(true);
    const [row] = await getTaskCitations(generalTask.id);
    expect(row).toMatchObject({ general: true, resolvedUrl: pr });
    expect(renderTaskCitations("Answer.", [row!])).toContain("General sources:");

    // An unreferenced, non-general source is refused; adding the marker fixes it.
    const task = await createTaskExtended("Unreferenced source", { agentId, source: "system" });
    await startTask(task.id);
    const refused = await handler(
      {
        taskId: task.id,
        status: "completed",
        output: "Answer.",
        citations: [{ index: 1, kind: "github", ref: pr }],
      },
      meta,
    );
    expect(refused.structuredContent.success).toBe(false);
    expect(refused.structuredContent.message).toContain(
      "Citation 1 is not referenced in the output",
    );
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    const fixed = await handler(
      { taskId: task.id, status: "completed", output: "Answer [citation:1]." },
      meta,
    );
    expect(fixed.structuredContent.success).toBe(true);
    expect((await getTaskById(task.id))?.status).toBe("completed");
    const logs = await getDbClient().query<{ newValue: string }>(
      "SELECT newValue FROM agent_log WHERE taskId = ? AND eventType = 'task_citation_check_refused'",
      [task.id],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]?.newValue).toContain("Citation 1 is not referenced");
  });

  test("completion check does not apply to a non-assignee completing the task", async () => {
    const other = await createAgent({
      name: "Citation non-assignee",
      role: "lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("Lead completes", { agentId, source: "system" });
    await startTask(task.id);
    await upsertTaskCitations(task.id, [{ index: 1, kind: "url", ref: "https://example.com/" }]);
    const server = new McpServer({ name: "citation-non-assignee", version: "1" });
    registerStoreProgressTool(server);
    const handler = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              args: unknown,
              meta: unknown,
            ) => Promise<{ structuredContent: { success: boolean } }>;
          }
        >;
      }
    )._registeredTools["store-progress"]!.handler;
    const result = await handler(
      { taskId: task.id, status: "completed", output: "No markers" },
      { requestInfo: { headers: { "x-agent-id": other.id } } },
    );
    expect(result.structuredContent.success).toBe(true);
  });
});
