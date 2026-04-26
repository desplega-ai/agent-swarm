import { beforeEach, describe, expect, test } from "bun:test";
import {
  _getInstallationIdForTests,
  _resetTelemetryStateForTests,
  initTelemetry,
} from "../telemetry";

// initTelemetry no-ops when ANONYMIZED_TELEMETRY=false. The CI env or local
// setup may set this, so force-enable for the duration of this file.
process.env.ANONYMIZED_TELEMETRY = "true";

describe("initTelemetry", () => {
  beforeEach(() => {
    _resetTelemetryStateForTests();
  });

  test("without generateIfMissing + missing config → installationId stays null (track no-ops)", async () => {
    const writes: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "worker",
      async () => undefined,
      async (key, value) => {
        writes.push({ key, value });
      },
    );
    expect(_getInstallationIdForTests()).toBeNull();
    expect(writes).toEqual([]);
  });

  test("without generateIfMissing + getConfig throws → installationId stays null", async () => {
    const writes: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "worker",
      async () => {
        throw new Error("network blip");
      },
      async (key, value) => {
        writes.push({ key, value });
      },
    );
    expect(_getInstallationIdForTests()).toBeNull();
    expect(writes).toEqual([]);
  });

  test("with generateIfMissing + missing config → mints install_<hex> and persists", async () => {
    const writes: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "api-server",
      async () => undefined,
      async (key, value) => {
        writes.push({ key, value });
      },
      { generateIfMissing: true },
    );
    const id = _getInstallationIdForTests();
    expect(id).not.toBeNull();
    expect(id).toMatch(/^install_[0-9a-f]{16}$/);
    expect(writes).toEqual([{ key: "telemetry_installation_id", value: id as string }]);
  });

  test("with generateIfMissing + getConfig throws → mints ephemeral_<hex>, no persist", async () => {
    const writes: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "api-server",
      async () => {
        throw new Error("db unavailable");
      },
      async (key, value) => {
        writes.push({ key, value });
      },
      { generateIfMissing: true },
    );
    const id = _getInstallationIdForTests();
    expect(id).not.toBeNull();
    expect(id).toMatch(/^ephemeral_[0-9a-f]{16}$/);
    expect(writes).toEqual([]);
  });

  test("existing config → reuses regardless of generateIfMissing flag", async () => {
    const existing = "install_deadbeefcafebabe";

    // Without flag.
    const writesA: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "worker",
      async () => existing,
      async (key, value) => {
        writesA.push({ key, value });
      },
    );
    expect(_getInstallationIdForTests()).toBe(existing);
    expect(writesA).toEqual([]);

    // With flag.
    _resetTelemetryStateForTests();
    const writesB: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "api-server",
      async () => existing,
      async (key, value) => {
        writesB.push({ key, value });
      },
      { generateIfMissing: true },
    );
    expect(_getInstallationIdForTests()).toBe(existing);
    expect(writesB).toEqual([]);
  });
});
