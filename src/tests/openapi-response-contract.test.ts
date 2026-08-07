import { describe, expect, test } from "bun:test";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { auditRouteResponses } from "../../scripts/check-openapi-response-coverage";
import { route } from "../http/route-def";

// ─── helpers ─────────────────────────────────────────────────────────────────

interface Captured {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

function fakeRes(captured: Captured): ServerResponse {
  return {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(chunk?: unknown) {
      captured.body = typeof chunk === "string" ? chunk : undefined;
      return this;
    },
  } as unknown as ServerResponse;
}

const testRoute = route({
  method: "get",
  path: "/api/__respond-contract-test",
  pattern: ["api", "__respond-contract-test"],
  summary: "respond() contract fixture",
  tags: ["Tests"],
  responses: {
    200: {
      description: "ok",
      schema: z.object({ name: z.string(), count: z.number().int() }),
    },
  },
});

// ─── respond() egress contract ───────────────────────────────────────────────

describe("route handle respond()", () => {
  test("valid payload: exact status, JSON content-type, raw JSON.stringify body", () => {
    const captured: Captured = {};
    const payload = { name: "swarm", count: 3 };
    testRoute.respond(fakeRes(captured), 200, payload);

    expect(captured.status).toBe(200);
    expect(captured.headers).toEqual({ "Content-Type": "application/json" });
    // Wire bytes are the RAW payload, never the schema's parsed output.
    expect(captured.body).toBe(JSON.stringify(payload));
  });

  test("invalid payload throws a schema-violation error under bun test (NODE_ENV=test)", () => {
    const captured: Captured = {};
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the compile-time contract
      testRoute.respond(fakeRes(captured), 200, { name: 42 } as any),
    ).toThrow(/Response schema violation: GET \/api\/__respond-contract-test 200/);
    // Nothing was written — the throw happens before writeHead.
    expect(captured.status).toBeUndefined();
  });

  test("validation is OFF when NODE_ENV is unset (production posture): invalid payload still sends", () => {
    // VALIDATE_RESPONSES is baked at module load, so probe in a subprocess
    // with a production-like env (NODE_ENV deliberately unset on deploys).
    const probe = `
      import { z } from "zod";
      import { route } from "${import.meta.dir}/../http/route-def";
      const r = route({
        method: "get", path: "/probe", pattern: ["probe"], summary: "p", tags: ["t"],
        responses: { 200: { description: "ok", schema: z.object({ n: z.number() }) } },
      });
      let status = 0, body = "";
      r.respond({ writeHead(s) { status = s; return this; }, end(b) { body = b; return this; } }, 200, { n: "not-a-number" });
      console.log(JSON.stringify({ status, body }));
    `;
    const env = { ...process.env };
    delete env.NODE_ENV;
    delete env.VALIDATE_HTTP_RESPONSES;
    const proc = Bun.spawnSync(["bun", "-e", probe], { env });
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString().trim());
    expect(out.status).toBe(200);
    expect(out.body).toBe(JSON.stringify({ n: "not-a-number" }));
  });
});

// ─── coverage-gate audit (per-status regression) ─────────────────────────────

describe("auditRouteResponses", () => {
  test("a NEW undecided 2xx on a partially-covered route is reported per status code", () => {
    // Regression for the route-level-exemption hole (codex review, PR #1141):
    // a backlogged/covered route gaining a fresh untyped 201 must surface it.
    const { undecided } = auditRouteResponses([
      {
        method: "post",
        path: "/api/things",
        responses: {
          200: { description: "ok", schema: z.object({}) },
          201: { description: "created" }, // no decision
        },
      },
    ] as never);
    expect(undecided).toEqual(["POST /api/things 201"]);
  });

  test("bodiless 204/205 and non-2xx codes need no decision; unstructured counts as decided", () => {
    const { undecided } = auditRouteResponses([
      {
        method: "get",
        path: "/api/stream",
        responses: {
          200: { description: "sse", unstructured: "SSE stream" },
          204: { description: "no content" },
          404: { description: "not found" },
        },
      },
    ] as never);
    expect(undecided).toEqual([]);
  });

  test("schema + unstructured on the same response is a contradiction", () => {
    const { contradictory } = auditRouteResponses([
      {
        method: "get",
        path: "/api/confused",
        responses: {
          200: { description: "??", schema: z.object({}), unstructured: "also raw" },
        },
      },
    ] as never);
    expect(contradictory).toEqual(["GET /api/confused 200"]);
  });
});
