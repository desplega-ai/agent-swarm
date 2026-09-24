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
  memoryQuoteMatches,
  upsertTaskCitations,
} from "../be/task-citations";
import { registerStoreProgressTool } from "../tools/store-progress";
import { renderTaskCitations, type TaskCitation } from "../utils/task-citations";

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

  test("resolved and unchecked links render, false and unknown indices remain plain", () => {
    expect(renderTaskCitations("Claim [citation:1]", [citation])).toBe(
      "Claim <https://example.com/|[1]>\n\nSources: <https://example.com/|[1]> Evidence",
    );
    expect(renderTaskCitations("[citation:1]", [{ ...citation, verified: "unchecked" }])).toContain(
      "<https://example.com/|[1]>",
    );
    expect(
      renderTaskCitations("[citation:1] [citation:9]", [{ ...citation, verified: "false" }]),
    ).toBe("[1] [9]\n\nSources: [1] Evidence");
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

  test("accumulates, upserts by index, verifies memory quotes, and completes despite bad citations", async () => {
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
    const result = await handler(
      {
        taskId: task.id,
        status: "completed",
        output: "Done [citation:1] [citation:9]",
        citations: [
          { index: 2, kind: "memory", ref: memoryId, quote: "invented statement" },
          { index: 3, kind: "page", ref: "missing-page" },
          { index: 4, kind: "url", ref: "javascript:alert(1)" },
        ],
      },
      meta,
    );
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.details).toContain(
      "WARNING: [citation:9] has no citation entry.",
    );
    expect(result.structuredContent.details).toContain(
      "WARNING: citation 2 is not referenced in output.",
    );
    expect((await getTaskById(task.id))?.status).toBe("completed");
    const rows = await getTaskCitations(task.id);
    expect(rows).toHaveLength(4);
    expect(rows[1]?.verified).toBe("false");
    expect(rows[2]?.verified).toBe("false");
    expect(rows[3]?.resolvedUrl).toBeNull();
    await upsertTaskCitations(task.id, [
      { index: 5, kind: "script-run", ref: "missing-run" },
      { index: 6, kind: "memory", ref: "missing-memory" },
    ]);
    expect((await getTaskCitations(task.id)).slice(4).map((entry) => entry.verified)).toEqual([
      "false",
      "false",
    ]);
  });
});
