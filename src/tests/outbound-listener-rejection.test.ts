import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { initJiraOutboundSync, teardownJiraOutboundSync } from "../jira/outbound";
import { initLinearOutboundSync, teardownLinearOutboundSync } from "../linear/outbound";
import { workflowEventBus } from "../workflows/event-bus";

/**
 * `EventEmitter.emit()` invokes listeners synchronously and discards whatever
 * they return, so wrapping the *emitting* side in `.catch()` never observes an
 * async subscriber's rejection — it reaches the process-level
 * `unhandledRejection` handler instead, with no subsystem context.
 *
 * These tests exercise the subscription boundary rather than EventEmitter
 * itself. A `null` payload makes the handler's first destructuring statement
 * throw, which rejects the returned promise from *outside* any internal
 * `try`/`catch` — the same shape as a database failure in the tracker lookup
 * that both subsystems perform before their first `try`.
 */

/** Let the rejection settle: one microtask drain plus one macrotask turn. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("outbound event-bus listener rejection handling", () => {
  let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    teardownJiraOutboundSync();
    teardownLinearOutboundSync();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    process.off("unhandledRejection", onUnhandled);
  });

  /**
   * Other suites in the same process may leave their own subscribers attached,
   * and they log through the same `console.error`. Assert on the subsystem
   * under test rather than on global log emptiness, so this file does not
   * depend on which tests ran before it.
   */
  const messages = (prefix: string) =>
    errorSpy.mock.calls.map((args) => String(args[0])).filter((m) => m.startsWith(prefix));

  test("a rejecting Jira listener is reported by the subsystem, not left unhandled", async () => {
    initJiraOutboundSync();

    workflowEventBus.emit("task.completed", null);
    await settle();

    expect(messages("[Jira Outbound]")).toContain("[Jira Outbound] task.completed handler failed:");
    expect(unhandled).toEqual([]);
  });

  test("a rejecting Linear listener is reported by the subsystem, not left unhandled", async () => {
    initLinearOutboundSync();

    workflowEventBus.emit("task.completed", null);
    await settle();

    expect(messages("[Linear Outbound]")).toContain(
      "[Linear Outbound] task.completed handler failed:",
    );
    expect(unhandled).toEqual([]);
  });

  test("the reported error carries the reason as scrubbed text, not the raw object", async () => {
    initJiraOutboundSync();

    workflowEventBus.emit("task.failed", null);
    await settle();

    const call = errorSpy.mock.calls.find(
      (args) => String(args[0]) === "[Jira Outbound] task.failed handler failed:",
    );
    expect(call).toBeDefined();
    // Text, not the Error itself: a raw SDK error would serialise attached
    // request/response fields that can hold credentials.
    expect(typeof call?.[1]).toBe("string");
    // The underlying reason survives; only the object wrapper is dropped.
    expect(String(call?.[1])).toMatch(/null/);
  });

  test("every subscribed event is observed, not just one", async () => {
    initJiraOutboundSync();

    for (const event of ["task.created", "task.completed", "task.failed", "task.cancelled"]) {
      workflowEventBus.emit(event, null);
    }
    await settle();

    for (const event of ["task.created", "task.completed", "task.failed", "task.cancelled"]) {
      expect(messages("[Jira Outbound]")).toContain(`[Jira Outbound] ${event} handler failed:`);
    }
    expect(unhandled).toEqual([]);
  });

  test("teardown removes the wrapper that was registered", async () => {
    initJiraOutboundSync();
    initLinearOutboundSync();
    teardownJiraOutboundSync();
    teardownLinearOutboundSync();
    errorSpy.mockClear();

    workflowEventBus.emit("task.completed", null);
    await settle();

    // If `off()` had been passed a different reference than `on()`, the
    // listener would still be attached and would report here.
    expect(messages("[Jira Outbound]")).toEqual([]);
    expect(messages("[Linear Outbound]")).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  test("normally handled events still complete without being reported", async () => {
    initJiraOutboundSync();
    initLinearOutboundSync();

    // No taskId — both subsystems return early, which is the ordinary
    // no-op path for the vast majority of swarm tasks.
    workflowEventBus.emit("task.completed", {});
    await settle();

    expect(messages("[Jira Outbound]")).toEqual([]);
    expect(messages("[Linear Outbound]")).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});
