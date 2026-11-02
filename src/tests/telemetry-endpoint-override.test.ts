import { describe, expect, test } from "bun:test";
import { resolveTelemetryEndpoint } from "../telemetry";

const DEFAULT = "https://proxy.desplega.sh/v1/events";

describe("DESPLEGA_TELEMETRY_ENDPOINT override", () => {
  test("unset or blank keeps the default sink", () => {
    expect(resolveTelemetryEndpoint(undefined)).toBe(DEFAULT);
    expect(resolveTelemetryEndpoint("   ")).toBe(DEFAULT);
  });

  test("https origins and loopback http are accepted", () => {
    expect(resolveTelemetryEndpoint("https://sink.example.com/v1/events")).toBe(
      "https://sink.example.com/v1/events",
    );
    expect(resolveTelemetryEndpoint("http://127.0.0.1:4321/telemetry/v1/events")).toBe(
      "http://127.0.0.1:4321/telemetry/v1/events",
    );
    expect(resolveTelemetryEndpoint("http://localhost:4321/x")).toBe("http://localhost:4321/x");
  });

  test("plain http to a remote host and non-URLs fall back to the default", () => {
    expect(resolveTelemetryEndpoint("http://collector.example.com/v1/events")).toBe(DEFAULT);
    expect(resolveTelemetryEndpoint("ftp://127.0.0.1/x")).toBe(DEFAULT);
    expect(resolveTelemetryEndpoint("not a url")).toBe(DEFAULT);
  });
});
