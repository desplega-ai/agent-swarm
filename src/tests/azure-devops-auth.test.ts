import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getAzureDevOpsOrgUrl,
  getAzureDevOpsToken,
  initAzureDevOps,
  isAzureDevOpsEnabled,
  resetAzureDevOps,
  verifyAzureDevOpsWebhook,
} from "../azure-devops/auth";

const ENV_KEYS = [
  "AZURE_DEVOPS_WEBHOOK_SECRET",
  "AZURE_DEVOPS_TOKEN",
  "AZURE_DEVOPS_ORG_URL",
  "AZURE_DEVOPS_DISABLE",
] as const;

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("Azure DevOps auth", () => {
  beforeEach(() => {
    resetAzureDevOps();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    resetAzureDevOps();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  describe("isAzureDevOpsEnabled", () => {
    test("returns false when AZURE_DEVOPS_WEBHOOK_SECRET is not set", () => {
      process.env.AZURE_DEVOPS_TOKEN = "example-pat";
      expect(isAzureDevOpsEnabled()).toBe(false);
    });

    test("returns true when AZURE_DEVOPS_WEBHOOK_SECRET is set", () => {
      process.env.AZURE_DEVOPS_WEBHOOK_SECRET = "example-test-secret";
      expect(isAzureDevOpsEnabled()).toBe(true);
    });

    test("returns false when AZURE_DEVOPS_DISABLE is true", () => {
      process.env.AZURE_DEVOPS_WEBHOOK_SECRET = "example-test-secret";
      process.env.AZURE_DEVOPS_DISABLE = "true";
      expect(isAzureDevOpsEnabled()).toBe(false);
    });
  });

  describe("initAzureDevOps", () => {
    test("loads the token and normalizes the org URL", () => {
      process.env.AZURE_DEVOPS_WEBHOOK_SECRET = "example-test-secret";
      process.env.AZURE_DEVOPS_TOKEN = "example-pat";
      process.env.AZURE_DEVOPS_ORG_URL = "https://dev.azure.com/fabrikam/";
      initAzureDevOps();
      expect(getAzureDevOpsToken()).toBe("example-pat");
      expect(getAzureDevOpsOrgUrl()).toBe("https://dev.azure.com/fabrikam");
    });

    test("stays uninitialized when disabled", () => {
      process.env.AZURE_DEVOPS_WEBHOOK_SECRET = "example-test-secret";
      process.env.AZURE_DEVOPS_TOKEN = "example-pat";
      process.env.AZURE_DEVOPS_DISABLE = "true";
      initAzureDevOps();
      expect(getAzureDevOpsToken()).toBeNull();
    });
  });

  describe("verifyAzureDevOpsWebhook", () => {
    beforeEach(() => {
      process.env.AZURE_DEVOPS_WEBHOOK_SECRET = "example-test-secret";
      initAzureDevOps();
    });

    test("accepts Basic auth whose password matches, with any username", () => {
      expect(verifyAzureDevOpsWebhook(basic("agent-swarm", "example-test-secret"))).toBe(true);
      expect(verifyAzureDevOpsWebhook(basic("", "example-test-secret"))).toBe(true);
    });

    test("accepts a password containing a colon", () => {
      resetAzureDevOps();
      process.env.AZURE_DEVOPS_WEBHOOK_SECRET = "part:one";
      initAzureDevOps();
      expect(verifyAzureDevOpsWebhook(basic("hook", "part:one"))).toBe(true);
    });

    test("rejects a wrong password, a missing header, and non-Basic schemes", () => {
      expect(verifyAzureDevOpsWebhook(basic("agent-swarm", "wrong-secret-value!"))).toBe(false);
      expect(verifyAzureDevOpsWebhook(basic("agent-swarm", "short"))).toBe(false);
      expect(verifyAzureDevOpsWebhook(undefined)).toBe(false);
      expect(verifyAzureDevOpsWebhook("Bearer example-test-secret")).toBe(false);
    });

    test("rejects everything when the integration is not initialized", () => {
      resetAzureDevOps();
      expect(verifyAzureDevOpsWebhook(basic("agent-swarm", "example-test-secret"))).toBe(false);
    });
  });
});
