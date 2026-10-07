/**
 * Integration `*_DISABLE` flags parse identically via the shared env-flag
 * parser (issue #1939).
 *
 * GITHUB_DISABLE, JIRA_DISABLE, LINEAR_DISABLE, AGENTMAIL_DISABLE and
 * SLACK_DISABLE used to hand-roll `value === "true" || value === "1"`,
 * silently ignoring "TRUE", "True" or " 1 " — while the config validator
 * and `isEnvFlagEnabled` (already used by GITLAB_DISABLE /
 * AZURE_DEVOPS_DISABLE) accept any case. Every read now goes through
 * `isEnvFlagEnabled`, so these tests pin the shared-parser behavior at
 * each integration's entry point.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initAgentMail, isAgentMailEnabled, resetAgentMail } from "../agentmail/app";
import { initGitHub, isGitHubEnabled, resetGitHub } from "../github/app";
import { isJiraEnabled, resetJira } from "../jira/app";
import { isLinearEnabled, resetLinear } from "../linear/app";
import { getSlackConfiguration } from "../slack/config";

const ENV_KEYS = [
  "GITHUB_DISABLE",
  "GITHUB_WEBHOOK_SECRET",
  "JIRA_DISABLE",
  "JIRA_CLIENT_ID",
  "LINEAR_DISABLE",
  "LINEAR_CLIENT_ID",
  "AGENTMAIL_DISABLE",
  "AGENTMAIL_WEBHOOK_SECRET",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

// Spellings the hand-rolled `=== "true" || === "1"` checks used to ignore.
const TRUTHY_SPELLINGS = ["true", "TRUE", "True", "1", " 1 ", " True "];
// Everything that must NOT disable the integration.
const NON_DISABLING = ["false", "FALSE", "0", " 0 ", "", undefined];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  resetGitHub();
  resetAgentMail();
  resetJira();
  resetLinear();
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GitHub GITHUB_DISABLE", () => {
  test("every truthy spelling disables the integration", () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    for (const spelling of TRUTHY_SPELLINGS) {
      process.env.GITHUB_DISABLE = spelling;
      expect(isGitHubEnabled()).toBe(false);
    }
  });

  test("non-disabling values keep the integration enabled", () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    for (const value of NON_DISABLING) {
      if (value === undefined) delete process.env.GITHUB_DISABLE;
      else process.env.GITHUB_DISABLE = value;
      expect(isGitHubEnabled()).toBe(true);
    }
  });

  test("initGitHub honors TRUE even with credentials configured", () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    process.env.GITHUB_DISABLE = "TRUE";
    resetGitHub();
    expect(initGitHub()).toBe(false);
  });
});

describe("Jira JIRA_DISABLE", () => {
  test("every truthy spelling disables the integration", () => {
    process.env.JIRA_CLIENT_ID = "client-id";
    for (const spelling of TRUTHY_SPELLINGS) {
      process.env.JIRA_DISABLE = spelling;
      expect(isJiraEnabled()).toBe(false);
    }
  });

  test("non-disabling values keep the integration enabled", () => {
    process.env.JIRA_CLIENT_ID = "client-id";
    for (const value of NON_DISABLING) {
      if (value === undefined) delete process.env.JIRA_DISABLE;
      else process.env.JIRA_DISABLE = value;
      expect(isJiraEnabled()).toBe(true);
    }
  });
});

describe("Linear LINEAR_DISABLE", () => {
  test("every truthy spelling disables the integration", () => {
    process.env.LINEAR_CLIENT_ID = "client-id";
    for (const spelling of TRUTHY_SPELLINGS) {
      process.env.LINEAR_DISABLE = spelling;
      expect(isLinearEnabled()).toBe(false);
    }
  });

  test("non-disabling values keep the integration enabled", () => {
    process.env.LINEAR_CLIENT_ID = "client-id";
    for (const value of NON_DISABLING) {
      if (value === undefined) delete process.env.LINEAR_DISABLE;
      else process.env.LINEAR_DISABLE = value;
      expect(isLinearEnabled()).toBe(true);
    }
  });
});

describe("AgentMail AGENTMAIL_DISABLE", () => {
  test("every truthy spelling disables the integration", () => {
    process.env.AGENTMAIL_WEBHOOK_SECRET = "secret";
    for (const spelling of TRUTHY_SPELLINGS) {
      process.env.AGENTMAIL_DISABLE = spelling;
      expect(isAgentMailEnabled()).toBe(false);
    }
  });

  test("non-disabling values keep the integration enabled", () => {
    process.env.AGENTMAIL_WEBHOOK_SECRET = "secret";
    for (const value of NON_DISABLING) {
      if (value === undefined) delete process.env.AGENTMAIL_DISABLE;
      else process.env.AGENTMAIL_DISABLE = value;
      expect(isAgentMailEnabled()).toBe(true);
    }
  });

  test("initAgentMail honors TRUE even with credentials configured", () => {
    process.env.AGENTMAIL_WEBHOOK_SECRET = "secret";
    process.env.AGENTMAIL_DISABLE = "TRUE";
    resetAgentMail();
    expect(initAgentMail()).toBe(false);
  });
});

describe("Slack SLACK_DISABLE", () => {
  test("every truthy spelling reports disabled", () => {
    for (const spelling of TRUTHY_SPELLINGS) {
      expect(getSlackConfiguration({ SLACK_DISABLE: spelling }).disabled).toBe(true);
    }
  });

  test("non-disabling values report enabled", () => {
    for (const value of NON_DISABLING) {
      const env = value === undefined ? {} : { SLACK_DISABLE: value };
      expect(getSlackConfiguration(env).disabled).toBe(false);
    }
  });
});
