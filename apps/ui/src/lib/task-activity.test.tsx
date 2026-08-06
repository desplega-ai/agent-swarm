import { describe, expect, test } from "bun:test";
import { taskIsRunning } from "./task-activity";

describe("taskIsRunning", () => {
  test("classifies superseded tasks as finished", () => {
    expect(taskIsRunning("superseded")).toBe(false);
  });

  test("preserves active and indeterminate states", () => {
    expect(taskIsRunning("in_progress")).toBe(true);
    expect(taskIsRunning("pending")).toBeUndefined();
  });
});
