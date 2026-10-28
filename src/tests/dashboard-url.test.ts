import { describe, expect, test } from "bun:test";
import {
  buildOnboardDashboardUrl,
  maskDashboardUrlApiKey,
} from "../commands/onboard/dashboard-url.ts";

describe("buildOnboardDashboardUrl", () => {
  test("emits camelCase apiUrl / apiKey params", () => {
    const url = buildOnboardDashboardUrl({
      apiUrl: "http://localhost:3013",
      apiKey: "0123456789abcdef0123456789abcdef",
    });
    expect(url).toBe(
      "https://app.agent-swarm.dev?apiUrl=http%3A%2F%2Flocalhost%3A3013&apiKey=0123456789abcdef0123456789abcdef",
    );
  });
});

describe("maskDashboardUrlApiKey", () => {
  test("replaces the key value with <redacted> and keeps other params", () => {
    const url = buildOnboardDashboardUrl({
      apiUrl: "http://localhost:3013",
      apiKey: "0123456789abcdef0123456789abcdef",
    });
    const masked = maskDashboardUrlApiKey(url);
    expect(masked).toBe(
      "https://app.agent-swarm.dev?apiUrl=http%3A%2F%2Flocalhost%3A3013&apiKey=<redacted>",
    );
    expect(masked).not.toContain("0123456789abcdef0123456789abcdef");
  });

  test("masks apiKey when it is the first param", () => {
    expect(maskDashboardUrlApiKey("https://app.agent-swarm.dev?apiKey=deadbeef&name=x")).toBe(
      "https://app.agent-swarm.dev?apiKey=<redacted>&name=x",
    );
  });

  test("leaves a URL without an apiKey param unchanged", () => {
    const url = "https://app.agent-swarm.dev?apiUrl=http%3A%2F%2Flocalhost%3A3013";
    expect(maskDashboardUrlApiKey(url)).toBe(url);
  });
});
