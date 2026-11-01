import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  callTool,
  cancelTask,
  connectTaskMcp,
  createPinnedTask,
  dbCount,
  ensureLead,
  expectToolError,
  expectToolOk,
  registerAgent,
  UUID,
} from "./knowledge-helpers";

type Json = Record<string, unknown>;

async function waitForEmbedding(ctx: ScenarioContext, memoryId: string): Promise<void> {
  const embedded = await pollUntil(
    () =>
      ctx.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM agent_memory WHERE id = ? AND embeddingModel IS NOT NULL",
        [memoryId],
      )?.n === 1,
    15_000,
    200,
  );
  expect(embedded, `memory ${memoryId} never received an embedding (background embed did not run)`);
}

function resultIds(response: { json: unknown }): string[] {
  return asRecords(response.json, "results").map((row) => asString(row.id, "result id"));
}

export const knowledgeMemory: Scenario = {
  name: "knowledge-memory",
  order: 510,
  async run(ctx) {
    const agentA = await registerAgent(ctx, "mem-a");
    const agentB = await registerAgent(ctx, "mem-b");
    const lead = await ensureLead(ctx);
    const tag = `kn${ctx.nonce}`;
    const keyBase = `/longterm/facts/e2e-${ctx.nonce}`;

    const sessionA = await ctx.connectMcp(agentA);
    const sessionB = await ctx.connectMcp(agentB);
    const sessionLead = await ctx.connectMcp(lead);
    const taskId = await createPinnedTask(ctx, agentA, "memory retrieval task");
    const taskSession = await connectTaskMcp(ctx, agentA, taskId);
    const helperTasks = [taskId];
    try {
      // ── memory-store: agent scope, swarm scope, keyed, chunked ──────────────────────────────
      const privateContent = `Private sandwich fact ${tag}: the quokka${ctx.nonce} prefers kelp.`;
      const stored = expectToolOk(
        await callTool(sessionA, "memory-store", {
          content: privateContent,
          name: `Private fact ${tag}`,
          scope: "agent",
          tags: "e2e,knowledge",
          intent: "e2e: prove memory-store",
        }),
        "memory-store agent scope",
      );
      const privateIds = stored.data.memoryIds;
      expect(Array.isArray(privateIds) && privateIds.length === 1, "store returned one memory id");
      expect(stored.data.chunks === 1 && stored.data.queued === true, "store chunk/queue fields");
      expect(stored.data.yourAgentId === agentA, "store did not echo yourAgentId");
      const privateId = String(privateIds[0]);
      expect(UUID.test(privateId), "memory id is not a UUID");
      const privateRow = ctx.db.get<{
        agentId: string;
        scope: string;
        source: string;
        name: string;
        tags: string;
        key: string | null;
      }>("SELECT agentId, scope, source, name, tags, key FROM agent_memory WHERE id = ?", [
        privateId,
      ]);
      expect(
        privateRow?.agentId === agentA && privateRow.scope === "agent",
        "memory row owner/scope",
      );
      expect(privateRow.source === "manual", "memory-store writes source manual");
      expect(privateRow.tags.includes("knowledge"), "comma-separated tags were not split");
      expect(
        privateRow.key !== null && privateRow.key.length > 0,
        "an unkeyed memory still gets an auto key",
      );
      expect(
        dbCount(
          ctx,
          "SELECT count(*) AS n FROM agent_memory_version WHERE memory_id = ? AND operation = 'create'",
          [privateId],
        ) === 1,
        "memory create wrote no version row",
      );
      await waitForEmbedding(ctx, privateId);

      const swarmContent = `Shared swarm fact ${tag}: marmot${ctx.nonce} hibernates in winter.`;
      const swarmStored = expectToolOk(
        await callTool(sessionA, "memory-store", {
          content: swarmContent,
          name: `Swarm fact ${tag}`,
          scope: "swarm",
        }),
        "memory-store swarm scope",
      );
      const swarmId = String((swarmStored.data.memoryIds as unknown[])[0]);
      await waitForEmbedding(ctx, swarmId);

      const keyOne = `${keyBase}/one`;
      const keyed = expectToolOk(
        await callTool(sessionA, "memory-store", {
          content: `Keyed fact ${tag}: ocelot${ctx.nonce} is nocturnal.`,
          name: `Keyed fact ${tag}`,
          scope: "swarm",
          key: keyOne,
        }),
        "memory-store keyed",
      );
      const keyedId = String((keyed.data.memoryIds as unknown[])[0]);
      expect(
        ctx.db.get<{ key: string }>("SELECT key FROM agent_memory WHERE id = ?", [keyedId])?.key ===
          keyOne,
        "keyed memory did not persist its key",
      );
      expect(
        ctx.db.get<{ expiresAt: string | null }>(
          "SELECT expiresAt FROM agent_memory WHERE id = ?",
          [keyedId],
        )?.expiresAt === null,
        "a /longterm key must clear the expiry",
      );
      expectToolError(
        await callTool(sessionA, "memory-store", {
          content: "duplicate key body that is long enough to be a memory",
          scope: "swarm",
          key: keyOne,
        }),
        "memory-store duplicate key",
        /already used/i,
      );
      expectToolError(
        await callTool(sessionA, "memory-store", {
          content: "typo root body that is long enough to be a memory",
          key: "/longterm/fact/typo",
        }),
        "memory-store closed root list",
        /root|allowed|longterm/i,
      );
      expectToolError(
        await callTool(sessionA, "memory-store", {
          content: "worker writes a lead only root, a long enough body",
          key: `/longterm/timeline/e2e-${ctx.nonce}`,
        }),
        "memory-store lead-only root as worker",
        /lead|forbidden|permission|consolidated/i,
      );
      const leadStored = expectToolOk(
        await callTool(sessionLead, "memory-store", {
          content: `Lead timeline entry ${tag}: the swarm shipped a release with narwhal${ctx.nonce}.`,
          name: `Timeline ${tag}`,
          scope: "swarm",
          key: `/longterm/timeline/e2e-${ctx.nonce}`,
        }),
        "memory-store lead-only root as lead",
      );
      const timelineId = String((leadStored.data.memoryIds as unknown[])[0]);
      expectToolError(
        await callTool(sessionA, "memory-store", {
          content: "name-as-key body that is long enough",
          name: "/longterm/Bad Name",
        }),
        "memory-store invalid /longterm name",
        /key|longterm/i,
      );

      // A long document is split into chunks that share one key.
      const longBody = Array.from(
        { length: 40 },
        (_, index) =>
          `Paragraph ${index} of the walrus${ctx.nonce} handbook explains tusk care in detail, covering diet, habitat, migration and the social structure of the herd.`,
      ).join("\n\n");
      const longKey = `${keyBase}/long`;
      const longStored = expectToolOk(
        await callTool(sessionA, "memory-store", {
          content: longBody,
          name: `Long doc ${tag}`,
          scope: "agent",
          key: longKey,
        }),
        "memory-store long document",
      );
      const longIds = longStored.data.memoryIds as string[];
      expect(
        (longStored.data.chunks as number) > 1 && longIds.length === longStored.data.chunks,
        `long content was not chunked: ${JSON.stringify(longStored.data.chunks)}`,
      );

      // ── POST /api/memory/index ──────────────────────────────────────────────────────────────
      const indexBody = {
        content: `Indexed note ${tag}: the pangolin${ctx.nonce} curls up when threatened.`,
        name: `Indexed note ${tag}`,
        scope: "agent",
        source: "manual",
        agentId: agentA,
        tags: ["indexed", tag],
      };
      let response = await ctx.api("POST", "/api/memory/index", {
        agentId: agentA,
        body: indexBody,
      });
      expectStatus(response, [202], "index memory");
      let indexed = asRecord(response.json);
      expect(indexed.queued === true, "index did not queue");
      expect(
        Array.isArray(indexed.memoryIds) && indexed.memoryIds.length === 1,
        "index memory ids",
      );
      const indexedId = String((indexed.memoryIds as unknown[])[0]);
      await waitForEmbedding(ctx, indexedId);

      // A file_index sourcePath re-index edits the single chunk in place.
      const sourcePath = `/workspace/e2e-${ctx.nonce}/notes.md`;
      const fileBody = {
        content: `File index note ${tag}: the lemur${ctx.nonce} sunbathes on rocks every morning.`,
        name: `Notes ${tag}`,
        scope: "agent",
        source: "file_index",
        sourcePath,
        agentId: agentA,
      };
      response = await ctx.api("POST", "/api/memory/index", { agentId: agentA, body: fileBody });
      expectStatus(response, [202], "index file_index");
      const fileId = String((asRecord(response.json).memoryIds as unknown[])[0]);
      response = await ctx.api("POST", "/api/memory/index", {
        agentId: agentA,
        body: { ...fileBody, content: `${fileBody.content} It also eats fruit.` },
      });
      expectStatus(response, [202], "re-index file_index");
      indexed = asRecord(response.json);
      expect(
        indexed.edited === true && indexed.queued === false,
        `re-index of the same sourcePath must edit in place: ${JSON.stringify(indexed)}`,
      );
      expect(
        (indexed.memoryIds as unknown[])[0] === fileId,
        "re-index kept a different memory id (the id must survive an edit)",
      );
      response = await ctx.api("POST", "/api/memory/index", {
        agentId: agentA,
        body: { ...indexBody, content: "" },
      });
      expectStatus(response, [400], "index with empty content");
      response = await ctx.api("POST", "/api/memory/index", {
        agentId: agentA,
        body: { ...indexBody, scope: "universe" },
      });
      expectStatus(response, [400], "index with an invalid scope");
      response = await ctx.api("POST", "/api/memory/index", {
        agentId: agentA,
        body: { ...fileBody, sourcePath: "/longterm/fact/typo" },
      });
      expectStatus(response, [400], "index with a typo'd /longterm sourcePath");
      response = await ctx.api("POST", "/api/memory/index", {
        agentId: agentA,
        body: { ...fileBody, sourcePath: `/longterm/company-story/e2e-${ctx.nonce}` },
      });
      expectStatus(response, [403], "worker indexes a lead-only sourcePath");
      response = await ctx.api("POST", "/api/memory/index", {
        agentId: lead,
        body: {
          ...fileBody,
          agentId: lead,
          scope: "swarm",
          sourcePath: `/longterm/company-story/e2e-${ctx.nonce}`,
        },
      });
      expectStatus(response, [202], "lead indexes a lead-only sourcePath");

      // ── POST /api/memory/search: semantic, keyword, filters, ACL ────────────────────────────
      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentA,
        body: { query: privateContent },
      });
      expectStatus(response, [200], "semantic search");
      let results = asRecords(response.json, "results");
      expect(results.length > 0, "semantic search returned nothing");
      expect(
        results[0]?.id === privateId,
        `exact-text search must rank the stored memory first, got ${String(results[0]?.id)}`,
      );
      const top = results[0]!;
      expect(top.scope === "agent" && top.source === "manual", "search result scope/source");
      expect(
        typeof top.similarity === "number" && top.similarity > 0,
        "an exact-text match must carry a positive similarity",
      );
      expect(Array.isArray(top.tags) && (top.tags as string[]).includes("e2e"), "search tags");
      expect(typeof top.accessCount === "number", "search accessCount");

      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentA,
        body: { query: `quokka${ctx.nonce}`, limit: 3 },
      });
      expectStatus(response, [200], "keyword search");
      results = asRecords(response.json, "results");
      expect(results.length <= 3, "search ignored limit");
      const keywordHit = results.find((row) => row.id === privateId);
      expect(keywordHit, "a unique keyword did not find the memory (FTS arm)");
      expect(
        ["fts", "hybrid", "vec", "fallback", "graph"].includes(String(keywordHit.retrievalSource)),
        "search result retrievalSource",
      );

      // Isolation: B cannot see A's agent-scope memory but sees swarm memory.
      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentB,
        body: { query: privateContent, scope: "all", limit: 20 },
      });
      expectStatus(response, [200], "search as another agent");
      expect(
        !resultIds(response).includes(privateId),
        "agent-scope memory leaked to another agent",
      );
      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentB,
        body: { query: swarmContent, scope: "swarm" },
      });
      expectStatus(response, [200], "search swarm scope as another agent");
      expect(resultIds(response)[0] === swarmId, "swarm-scope memory was not shared");
      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentA,
        body: { query: swarmContent, scope: "agent", limit: 20 },
      });
      expect(!resultIds(response).includes(swarmId), "scope=agent returned a swarm memory");
      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentA,
        body: { query: `ocelot${ctx.nonce}`, keyPrefix: `${keyBase}/`, limit: 20 },
      });
      expectStatus(response, [200], "search with keyPrefix");
      results = asRecords(response.json, "results");
      expect(
        resultIds(response).includes(keyedId) &&
          resultIds(response).every((id) => id !== privateId),
        "keyPrefix must narrow results to the keyed memories",
      );
      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentA,
        body: { query: fileBody.content, source: "file_index", limit: 20 },
      });
      expectStatus(response, [200], "search with source filter");
      results = asRecords(response.json, "results");
      expect(
        results.length > 0 && results.every((row) => row.source === "file_index"),
        "source=file_index must filter other sources out",
      );
      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentA,
        headers: { "X-Memory-Consumption": "prompt" },
        body: { query: privateContent },
      });
      expectStatus(response, [200], "prompt-consumption search");
      asRecords(response.json, "results");
      response = await ctx.api("POST", "/api/memory/search", { body: { query: "no agent" } });
      expectStatus(response, [400], "search without X-Agent-ID");
      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentA,
        body: { query: "" },
      });
      expectStatus(response, [400], "search with an empty query");
      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentA,
        body: { query: "x", limit: 21 },
      });
      expectStatus(response, [400], "search limit above the maximum");

      // MCP memory-search: scope/limit/keyPrefix, task-bound retrieval rows and rate hints.
      let outcome = expectToolOk(
        await callTool(sessionA, "memory-search", { query: privateContent, limit: 5 }),
        "memory-search",
      );
      let searchResults = outcome.data.results as Json[];
      expect(searchResults[0]?.id === privateId, "memory-search did not rank the exact text first");
      expect(outcome.text.includes(privateId), "memory-search text channel lacks the id");
      expect(searchResults[0]?.rateHint === undefined, "rateHint only belongs inside a task");
      outcome = expectToolOk(
        await callTool(sessionB, "memory-search", { query: privateContent, scope: "agent" }),
        "memory-search other agent",
      );
      expect(
        !JSON.stringify(outcome.data.results ?? []).includes(privateId),
        "memory-search leaked another agent's private memory",
      );
      outcome = expectToolOk(
        await callTool(sessionA, "memory-search", {
          query: `ocelot${ctx.nonce}`,
          keyPrefix: `${keyBase}/`,
        }),
        "memory-search keyPrefix",
      );
      expect(JSON.stringify(outcome.data.results).includes(keyedId), "keyPrefix search lost hit");

      // In a task: retrievals are recorded and rate hints appear.
      outcome = expectToolOk(
        await callTool(taskSession, "memory-search", {
          query: privateContent,
          intent: "e2e: find the quokka fact",
        }),
        "memory-search in a task",
      );
      searchResults = outcome.data.results as Json[];
      expect(
        typeof searchResults[0]?.rateHint === "string" &&
          String(searchResults[0]?.rateHint).includes(privateId),
        "in a task, manual memories carry a rateHint",
      );
      expect(
        dbCount(
          ctx,
          "SELECT count(*) AS n FROM memory_retrieval WHERE taskId = ? AND memoryId = ? AND eventType = 'search'",
          [taskId, privateId],
        ) === 1,
        "memory-search inside a task did not record a retrieval row",
      );

      // HTTP search with the retrieval bridge: X-Source-Task-ID + intent.
      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentA,
        headers: { "X-Source-Task-ID": taskId },
        body: { query: swarmContent, scope: "all", intent: "e2e: HTTP retrieval bridge" },
      });
      expectStatus(response, [200], "search with retrieval bridge");
      expect(resultIds(response)[0] === swarmId, "bridge search ranked the wrong memory");
      expect(
        dbCount(
          ctx,
          "SELECT count(*) AS n FROM memory_retrieval WHERE taskId = ? AND memoryId = ? AND intent = ?",
          [taskId, swarmId, "e2e: HTTP retrieval bridge"],
        ) === 1,
        "HTTP search with intent + X-Source-Task-ID did not record a retrieval row",
      );
      expect(
        (ctx.db.get<{ accessCount: number }>("SELECT accessCount FROM agent_memory WHERE id = ?", [
          swarmId,
        ])?.accessCount ?? 0) >= 1,
        "search with an intent must count as an access",
      );

      // ── GET /api/memory/{id}, memory-get, links and backlinks ───────────────────────────────
      response = await ctx.api("GET", `/api/memory/${privateId}`, { agentId: agentA });
      expectStatus(response, [200], "get memory");
      const doc = asRecord(response.json);
      const memory = asRecord(doc.memory);
      expect(memory.id === privateId && memory.content === privateContent, "get memory body");
      expect(memory.version === 1 && memory.scope === "agent", "get memory version/scope");
      expect(
        Array.isArray(doc.links) && Array.isArray(doc.backlinks),
        "get memory lacks links/backlinks",
      );
      response = await ctx.api("GET", `/api/memory/${privateId}`, { agentId: agentB });
      expectStatus(response, [403], "get another agent's private memory");
      response = await ctx.api("GET", `/api/memory/${crypto.randomUUID()}`, { agentId: agentA });
      expectStatus(response, [404], "get unknown memory");
      response = await ctx.api("GET", "/api/memory/not-a-uuid", { agentId: agentA });
      expectStatus(response, [400], "get memory with an invalid id");
      response = await ctx.api(
        "GET",
        `/api/memory/${swarmId}?intent=${encodeURIComponent("e2e: get bridge")}`,
        { agentId: agentA, headers: { "X-Source-Task-ID": taskId } },
      );
      expectStatus(response, [200], "get memory with retrieval bridge");
      expect(
        dbCount(
          ctx,
          "SELECT count(*) AS n FROM memory_retrieval WHERE taskId = ? AND memoryId = ? AND eventType = 'get'",
          [taskId, swarmId],
        ) === 1,
        "GET with intent + X-Source-Task-ID did not record a 'get' retrieval",
      );

      // Wikilink from a second memory to the swarm memory: link out, backlink in.
      const linkerContent = `Linker note ${tag}: see [[Swarm fact ${tag}]] and https://github.com/e2e-org/e2e-repo/pull/42 for context.`;
      const linker = expectToolOk(
        await callTool(sessionA, "memory-store", {
          content: linkerContent,
          name: `Linker ${tag}`,
          scope: "swarm",
        }),
        "memory-store linker",
      );
      const linkerId = String((linker.data.memoryIds as unknown[])[0]);
      response = await ctx.api("GET", `/api/memory/${linkerId}`, { agentId: agentA });
      expectStatus(response, [200], "get linker memory");
      const links = asRecords(response.json, "links");
      const wikilink = links.find((link) => link.linkType === "wikilink");
      expect(
        wikilink?.resolved === true && asRecord(wikilink.target).id === swarmId,
        `wikilink did not resolve to the swarm memory: ${JSON.stringify(links)}`,
      );
      expect(
        links.some((link) => link.linkType === "pr" && link.targetKind === "pr"),
        "a GitHub PR URL did not become a pr link",
      );
      response = await ctx.api("GET", `/api/memory/${swarmId}`, { agentId: agentB });
      expectStatus(response, [200], "get swarm memory as another agent");
      const backlinks = asRecords(response.json, "backlinks");
      expect(
        backlinks.some((link) => asRecord(link.from).id === linkerId),
        "swarm memory shows no backlink from the linker",
      );
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM memory_link WHERE from_memory_id = ?", [
          linkerId,
        ]) >= 2,
        "memory_link rows were not persisted",
      );

      outcome = expectToolOk(
        await callTool(taskSession, "memory-get", { memoryId: privateId, intent: "e2e: read" }),
        "memory-get",
      );
      expect(asRecord(outcome.data.memory).id === privateId, "memory-get returned another memory");
      expect(outcome.text.includes(privateContent), "memory-get text lacks the content");
      expect(
        typeof outcome.data.rateHint === "string",
        "memory-get inside a task offers a rateHint for manual memories",
      );
      outcome = expectToolOk(
        await callTool(sessionA, "memory-get", { id: linkerId }),
        "memory-get by id alias",
      );
      expect(
        Array.isArray(outcome.data.links) && (outcome.data.links as unknown[]).length >= 2,
        "memory-get lacks outgoing links",
      );
      expectToolError(
        await callTool(sessionB, "memory-get", { memoryId: privateId }),
        "memory-get another agent's private memory",
        /Not authorized/i,
      );
      expectToolError(
        await callTool(sessionA, "memory-get", { memoryId: crypto.randomUUID() }),
        "memory-get unknown",
        /not found/i,
      );
      expectToolError(
        await callTool(sessionA, "memory-get", {}),
        "memory-get without id",
        /memoryId/i,
      );
      expectToolError(
        await callTool(sessionA, "memory-get", { memoryId: privateId, id: swarmId }),
        "memory-get with conflicting ids",
        /same memory/i,
      );

      // ── Rating: HTTP, explicit-self guards, memory_rate, references edges ───────────────────
      // Stored after every retrieval above, so no task ever surfaced it.
      const neverRetrieved = expectToolOk(
        await callTool(sessionA, "memory-store", {
          content: `Unretrieved fact ${tag}: the axolotl${ctx.nonce} regrows limbs, which nothing else mentions.`,
          name: `Unretrieved ${tag}`,
          scope: "agent",
        }),
        "memory-store never-retrieved",
      );
      const neverRetrievedId = String((neverRetrieved.data.memoryIds as unknown[])[0]);
      const alphaBefore = ctx.db.get<{ alpha: number }>(
        "SELECT alpha FROM agent_memory WHERE id = ?",
        [privateId],
      )?.alpha;
      response = await ctx.api("POST", "/api/memory/rate", {
        agentId: agentA,
        body: {
          events: [
            {
              memoryId: privateId,
              signal: 1,
              weight: 1,
              source: "llm",
              reasoning: "e2e llm rating",
              model: "e2e/model",
            },
          ],
        },
      });
      expectStatus(response, [200], "rate with the llm source");
      expect(
        asRecord(response.json).applied === 1 && asRecords(response.json, "rejected").length === 0,
        `llm rating was not applied: ${response.text}`,
      );
      const alphaAfter = ctx.db.get<{ alpha: number }>(
        "SELECT alpha FROM agent_memory WHERE id = ?",
        [privateId],
      )?.alpha;
      expect(
        typeof alphaBefore === "number" &&
          typeof alphaAfter === "number" &&
          alphaAfter > alphaBefore,
        `a positive rating must raise alpha (${alphaBefore} -> ${alphaAfter})`,
      );
      expect(
        dbCount(
          ctx,
          "SELECT count(*) AS n FROM memory_rating WHERE memoryId = ? AND source = 'llm'",
          [privateId],
        ) === 1,
        "memory_rating row for the llm event",
      );
      response = await ctx.api("POST", "/api/memory/rate", {
        agentId: agentA,
        body: {
          events: [{ memoryId: crypto.randomUUID(), signal: 1, weight: 1, source: "llm" }],
        },
      });
      expectStatus(response, [200], "rate an unknown memory");
      expect(
        asRecord(response.json).applied === 0 && asRecords(response.json, "rejected").length === 1,
        "rating an unknown memory must be reported in rejected[]",
      );
      for (const [label, events] of [
        ["no events", []],
        ["signal out of range", [{ memoryId: privateId, signal: 2, weight: 1, source: "llm" }]],
        [
          "implicit-citation over HTTP",
          [{ memoryId: privateId, signal: 1, weight: 1, source: "implicit-citation" }],
        ],
        [
          "explicit-self without a task",
          [{ memoryId: privateId, signal: 1, weight: 1, source: "explicit-self" }],
        ],
        [
          "explicit-self without a retrieval",
          [
            {
              memoryId: neverRetrievedId,
              signal: 1,
              weight: 1,
              source: "explicit-self",
              taskId,
            },
          ],
        ],
      ] as const) {
        response = await ctx.api("POST", "/api/memory/rate", { agentId: agentA, body: { events } });
        expectStatus(response, [400], `rate: ${label}`);
      }
      response = await ctx.api("POST", "/api/memory/rate", {
        body: { events: [{ memoryId: privateId, signal: 1, weight: 1, source: "llm" }] },
      });
      expectStatus(response, [400], "rate without X-Agent-ID");

      // privateId was retrieved by taskId above: an explicit-self rating is allowed once.
      response = await ctx.api("POST", "/api/memory/rate", {
        agentId: agentA,
        body: {
          events: [
            {
              memoryId: privateId,
              signal: -1,
              weight: 1,
              source: "explicit-self",
              taskId,
              referencesSource: `github:e2e-org/e2e-repo#${ctx.nonce.length}`,
            },
          ],
        },
      });
      expectStatus(response, [200], "explicit-self rating after a retrieval");
      expect(asRecord(response.json).applied === 1, "explicit-self rating not applied");
      response = await ctx.api("POST", "/api/memory/rate", {
        agentId: agentA,
        body: {
          events: [{ memoryId: privateId, signal: 1, weight: 1, source: "explicit-self", taskId }],
        },
      });
      expectStatus(response, [409], "duplicate explicit-self rating");

      // memory_rate (MCP): needs a task session; duplicate and outside-task guards.
      expectToolError(
        await callTool(sessionA, "memory_rate", { id: swarmId, useful: true }),
        "memory_rate outside a task",
        /within a task/i,
      );
      expectToolOk(
        await callTool(taskSession, "memory_rate", {
          memoryId: swarmId,
          useful: true,
          note: "e2e: helpful",
          referencesSource: "linear:E2E-1",
        }),
        "memory_rate in a task",
      );
      expectToolError(
        await callTool(taskSession, "memory_rate", { id: swarmId, useful: false }),
        "memory_rate duplicate",
        /already rated/i,
      );
      expectToolError(
        await callTool(taskSession, "memory_rate", { id: neverRetrievedId, useful: true }),
        "memory_rate without a retrieval",
        /rejected|retrieved/i,
      );
      expectToolError(
        await callTool(taskSession, "memory_rate", { useful: true }),
        "memory_rate no id",
      );
      expectToolError(
        await callTool(taskSession, "memory_rate", {
          id: swarmId,
          memoryId: privateId,
          useful: true,
        }),
        "memory_rate with conflicting ids",
        /same memory/i,
      );
      expect(
        dbCount(
          ctx,
          "SELECT count(*) AS n FROM memory_rating WHERE memoryId = ? AND source = 'explicit-self'",
          [swarmId],
        ) === 1,
        "memory_rate wrote no memory_rating row",
      );

      // Edges created from referencesSource.
      response = await ctx.api("GET", `/api/memory/edges?memoryId=${swarmId}`, { agentId: agentA });
      expectStatus(response, [200], "list memory edges");
      const edges = asRecords(response.json, "edges");
      const edge = edges.find((row) => row.to === "linear:E2E-1");
      expect(edge, `memory_rate referencesSource produced no edge: ${JSON.stringify(edges)}`);
      expect(edge.type === "references-source", "edge type");
      expect(
        typeof edge.usefulness === "number" && typeof edge.alpha === "number",
        "edge usefulness fields",
      );
      response = await ctx.api("GET", "/api/memory/edges", { agentId: agentA });
      expectStatus(response, [400], "edges without memoryId");
      response = await ctx.api("GET", `/api/memory/edges?memoryId=${swarmId}`);
      expectStatus(response, [400], "edges without X-Agent-ID");

      // Retrievals for the task.
      response = await ctx.api("GET", `/api/memory/retrievals?taskId=${taskId}`, {
        agentId: agentA,
      });
      expectStatus(response, [200], "list retrievals");
      const retrieved = asRecords(response.json, "results").map((row) => row.id);
      expect(
        retrieved.includes(privateId) && retrieved.includes(swarmId),
        "retrievals lost a memory surfaced to the task",
      );
      response = await ctx.api("GET", "/api/memory/retrievals", { agentId: agentA });
      expectStatus(response, [400], "retrievals without taskId or sessionId");
      response = await ctx.api("GET", `/api/memory/retrievals?taskId=${taskId}`);
      expectStatus(response, [400], "retrievals without X-Agent-ID");

      // ── Edit: replace, exact, unchanged, version conflict, move, ACL ────────────────────────
      outcome = expectToolOk(
        await callTool(sessionA, "memory-edit", {
          memoryId: privateId,
          mode: "replace",
          content: `${privateContent} Updated once.`,
          intent: "e2e: replace",
        }),
        "memory-edit replace",
      );
      expect(outcome.data.changed === true && outcome.data.version === 2, "replace bumps version");
      expect(outcome.data.previousVersion === 1, "replace previousVersion");
      outcome = expectToolOk(
        await callTool(sessionA, "memory-edit", {
          memoryId: privateId,
          mode: "exact",
          oldString: "Updated once.",
          newString: "Updated twice.",
          intent: "e2e: exact",
          expectedVersion: 2,
        }),
        "memory-edit exact",
      );
      expect(outcome.data.version === 3, "exact edit bumps version");
      expect(
        asRecord(outcome.data.memory).content === `${privateContent} Updated twice.`,
        "exact edit content",
      );
      outcome = expectToolOk(
        await callTool(sessionA, "memory-edit", {
          memoryId: privateId,
          mode: "replace",
          content: `${privateContent} Updated twice.`,
          intent: "e2e: no-op",
        }),
        "memory-edit unchanged",
      );
      expect(outcome.data.changed === false && outcome.data.version === 3, "no-op edit unchanged");
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM agent_memory_version WHERE memory_id = ?", [
          privateId,
        ]) === 3,
        "edits must write one version row each (create + 2 edits)",
      );
      expectToolError(
        await callTool(sessionA, "memory-edit", {
          memoryId: privateId,
          mode: "exact",
          oldString: "this text does not exist anywhere",
          newString: "x",
          intent: "e2e: missing",
        }),
        "memory-edit exact missing",
      );
      expectToolError(
        await callTool(sessionA, "memory-edit", {
          memoryId: privateId,
          content: "stale write",
          intent: "e2e: stale",
          expectedVersion: 1,
        }),
        "memory-edit stale version",
        /conflict/i,
      );
      expectToolError(
        await callTool(sessionB, "memory-edit", {
          memoryId: privateId,
          content: "hijack attempt",
          intent: "e2e: acl",
        }),
        "memory-edit another agent's memory",
        /Permission denied/i,
      );
      expectToolError(
        await callTool(sessionA, "memory-edit", {
          memoryId: crypto.randomUUID(),
          content: "ghost",
          intent: "e2e: ghost",
        }),
        "memory-edit unknown",
        /not found/i,
      );
      expectToolError(
        await callTool(sessionA, "memory-edit", { content: "no target", intent: "e2e: no target" }),
        "memory-edit without a target",
        /memoryId or key/i,
      );
      outcome = expectToolOk(
        await callTool(sessionLead, "memory-edit", {
          memoryId: privateId,
          mode: "exact",
          oldString: "Updated twice.",
          newString: "Lead touched.",
          intent: "e2e: lead edits any",
        }),
        "memory-edit as lead",
      );
      expect(outcome.data.version === 4, "lead edit version");
      // Move by key (every chunk, same id), keyed edit, and move guard.
      const movedKey = `${keyBase}/moved`;
      outcome = expectToolOk(
        await callTool(sessionA, "memory-edit", {
          memoryId: swarmId,
          newKey: movedKey,
          intent: "e2e: move",
        }),
        "memory-edit newKey",
      );
      expect(asRecord(outcome.data.memory).key === movedKey, "newKey did not move the memory");
      outcome = expectToolOk(
        await callTool(sessionA, "memory-edit", {
          key: movedKey,
          scope: "swarm",
          mode: "replace",
          content: `${swarmContent} Edited by key.`,
          intent: "e2e: edit by key",
        }),
        "memory-edit by key and scope",
      );
      expect(outcome.data.changed === true, "edit by key changed nothing");
      expectToolError(
        await callTool(sessionA, "memory-edit", {
          memoryId: swarmId,
          newKey: `/longterm/entities/people/e2e-${ctx.nonce}`,
          intent: "e2e: lead only move",
        }),
        "memory-edit move into a lead-only root",
        /lead|forbidden|permission|consolidated/i,
      );

      // HTTP edit.
      response = await ctx.api("POST", "/api/memory/edit", {
        agentId: agentA,
        body: {
          memoryId: indexedId,
          mode: "replace",
          content: `${indexBody.content} Edited over HTTP.`,
          intent: "e2e: http edit",
          expectedVersion: 1,
        },
      });
      expectStatus(response, [200], "HTTP memory edit");
      let edited = asRecord(response.json);
      expect(
        edited.changed === true && edited.version === 2 && edited.previousVersion === 1,
        "HTTP edit result",
      );
      expect(
        typeof edited.contentHash === "string" && asRecord(edited.memory).id === indexedId,
        "HTTP edit memory/contentHash",
      );
      response = await ctx.api("POST", "/api/memory/edit", {
        agentId: agentA,
        body: { memoryId: indexedId, content: "stale", intent: "stale", expectedVersion: 1 },
      });
      expectStatus(response, [409], "HTTP edit version conflict");
      response = await ctx.api("POST", "/api/memory/edit", {
        agentId: agentB,
        body: { memoryId: indexedId, content: "hijack", intent: "acl" },
      });
      expectStatus(response, [403], "HTTP edit of another agent's memory");
      response = await ctx.api("POST", "/api/memory/edit", {
        agentId: agentA,
        body: { memoryId: crypto.randomUUID(), content: "ghost", intent: "ghost" },
      });
      expectStatus(response, [404], "HTTP edit of an unknown memory");
      response = await ctx.api("POST", "/api/memory/edit", {
        agentId: agentA,
        body: { content: "no target", intent: "no target" },
      });
      expectStatus(response, [400], "HTTP edit without a target");
      response = await ctx.api("POST", "/api/memory/edit", {
        body: { memoryId: indexedId, content: "anon", intent: "anon" },
      });
      expectStatus(response, [400], "HTTP edit without X-Agent-ID");
      response = await ctx.api("POST", "/api/memory/edit", {
        agentId: agentA,
        body: { memoryId: indexedId, content: "no intent" },
      });
      expectStatus(response, [400], "HTTP edit without an intent");
      response = await ctx.api("POST", "/api/memory/edit", {
        agentId: lead,
        body: {
          memoryId: indexedId,
          mode: "exact",
          oldString: "Edited over HTTP.",
          newString: "Lead edited over HTTP.",
          intent: "lead edits any",
        },
      });
      expectStatus(response, [200], "HTTP edit by the lead");
      edited = asRecord(response.json);
      expect(edited.version === 3, "lead HTTP edit version");

      // After an edit the new text is what search finds.
      await waitForEmbedding(ctx, privateId);
      response = await ctx.api("POST", "/api/memory/search", {
        agentId: agentA,
        body: { query: "Lead touched.", limit: 20 },
      });
      expectStatus(response, [200], "search after edits");
      asRecords(response.json, "results");

      // ── List, keys, chunks, health, usefulness, re-embed ────────────────────────────────────
      response = await ctx.api("POST", "/api/memory/list", { body: { limit: 100 } });
      expectStatus(response, [200], "operator lists memories");
      let listing = asRecord(response.json);
      expect(
        listing.mode === "list" && listing.limit === 100 && listing.offset === 0,
        "list envelope",
      );
      const operatorIds = asRecords(listing, "results").map((row) => row.id);
      expect(
        operatorIds.includes(privateId) && operatorIds.includes(swarmId),
        "operator must see every agent's memories",
      );
      expect(typeof listing.total === "number" && listing.total >= 6, "list total");
      const listed = asRecords(listing, "results").find((row) => row.id === privateId)!;
      expect(
        typeof listed.rating === "number" && listed.agentId === agentA && listed.scope === "agent",
        "list row fields",
      );
      response = await ctx.api("POST", "/api/memory/list", {
        agentId: agentB,
        body: { limit: 100 },
      });
      expectStatus(response, [200], "agent lists memories");
      const bIds = asRecords(response.json, "results").map((row) => row.id);
      expect(!bIds.includes(privateId), "list leaked another agent's private memory");
      expect(bIds.includes(swarmId), "list hid a swarm memory from an agent");
      response = await ctx.api("POST", "/api/memory/list", {
        body: { agentId: agentA, scope: "agent", source: "file_index", sourcePath: "NOTES.MD" },
      });
      expectStatus(response, [200], "list with filters");
      const filtered = asRecords(response.json, "results");
      expect(
        filtered.length === 1 &&
          filtered[0]?.id === fileId &&
          String(filtered[0]?.sourcePath).includes(ctx.nonce),
        "sourcePath substring filter is case-insensitive and exact here",
      );
      response = await ctx.api("POST", "/api/memory/list", {
        body: { query: swarmContent, scope: "swarm", limit: 5 },
      });
      expectStatus(response, [200], "semantic list");
      listing = asRecord(response.json);
      expect(listing.mode === "semantic", "list with a query is semantic");
      const semantic = asRecords(listing, "results");
      expect(semantic[0]?.id === swarmId, "semantic list did not rank the exact text first");
      expect(typeof semantic[0]?.similarity === "number", "semantic list rows carry a similarity");
      response = await ctx.api("POST", "/api/memory/list", {
        body: { agentId: agentA, scope: "agent", limit: 1, offset: 1 },
      });
      expectStatus(response, [200], "list pagination");
      listing = asRecord(response.json);
      expect(
        asRecords(listing, "results").length === 1 && listing.offset === 1 && listing.limit === 1,
        "list pagination envelope",
      );
      response = await ctx.api("POST", "/api/memory/list", { body: { limit: 0 } });
      expectStatus(response, [400], "list with an invalid limit");

      response = await ctx.api(
        "GET",
        `/api/memory/keys?prefix=${encodeURIComponent(`${keyBase}/`)}`,
      );
      expectStatus(response, [200], "list memory keys");
      let keyListing = asRecord(response.json);
      expect(
        keyListing.prefix === `${keyBase}/` && keyListing.truncated === false,
        "keys envelope",
      );
      const keyRows = asRecords(keyListing, "keys");
      const byKey = new Map(keyRows.map((row) => [row.key, row]));
      expect(byKey.has(movedKey) && byKey.has(longKey), "keys lost a keyed memory");
      const longRow = asRecord(byKey.get(longKey));
      expect(
        longRow.complete === true && longRow.chunkRows === longRow.totalChunks,
        "a fully stored chunked document must be complete",
      );
      expect(
        typeof longRow.estTokens === "number" &&
          Math.ceil((longRow.chars as number) / 4) === longRow.estTokens,
        "estTokens = ceil(chars / 4)",
      );
      response = await ctx.api(
        "GET",
        `/api/memory/keys?prefix=${encodeURIComponent(`${keyBase}/`)}&limit=1`,
      );
      expectStatus(response, [200], "keys with a limit");
      keyListing = asRecord(response.json);
      expect(
        asRecords(keyListing, "keys").length === 1 && keyListing.truncated === true,
        "keys limit must truncate",
      );
      response = await ctx.api("GET", "/api/memory/keys?limit=0");
      expectStatus(response, [400], "keys with an invalid limit");
      response = await ctx.api("GET", "/api/memory/keys", { agentId: agentB });
      expectStatus(response, [200], "keys as another agent");
      expect(
        !asRecords(response.json, "keys").some((row) => row.key === longKey),
        "keys leaked another agent's private document",
      );

      response = await ctx.api("GET", `/api/memory/chunks?memoryId=${longIds[1]}`);
      expectStatus(response, [200], "chunks by memoryId");
      let chunkDoc = asRecord(response.json);
      const chunks = asRecords(chunkDoc, "chunks");
      expect(chunks.length === longIds.length, "chunks must list every chunk row");
      expect(
        chunks.every((chunk, index) => chunk.chunkIndex === index),
        "chunks are in chunkIndex order",
      );
      const integrity = asRecord(chunkDoc.integrity);
      expect(
        integrity.ok === true && integrity.expectedChunks === longIds.length,
        `chunk integrity must hold: ${JSON.stringify(integrity)}`,
      );
      response = await ctx.api(
        "GET",
        `/api/memory/chunks?key=${encodeURIComponent(longKey)}&scope=agent&agentId=${agentA}`,
      );
      expectStatus(response, [200], "chunks by key");
      chunkDoc = asRecord(response.json);
      expect(chunkDoc.key === longKey && chunkDoc.agentId === agentA, "chunks by key envelope");
      response = await ctx.api("GET", "/api/memory/chunks");
      expectStatus(response, [400], "chunks without memoryId or key");
      response = await ctx.api("GET", `/api/memory/chunks?memoryId=${crypto.randomUUID()}`);
      expectStatus(response, [404], "chunks of an unknown memory");
      response = await ctx.api("GET", `/api/memory/chunks?memoryId=${longIds[0]}`, {
        agentId: agentB,
      });
      expectStatus(response, [404], "chunks of another agent's private memory read as not found");

      response = await ctx.api("GET", "/api/memory/health");
      expectStatus(response, [200], "memory health");
      const health = asRecord(response.json);
      const counts = asRecord(health.counts);
      expect(
        typeof counts.total === "number" &&
          counts.total >= 6 &&
          typeof counts.searchable === "number" &&
          typeof counts.withEmbedding === "number",
        "health counts",
      );
      expect(["vec", "fallback"].includes(String(health.retrievalMode)), "health retrievalMode");
      expect(Array.isArray(health.reasons), "health reasons");
      expect(asRecord(health.sqliteVec).distanceMetric === "cosine", "health distance metric");

      response = await ctx.api("GET", "/api/memory/usefulness?days=7&threshold=0.5");
      expectStatus(response, [200], "memory usefulness");
      const usefulness = asRecord(response.json);
      expect(usefulness.windowDays === 7 && usefulness.threshold === 0.5, "usefulness window");
      const volume = asRecord(usefulness.volume);
      expect(
        typeof volume.retrievals === "number" && volume.retrievals >= 3,
        `usefulness must count the retrievals made above: ${JSON.stringify(volume)}`,
      );
      expect(
        asRecord(usefulness.sanity).totalRatingRows !== undefined &&
          Array.isArray(usefulness.byArm) &&
          Array.isArray(usefulness.citationBySource),
        "usefulness sections",
      );
      response = await ctx.api("GET", "/api/memory/usefulness");
      expectStatus(response, [200], "usefulness defaults");
      expect(asRecord(response.json).windowDays === 30, "usefulness defaults to 30 days");
      response = await ctx.api("GET", "/api/memory/usefulness?days=0");
      expectStatus(response, [400], "usefulness with an invalid window");
      response = await ctx.api("GET", "/api/memory/usefulness?threshold=2");
      expectStatus(response, [400], "usefulness with an invalid threshold");

      response = await ctx.api("POST", "/api/memory/re-embed", {
        body: { agentId: agentA, batchSize: 5 },
      });
      expectStatus(response, [202], "re-embed one agent's memories");
      const reEmbed = asRecord(response.json);
      const expectedForA = dbCount(
        ctx,
        "SELECT count(*) AS n FROM agent_memory WHERE agentId = ?",
        [agentA],
      );
      expect(
        reEmbed.started === true && reEmbed.totalMemories === expectedForA,
        `re-embed totalMemories ${String(reEmbed.totalMemories)} != ${expectedForA}`,
      );
      response = await ctx.api("POST", "/api/memory/re-embed", { body: { batchSize: 0 } });
      expectStatus(response, [400], "re-embed with an invalid batch size");
      response = await ctx.api("POST", "/api/memory/re-embed", { body: { agentId: "not-a-uuid" } });
      expectStatus(response, [400], "re-embed with an invalid agent id");

      // ── Delete: ACL matrix, then the row is gone ────────────────────────────────────────────
      expectToolError(
        await callTool(sessionB, "memory-delete", { memoryId: privateId }),
        "memory-delete another agent's memory",
        /Permission denied/i,
      );
      expectToolError(
        await callTool(sessionB, "memory-delete", { memoryId: linkerId }),
        "memory-delete a swarm memory as a worker",
        /Permission denied/i,
      );
      expectToolError(
        await callTool(sessionA, "memory-delete", { memoryId: crypto.randomUUID() }),
        "memory-delete unknown",
        /not found/i,
      );
      expectToolOk(
        await callTool(sessionA, "memory-delete", { memoryId: privateId }),
        "memory-delete own agent-scope memory",
      );
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM agent_memory WHERE id = ?", [privateId]) === 0,
        "memory-delete left the row behind",
      );
      expectToolOk(
        await callTool(sessionLead, "memory-delete", { memoryId: linkerId }),
        "memory-delete a swarm memory as lead",
      );
      response = await ctx.api("GET", `/api/memory/${privateId}`, { agentId: agentA });
      expectStatus(response, [404], "get a deleted memory");

      response = await ctx.api("DELETE", `/api/memory/${indexedId}`, { agentId: agentB });
      expectStatus(response, [403], "HTTP delete of another agent's memory");
      response = await ctx.api("DELETE", `/api/memory/${crypto.randomUUID()}`);
      expectStatus(response, [404], "HTTP delete of an unknown memory");
      response = await ctx.api("DELETE", "/api/memory/not-a-uuid");
      expectStatus(response, [400], "HTTP delete with an invalid id");
      response = await ctx.api("DELETE", `/api/memory/${swarmId}`, { agentId: agentA });
      expectStatus(response, [403], "a worker cannot delete a swarm-scope memory, even its own");
      response = await ctx.api("DELETE", `/api/memory/${indexedId}`, { agentId: agentA });
      expectStatus(response, [200], "HTTP delete of own memory");
      expect(asRecord(response.json).deleted === true, "HTTP delete body");
      response = await ctx.api("DELETE", `/api/memory/${swarmId}`);
      expectStatus(response, [200], "operator deletes any memory");
      response = await ctx.api("DELETE", `/api/memory/${swarmId}`);
      expectStatus(response, [404], "operator deletes a memory twice");
      for (const id of [fileId, keyedId, timelineId]) {
        response = await ctx.api("DELETE", `/api/memory/${id}`);
        expectStatus(response, [200], "operator cleanup delete");
      }
      response = await ctx.api("DELETE", `/api/memory/${longIds[0]}`);
      expectStatus(response, [200], "operator deletes one chunk of a document");
      response = await ctx.api("DELETE", `/api/memory/${longIds[1]}`);
      expectStatus(response, [404], "deleting a chunk removes the whole document");
      for (const id of [neverRetrievedId]) {
        response = await ctx.api("DELETE", `/api/memory/${id}`);
        expectStatus(response, [200], "operator cleanup delete");
      }
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM agent_memory WHERE agentId = ? AND key = ?", [
          agentA,
          longKey,
        ]) === 0,
        "chunk rows of the long document remain",
      );
    } finally {
      await taskSession.close();
      await sessionLead.close();
      await sessionB.close();
      await sessionA.close();
      for (const id of helperTasks) await cancelTask(ctx, id).catch(() => {});
    }
  },
};
