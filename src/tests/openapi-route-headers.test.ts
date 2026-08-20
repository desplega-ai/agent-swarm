/**
 * Request headers declared on a route must reach the generated spec as real
 * OpenAPI parameters — documenting them in prose leaves generated clients
 * unable to send them.
 */

import { describe, expect, test } from "bun:test";
import "../http/all-routes";
import { generateOpenApiSpec } from "../http/openapi";

type Parameter = {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string };
};

const spec = JSON.parse(generateOpenApiSpec({ version: "test" })) as {
  paths: Record<string, Record<string, { parameters?: Parameter[] }>>;
};

function headerParams(path: string, method = "post"): Parameter[] {
  return (spec.paths[path]?.[method]?.parameters ?? []).filter((p) => p.in === "header");
}

/** Every operation whose contract includes the runtime identity. */
const RUNTIME_HEADER_OPERATIONS: Array<[string, string]> = [
  ["/ping", "post"],
  ["/close", "post"],
  ["/api/poll", "get"],
  ["/api/agents/{id}/credential-status", "put"],
  ["/api/scripts/run", "post"],
  ["/api/mcp-bridge", "post"],
];

describe("runtime identity header in OpenAPI", () => {
  for (const [path, method] of RUNTIME_HEADER_OPERATIONS) {
    test(`${method.toUpperCase()} ${path} declares X-Runtime-Instance-ID as a header parameter`, () => {
      const header = headerParams(path, method).find((p) => p.name === "X-Runtime-Instance-ID");
      expect(header).toBeDefined();
      expect(header?.in).toBe("header");
      expect(header?.schema?.type).toBe("string");
    });

    test(`${method.toUpperCase()} ${path} marks the header optional — the requirement is mode-dependent`, () => {
      const header = headerParams(path, method).find((p) => p.name === "X-Runtime-Instance-ID");
      expect(header?.required).toBe(false);
    });

    test(`${method.toUpperCase()} ${path} describes what the header identifies`, () => {
      const header = headerParams(path, method).find((p) => p.name === "X-Runtime-Instance-ID");
      expect(header?.description).toContain("runtime instance");
      expect(header?.description).toContain("MULTI_RUNTIME_ENABLED");
    });
  }

  test("routes that declare no headers emit none", () => {
    // Representative routes across the surface, none of which opt in.
    expect(headerParams("/api/agents")).toHaveLength(0);
    expect(headerParams("/api/config", "put")).toHaveLength(0);
    expect(headerParams("/api/tasks")).toHaveLength(0);
  });

  test("header support adds parameters to no other operation", () => {
    const withHeaders: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if ((op.parameters ?? []).some((p) => p.in === "header")) {
          withHeaders.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(withHeaders.sort()).toEqual([
      "GET /api/poll",
      "POST /api/mcp-bridge",
      "POST /api/scripts/run",
      "POST /close",
      "POST /ping",
      "PUT /api/agents/{id}/credential-status",
    ]);
  });
});
