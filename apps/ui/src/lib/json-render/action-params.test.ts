import { describe, expect, test } from "bun:test";
import { resolveScopedParams, resolveScopedValue } from "./action-params";

describe("$chain sentinel", () => {
  test("resolves a keyed path off scope.chain", () => {
    expect(resolveScopedValue({ $chain: "leafTaskId" }, { chain: { leafTaskId: "task-1" } })).toBe(
      "task-1",
    );
  });

  test("resolves the whole chain object for an empty path", () => {
    const chain = { leafTaskId: "task-1", newTaskId: "task-2" };
    expect(resolveScopedValue({ $chain: "" }, { chain })).toEqual(chain);
  });

  test("keeps the sentinel when scope.chain is not set", () => {
    expect(resolveScopedValue({ $chain: "leafTaskId" }, {})).toEqual({ $chain: "leafTaskId" });
    expect(resolveScopedValue({ $chain: "" }, {})).toEqual({ $chain: "" });
  });

  test("keeps the sentinel for a key missing on scope.chain", () => {
    expect(
      resolveScopedValue({ $chain: "newTaskId" }, { chain: { leafTaskId: "task-1" } }),
    ).toEqual({ $chain: "newTaskId" });
  });

  test("Table dispatch resolves $row but leaves an unbound parentTaskId visible", () => {
    const params = resolveScopedParams(
      { name: "ask", input: { $row: "" }, parentTaskId: { $chain: "leafTaskId" } },
      { row: { id: "r1" }, rowIndex: 0 },
    );
    expect(params).toEqual({
      name: "ask",
      input: { id: "r1" },
      parentTaskId: { $chain: "leafTaskId" },
    });
  });

  test("Form dispatch resolves $form but leaves an unbound parentTaskId visible", () => {
    const params = resolveScopedParams(
      { name: "ask", input: { $form: "" }, parentTaskId: { $chain: "leafTaskId" } },
      { form: { title: "hello" } },
    );
    expect(params).toEqual({
      name: "ask",
      input: { title: "hello" },
      parentTaskId: { $chain: "leafTaskId" },
    });
  });

  test("a dispatch scope that carries chain resolves parentTaskId to the leaf", () => {
    const params = resolveScopedParams(
      { name: "ask", input: { $row: "" }, parentTaskId: { $chain: "leafTaskId" } },
      { row: { id: "r1" }, chain: { leafTaskId: "task-1" } },
    );
    expect(params).toEqual({ name: "ask", input: { id: "r1" }, parentTaskId: "task-1" });
  });

  test("resolves nested inside action params alongside other literals", () => {
    const params = resolveScopedParams(
      { input: { parentTaskId: { $chain: "leafTaskId" } } },
      { chain: { leafTaskId: "task-1" } },
    );
    expect(params).toEqual({ input: { parentTaskId: "task-1" } });
  });
});
