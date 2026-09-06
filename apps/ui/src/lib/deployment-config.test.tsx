import { describe, expect, test } from "bun:test";
import { parseUiDeploymentConfig } from "./deployment-config";

describe("parseUiDeploymentConfig", () => {
  test("returns an unlocked default configuration", () => {
    expect(parseUiDeploymentConfig({})).toEqual({
      apiUrl: null,
      apiKey: null,
      userId: null,
      demoMode: false,
    });
  });

  test("normalizes a fixed demo deployment", () => {
    expect(
      parseUiDeploymentConfig({
        VITE_API_URL: " https://demo-api.example.com/ ",
        VITE_API_KEY: " demo-key ",
        VITE_USER_ID: " user-123 ",
        VITE_DEMO_MODE: "true",
      }),
    ).toEqual({
      apiUrl: "https://demo-api.example.com",
      apiKey: "demo-key",
      userId: "user-123",
      demoMode: true,
    });
  });

  test("accepts the numeric demo flag", () => {
    expect(parseUiDeploymentConfig({ VITE_DEMO_MODE: "1" }).demoMode).toBe(true);
  });

  test("rejects an incomplete fixed connection", () => {
    expect(() => parseUiDeploymentConfig({ VITE_API_URL: "https://demo.example.com" })).toThrow(
      "VITE_API_URL and VITE_API_KEY must be set together.",
    );
  });

  test("rejects a fixed user without a fixed connection", () => {
    expect(() => parseUiDeploymentConfig({ VITE_USER_ID: "user-123" })).toThrow(
      "VITE_USER_ID requires VITE_API_URL and VITE_API_KEY.",
    );
  });
});
