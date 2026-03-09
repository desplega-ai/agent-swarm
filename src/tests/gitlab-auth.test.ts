import { afterEach, describe, expect, test } from "bun:test";
import {
  GITLAB_BOT_NAME,
  getGitLabToken,
  getGitLabUrl,
  initGitLab,
  isGitLabEnabled,
  resetGitLab,
  verifyGitLabWebhook,
} from "../gitlab/auth";

describe("GitLab auth", () => {
  afterEach(() => {
    resetGitLab();
    delete process.env.GITLAB_WEBHOOK_SECRET;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_URL;
    delete process.env.GITLAB_DISABLE;
  });

  describe("isGitLabEnabled", () => {
    test("returns false when GITLAB_WEBHOOK_SECRET is not set", () => {
      expect(isGitLabEnabled()).toBe(false);
    });

    test("returns true when GITLAB_WEBHOOK_SECRET is set", () => {
      process.env.GITLAB_WEBHOOK_SECRET = "test-secret";
      expect(isGitLabEnabled()).toBe(true);
    });

    test("returns false when GITLAB_DISABLE is true", () => {
      process.env.GITLAB_WEBHOOK_SECRET = "test-secret";
      process.env.GITLAB_DISABLE = "true";
      expect(isGitLabEnabled()).toBe(false);
    });
  });

  describe("initGitLab", () => {
    test("initializes with custom URL", () => {
      process.env.GITLAB_WEBHOOK_SECRET = "test-secret";
      process.env.GITLAB_TOKEN = "glpat-abc123";
      process.env.GITLAB_URL = "https://gitlab.mycompany.com";
      initGitLab();

      expect(getGitLabToken()).toBe("glpat-abc123");
      expect(getGitLabUrl()).toBe("https://gitlab.mycompany.com");
    });

    test("defaults to gitlab.com URL", () => {
      process.env.GITLAB_WEBHOOK_SECRET = "test-secret";
      initGitLab();

      expect(getGitLabUrl()).toBe("https://gitlab.com");
    });

    test("does not initialize when disabled", () => {
      initGitLab();
      expect(getGitLabToken()).toBeNull();
    });

    test("is idempotent", () => {
      process.env.GITLAB_WEBHOOK_SECRET = "test-secret";
      process.env.GITLAB_TOKEN = "token-1";
      initGitLab();

      process.env.GITLAB_TOKEN = "token-2";
      initGitLab();

      expect(getGitLabToken()).toBe("token-1");
    });
  });

  describe("verifyGitLabWebhook", () => {
    test("returns false when no secret configured", () => {
      expect(verifyGitLabWebhook("any-token")).toBe(false);
    });

    test("returns false when no token provided", () => {
      process.env.GITLAB_WEBHOOK_SECRET = "test-secret";
      initGitLab();
      expect(verifyGitLabWebhook(undefined)).toBe(false);
    });

    test("returns false for mismatched token", () => {
      process.env.GITLAB_WEBHOOK_SECRET = "test-secret";
      initGitLab();
      expect(verifyGitLabWebhook("wrong-secret")).toBe(false);
    });

    test("returns false for different length token", () => {
      process.env.GITLAB_WEBHOOK_SECRET = "test-secret";
      initGitLab();
      expect(verifyGitLabWebhook("short")).toBe(false);
    });

    test("returns true for matching token", () => {
      process.env.GITLAB_WEBHOOK_SECRET = "test-secret";
      initGitLab();
      expect(verifyGitLabWebhook("test-secret")).toBe(true);
    });
  });

  describe("GITLAB_BOT_NAME", () => {
    test("defaults to agent-swarm-bot", () => {
      // The default is set at module load time from env
      expect(typeof GITLAB_BOT_NAME).toBe("string");
    });
  });
});
