// A request body that is not valid JSON is a client error. Every route that reads its body
// through the route factory answers 400 with the shared error envelope, and the message
// does not quote the body. The MCP endpoint answers 400 with the JSON-RPC parse error.
// An empty body still parses as `{}`, so the route's own validation answers it.
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./script-helpers";

const TRUNCATED = '{"value":';
const MESSAGE = "Request body is not valid JSON";

export const httpMalformedJson: Scenario = {
  name: "http-malformed-json",
  order: 644.6,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "malformed-json");
    const routes: Array<[string, string]> = [
      ["PUT", `/api/kv/_/e2e-json-${ctx.nonce}/x`],
      ["POST", "/api/db-query"],
      ["POST", "/api/scripts/run"],
      ["POST", "/api/schedules"],
      ["POST", "/api/memory/search"],
      ["POST", "/api/tasks"],
    ];
    for (const [method, path] of routes) {
      for (const rawBody of [TRUNCATED, "not json", `{"a":1}}`]) {
        const res = await ctx.api(method, path, {
          agentId,
          rawBody,
          headers: { "Content-Type": "application/json" },
        });
        expectStatus(res, [400], `${method} ${path} with body ${rawBody}`);
        const error = asRecord(res.json).error;
        expect(
          error === MESSAGE,
          `${method} ${path}: expected the error "${MESSAGE}", got ${res.text.slice(0, 200)}`,
        );
      }
    }

    // An empty body is not a parse error: it reaches the route's validation.
    const empty = await ctx.api("POST", "/api/memory/search", {
      agentId,
      rawBody: "",
      headers: { "Content-Type": "application/json" },
    });
    expectStatus(empty, [400], "memory search with an empty body");
    expect(
      String(asRecord(empty.json).error).startsWith("Validation error"),
      `an empty body must fail validation, got ${empty.text.slice(0, 200)}`,
    );

    const mcp = await ctx.api("POST", "/mcp", {
      agentId,
      rawBody: TRUNCATED,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
    });
    expectStatus(mcp, [400], "MCP POST with a truncated body");
    const rpcError = asRecord(asRecord(mcp.json).error);
    expect(rpcError.code === -32700, `MCP must answer the JSON-RPC parse error: ${mcp.text}`);
  },
};
