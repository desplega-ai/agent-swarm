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
};

const spec = JSON.parse(generateOpenApiSpec({ version: "test" })) as {
  paths: Record<string, Record<string, { parameters?: Parameter[] }>>;
};

function headerParams(path: string, method = "post"): Parameter[] {
  return (spec.paths[path]?.[method]?.parameters ?? []).filter((p) => p.in === "header");
}

describe("runtime identity header in OpenAPI", () => {
  for (const path of ["/ping", "/close"]) {
    test(`${path} declares X-Runtime-Instance-ID as a header parameter`, () => {
      const header = headerParams(path).find((p) => p.name === "X-Runtime-Instance-ID");
      expect(header).toBeDefined();
      expect(header?.in).toBe("header");
    });

    test(`${path} marks the header optional — the requirement is mode-dependent`, () => {
      const header = headerParams(path).find((p) => p.name === "X-Runtime-Instance-ID");
      expect(header?.required).toBe(false);
    });

    test(`${path} describes what the header identifies`, () => {
      const header = headerParams(path).find((p) => p.name === "X-Runtime-Instance-ID");
      expect(header?.description).toContain("runtime instance");
      expect(header?.description).toContain("MULTI_RUNTIME_ENABLED");
    });
  }

  test("routes that declare no headers emit none", () => {
    // Representative routes across the surface, none of which opt in.
    expect(headerParams("/api/agents")).toHaveLength(0);
    expect(headerParams("/api/config", "put")).toHaveLength(0);
    expect(headerParams("/api/poll", "get")).toHaveLength(0);
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
    expect(withHeaders.sort()).toEqual(["POST /close", "POST /ping"]);
  });
});
