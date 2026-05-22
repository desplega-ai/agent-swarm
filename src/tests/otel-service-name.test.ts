/**
 * Tests for `resolveServiceName` (`src/otel-impl.ts`) — the per-process OTel
 * `service.name` resolver. The API process must report `agent-swarm-api` and
 * the worker `agent-swarm`, even when a shared `OTEL_SERVICE_NAME` env var is
 * set identically across both (as our compose/deploy env does).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveServiceName } from "../otel-impl";

describe("resolveServiceName", () => {
  let savedServiceName: string | undefined;

  beforeEach(() => {
    savedServiceName = process.env.OTEL_SERVICE_NAME;
  });

  afterEach(() => {
    if (savedServiceName === undefined) {
      delete process.env.OTEL_SERVICE_NAME;
    } else {
      process.env.OTEL_SERVICE_NAME = savedServiceName;
    }
  });

  test("API role gets the `-api` suffix when OTEL_SERVICE_NAME is unset", () => {
    delete process.env.OTEL_SERVICE_NAME;
    expect(resolveServiceName("api")).toBe("agent-swarm-api");
  });

  test("worker role stays `agent-swarm` when OTEL_SERVICE_NAME is unset", () => {
    delete process.env.OTEL_SERVICE_NAME;
    expect(resolveServiceName("worker")).toBe("agent-swarm");
  });

  test("lead role also stays `agent-swarm` (any non-api role)", () => {
    delete process.env.OTEL_SERVICE_NAME;
    expect(resolveServiceName("lead")).toBe("agent-swarm");
  });

  test("a shared OTEL_SERVICE_NAME cannot collapse API and worker onto one name", () => {
    // This is the SigNoz bug: compose sets OTEL_SERVICE_NAME=agent-swarm on
    // both processes. The API role must still be distinguishable.
    process.env.OTEL_SERVICE_NAME = "agent-swarm";
    expect(resolveServiceName("api")).toBe("agent-swarm-api");
    expect(resolveServiceName("worker")).toBe("agent-swarm");
    expect(resolveServiceName("api")).not.toBe(resolveServiceName("worker"));
  });

  test("OTEL_SERVICE_NAME is treated as the base name for both roles", () => {
    process.env.OTEL_SERVICE_NAME = "custom-swarm";
    expect(resolveServiceName("api")).toBe("custom-swarm-api");
    expect(resolveServiceName("worker")).toBe("custom-swarm");
  });
});
