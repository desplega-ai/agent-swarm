import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  callTool,
  dbCount,
  expectToolError,
  expectToolOk,
  registerAgent,
} from "./knowledge-helpers";

type Json = Record<string, unknown>;

function roomOf(response: { json: unknown }): Json {
  return asRecord(asRecord(response.json).room);
}

/**
 * The realtime room routes and tools that realtime-rooms.ts (WebSocket peers, `room.changed`
 * workflow waits, the script SDK) does not reach: the HTTP surface, every room-* tool and the
 * dashboard ticket.
 */
export const knowledgeRooms: Scenario = {
  name: "knowledge-rooms",
  order: 570,
  async run(ctx) {
    const agent = await registerAgent(ctx, "rooms");
    const session = await ctx.connectMcp(agent);
    const namespace = `e2e:rooms:${ctx.nonce}`;
    const pageIds: string[] = [];
    try {
      // ── Reset, read and the room view ───────────────────────────────────────────────────────
      let response = await ctx.api("POST", "/api/rooms/get", {
        body: { namespace, name: "alpha" },
      });
      expectStatus(response, [404], "read a room that does not exist (reads never create)");

      response = await ctx.api("POST", "/api/rooms/reset", {
        body: { namespace, name: "alpha", state: { count: 1, list: [1, 2], nested: { a: "x" } } },
      });
      expectStatus(response, [200], "reset creates a room");
      let room = roomOf(response);
      expect(
        room.namespace === namespace &&
          room.name === "alpha" &&
          room.schemaVersion === 1 &&
          room.stale === false &&
          typeof room.generation === "string" &&
          typeof room.snapshot === "string" &&
          typeof room.bytes === "number" &&
          room.bytes > 0,
        `room view: ${JSON.stringify(room).slice(0, 300)}`,
      );
      expect(
        JSON.stringify(room.state) ===
          JSON.stringify({ count: 1, list: [1, 2], nested: { a: "x" } }),
        "room state after reset",
      );
      const firstGeneration = asString(room.generation, "generation");

      response = await ctx.api("POST", "/api/rooms/get", { body: { namespace, name: "alpha" } });
      expectStatus(response, [200], "read a room over POST");
      expect(roomOf(response).generation === firstGeneration, "POST read returns the same room");
      response = await ctx.api(
        "GET",
        `/api/rooms/get?namespace=${encodeURIComponent(namespace)}&name=alpha`,
      );
      expectStatus(response, [200], "read a room over GET");
      expect(
        asRecord(roomOf(response).state).count === 1 && roomOf(response).snapshot === room.snapshot,
        "GET read returns the same snapshot",
      );
      response = await ctx.api(
        "GET",
        `/api/rooms/get?namespace=${encodeURIComponent(namespace)}&name=missing`,
      );
      expectStatus(response, [404], "GET read of a missing room");
      response = await ctx.api("GET", "/api/rooms/get?name=bad%20name");
      expectStatus(response, [400], "GET read with an invalid name");

      // A stale schema version is reported on read and refused on write.
      response = await ctx.api("POST", "/api/rooms/get", {
        body: { namespace, name: "alpha", schemaVersion: 2 },
      });
      expectStatus(response, [200], "read with a newer schema version");
      expect(roomOf(response).stale === true && roomOf(response).schemaVersion === 1, "stale flag");
      response = await ctx.api("POST", "/api/rooms/change", {
        body: {
          namespace,
          name: "alpha",
          schemaVersion: 2,
          operations: [{ type: "set", path: ["x"], value: 1 }],
        },
      });
      expectStatus(response, [409], "change with a mismatched schema version");

      // ── Change: every operation type ────────────────────────────────────────────────────────
      response = await ctx.api("POST", "/api/rooms/change", {
        body: {
          namespace,
          name: "alpha",
          operations: [
            { type: "set", path: ["title"], value: "hello" },
            { type: "set", path: ["nested", "b"], value: { deep: true } },
            { type: "increment", path: ["count"], by: 4 },
            { type: "insert", path: ["list"], index: 1, values: [10, 11] },
            { type: "delete", path: ["nested", "a"] },
            { type: "set", path: ["doc"], value: "abcdef" },
            { type: "text", path: ["doc"], index: 3, deleteCount: 2, insert: "XY" },
          ],
        },
      });
      expectStatus(response, [200], "change with every operation type");
      room = roomOf(response);
      const state = asRecord(room.state);
      expect(
        state.title === "hello" &&
          state.count === 5 &&
          JSON.stringify(state.list) === JSON.stringify([1, 10, 11, 2]) &&
          JSON.stringify(state.nested) === JSON.stringify({ b: { deep: true } }) &&
          state.doc === "abcXYf",
        `operations applied in order: ${JSON.stringify(state)}`,
      );
      expect(room.generation === firstGeneration, "a change keeps the generation");
      const flushed = await pollUntil(
        () =>
          dbCount(
            ctx,
            "SELECT count(*) AS n FROM kv_entries WHERE namespace = ? AND key = '_room/alpha'",
            [namespace],
          ) === 1,
        8_000,
        200,
      );
      expect(flushed, "the room snapshot was never persisted to kv_entries (_room/alpha)");

      for (const [label, operations] of [
        ["an empty batch", []],
        [
          "a text operation that neither inserts nor deletes",
          [{ type: "text", path: ["doc"], index: 0 }],
        ],
        ["an unknown operation", [{ type: "explode", path: ["a"] }]],
        ["a negative index", [{ type: "insert", path: ["list"], index: -1, values: [1] }]],
        ["an increment on a string", [{ type: "increment", path: ["title"], by: 1 }]],
      ] as const) {
        response = await ctx.api("POST", "/api/rooms/change", {
          body: { namespace, name: "alpha", operations },
        });
        expect(
          response.status >= 400 && response.status < 500,
          `change with ${label} must be a client error, got ${response.status}`,
        );
      }
      response = await ctx.api(
        "GET",
        `/api/rooms/get?namespace=${encodeURIComponent(namespace)}&name=alpha`,
      );
      expect(
        asRecord(roomOf(response).state).title === "hello",
        "a rejected batch leaves the room unchanged",
      );

      // Reset replaces state and starts a new generation; a new schema version unlocks writes.
      response = await ctx.api("POST", "/api/rooms/reset", {
        body: { namespace, name: "alpha", state: { fresh: true }, schemaVersion: 2 },
      });
      expectStatus(response, [200], "reset with a new schema version");
      room = roomOf(response);
      expect(
        room.schemaVersion === 2 &&
          room.generation !== firstGeneration &&
          JSON.stringify(room.state) === JSON.stringify({ fresh: true }),
        `reset replaces the room: ${JSON.stringify(room).slice(0, 200)}`,
      );
      response = await ctx.api("POST", "/api/rooms/reset", { body: { namespace, name: "empty" } });
      expectStatus(response, [200], "reset without a state");
      expect(JSON.stringify(roomOf(response).state) === "{}", "reset defaults to an empty state");

      // ── Decode ──────────────────────────────────────────────────────────────────────────────
      response = await ctx.api("POST", "/api/rooms/decode", {
        apiKey: null,
        body: {
          value: {
            format: "swarm-room-v1",
            schemaVersion: room.schemaVersion,
            generation: room.generation,
            snapshot: room.snapshot,
          },
        },
      });
      expectStatus(response, [200], "decode a snapshot (no credentials needed)");
      const decoded = asRecord(response.json);
      expect(
        decoded.schemaVersion === 2 &&
          decoded.generation === room.generation &&
          JSON.stringify(decoded.state) === JSON.stringify({ fresh: true }),
        "decoded snapshot",
      );
      response = await ctx.api("POST", "/api/rooms/decode", {
        body: { value: { format: "other", schemaVersion: 1, generation: "g", snapshot: "" } },
      });
      expectStatus(response, [400], "decode an invalid envelope");
      response = await ctx.api("POST", "/api/rooms/decode", { body: { value: "not an envelope" } });
      expectStatus(response, [400], "decode a non-envelope value");

      // ── Namespace authorization ─────────────────────────────────────────────────────────────
      response = await ctx.api("POST", "/api/rooms/reset", { body: { name: "alpha" } });
      expectStatus(response, [400], "no namespace and no agent identity");
      response = await ctx.api("POST", "/api/rooms/reset", {
        body: { namespace: `apps:${ctx.nonce}`, name: "alpha" },
      });
      expectStatus(response, [403], "a reserved namespace family cannot be written");
      response = await ctx.api("POST", "/api/rooms/change", {
        body: {
          namespace: `worker:${agent}`,
          name: "nudge",
          operations: [{ type: "set", path: ["a"], value: 1 }],
        },
      });
      expectStatus(response, [403], "worker channels are not writable rooms");
      response = await ctx.api("POST", "/api/rooms/reset", {
        body: { namespace: `presence:session:${crypto.randomUUID()}`, name: "alpha" },
      });
      expectStatus(response, [403], "presence rooms only allow join, leave and presence");
      response = await ctx.api("POST", "/api/rooms/reset", {
        body: { namespace: `task:page:${ctx.nonce}`, name: "alpha" },
      });
      expectStatus(response, [403], "a page room needs an authenticated agent");
      response = await ctx.api("POST", "/api/pages", {
        agentId: agent,
        body: {
          slug: `e2e-room-page-${ctx.nonce}`,
          title: "Room page",
          contentType: "text/html",
          authMode: "public",
          body: "<p>room</p>",
        },
      });
      expectStatus(response, [201], "create the page behind a page room");
      const pageId = asString(asRecord(response.json).id, "page id");
      pageIds.push(pageId);
      response = await ctx.api("POST", "/api/rooms/reset", {
        agentId: agent,
        body: { namespace: `task:page:${pageId}`, name: "alpha", state: { ok: true } },
      });
      expectStatus(response, [200], "an agent may write a page room");
      response = await ctx.api("POST", "/api/rooms/reset", {
        agentId: agent,
        body: { namespace: `task:page:${crypto.randomUUID().replaceAll("-", "")}`, name: "alpha" },
      });
      expectStatus(response, [404], "a page room needs an existing page");
      response = await ctx.api("POST", "/api/rooms/reset", {
        body: { namespace: `bad namespace!`, name: "alpha" },
      });
      expectStatus(response, [400], "an invalid namespace");
      response = await ctx.api("POST", "/api/rooms/reset", {
        body: { namespace, name: "x".repeat(65) },
      });
      expectStatus(response, [400], "an invalid room name");
      response = await ctx.api("POST", "/api/rooms/reset", {
        agentId: agent,
        body: { namespace: `task:agent:${crypto.randomUUID()}`, name: "alpha" },
      });
      expectStatus(response, [403], "an agent cannot write another agent's namespace");
      response = await ctx.api("POST", "/api/rooms/reset", {
        body: { namespace, name: "alpha" },
        apiKey: null,
      });
      expectStatus(response, [401], "reset without credentials");

      // Without a namespace, an agent's room lives in its own namespace.
      response = await ctx.api("POST", "/api/rooms/reset", {
        agentId: agent,
        body: { name: "mine", state: { own: true } },
      });
      expectStatus(response, [200], "reset in the caller's default namespace");
      const ownNamespace = asString(roomOf(response).namespace, "default namespace");
      expect(ownNamespace.includes(agent), `default namespace names the agent: ${ownNamespace}`);

      // ── MCP room-* tools ────────────────────────────────────────────────────────────────────
      let outcome = expectToolOk(
        await callTool(session, "room-reset", {
          namespace,
          name: "tool",
          state: { via: "tool", n: 1 },
        }),
        "room-reset",
      );
      expect(
        asRecord(asRecord(outcome.data.room).state).via === "tool" &&
          outcome.data.yourAgentId === agent,
        "room-reset result",
      );
      outcome = expectToolOk(
        await callTool(session, "room-get", { namespace, name: "tool" }),
        "room-get",
      );
      expect(asRecord(asRecord(outcome.data.room).state).n === 1, "room-get state");
      outcome = expectToolOk(
        await callTool(session, "room-change", {
          namespace,
          name: "tool",
          operations: [{ type: "increment", path: ["n"], by: 2 }],
        }),
        "room-change",
      );
      const toolRoom = asRecord(outcome.data.room);
      expect(asRecord(toolRoom.state).n === 3, "room-change state");
      outcome = expectToolOk(
        await callTool(session, "room-decode", {
          value: {
            format: "swarm-room-v1",
            schemaVersion: toolRoom.schemaVersion,
            generation: toolRoom.generation,
            snapshot: toolRoom.snapshot,
          },
        }),
        "room-decode",
      );
      expect(
        asRecord(outcome.data.state).n === 3 && outcome.data.yourAgentId === agent,
        "room-decode",
      );
      outcome = expectToolOk(
        await callTool(session, "room-get", { name: "mine" }),
        "room-get in the agent's default namespace",
      );
      expect(asRecord(outcome.data.room).namespace === ownNamespace, "room-get default namespace");
      expectToolError(
        await callTool(session, "room-get", { namespace, name: "nope" }),
        "room-get of a missing room",
        /does not exist|not found/i,
      );
      expectToolError(
        await callTool(session, "room-change", {
          namespace: `apps:${ctx.nonce}`,
          name: "x",
          operations: [{ type: "set", path: ["a"], value: 1 }],
        }),
        "room-change in a reserved namespace",
        /reserved/i,
      );
      expectToolError(
        await callTool(session, "room-reset", { namespace: `worker:${agent}`, name: "x" }),
        "room-reset of a worker channel",
        /worker|disabled/i,
      );
      expectToolError(
        await callTool(session, "room-change", {
          namespace,
          name: "tool",
          operations: [{ type: "text", path: ["n"], index: 0, insert: "x" }],
        }),
        "room-change with an operation that does not fit the value",
      );
      expectToolError(
        await callTool(session, "room-decode", { value: { format: "nope" } }),
        "room-decode of an invalid snapshot",
      );

      // ── Dashboard ticket ────────────────────────────────────────────────────────────────────
      response = await ctx.api("POST", "/api/realtime/ticket");
      expectStatus(response, [200], "issue a realtime ticket");
      const ticket = asRecord(response.json);
      expect(
        typeof ticket.ticket === "string" &&
          ticket.ticket.length > 10 &&
          typeof ticket.expiresAt === "number" &&
          ticket.expiresAt > Date.now() - 1_000,
        `ticket shape: ${response.text.slice(0, 120)}`,
      );
      response = await ctx.api("POST", "/api/realtime/ticket");
      expect(
        asRecord(response.json).ticket !== ticket.ticket,
        "every ticket is distinct (one-shot)",
      );
      response = await ctx.api("POST", "/api/realtime/ticket", { apiKey: null });
      expectStatus(response, [401], "ticket without credentials");
    } finally {
      for (const id of pageIds) await ctx.api("DELETE", `/api/pages/${id}`);
      await session.close();
    }
  },
};
