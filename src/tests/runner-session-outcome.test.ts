import { describe, expect, test } from "bun:test";
import { resolveSessionTelemetryEvent } from "../commands/runner";

describe("resolveSessionTelemetryEvent", () => {
  test("classifies an intentional provider interruption as cancellation", () => {
    expect(
      resolveSessionTelemetryEvent({
        exitCode: 130,
        isError: true,
        errorCategory: "cancelled",
      }),
    ).toBe("cancelled");
  });

  test("keeps provider errors classified as failures", () => {
    expect(
      resolveSessionTelemetryEvent({
        exitCode: 1,
        isError: true,
        errorCategory: "error_during_execution",
      }),
    ).toBe("failure");
  });

  test("omits terminal telemetry for success", () => {
    expect(resolveSessionTelemetryEvent({ exitCode: 0, isError: false })).toBeUndefined();
  });
});
