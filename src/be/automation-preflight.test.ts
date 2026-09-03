import { describe, expect, test } from "bun:test";
import type { AutomationIntegrationId } from "../types";
import {
  type AutomationSetupStates,
  preflightAutomation,
  renderAutomationTokens,
} from "./automation-preflight";

const setup: AutomationSetupStates = {
  slack: "unverified",
  github: "unverified",
  linear: "verified",
  jira: "verified",
  gsc: "verified",
  agentmail: "verified",
  agentfs: "verified",
};

describe("preflightAutomation", () => {
  test("returns sorted missing setup and focuses the first missing parameter", () => {
    const result = preflightAutomation(
      {
        id: "schedule-1",
        name: "Weekly Dependency Triage",
        kind: "schedule",
        params: { TIMEZONE: " ", REPO_URL: "" },
        requiredParams: ["TIMEZONE", "SLACK_CHANNEL_ID", "REPO_URL"],
        requires: ["slack", "github"],
      },
      setup,
    );

    expect(result).toEqual({
      id: "schedule-1",
      name: "Weekly Dependency Triage",
      kind: "schedule",
      state: "needs_setup",
      missing: {
        params: ["REPO_URL", "SLACK_CHANNEL_ID", "TIMEZONE"],
        integrations: ["github", "slack"],
      },
      fixUrl: "/schedules/schedule-1?param=REPO_URL",
      failureReason:
        "needs_setup: params=[REPO_URL,SLACK_CHANNEL_ID,TIMEZONE] integrations=[github,slack]",
    });
  });

  test("uses the integration deep link when parameters are complete", () => {
    const result = preflightAutomation(
      {
        id: "workflow-1",
        name: "Autopilot",
        kind: "workflow",
        params: { REPO_URL: "owner/repo" },
        requiredParams: ["REPO_URL"],
        requires: ["github"],
      },
      setup,
    );

    expect(result.state).toBe("needs_setup");
    expect(result.fixUrl).toBe("/settings/integrations/github");
    expect(result.failureReason).toBe("needs_setup: params=[] integrations=[github]");
  });

  test("uses requirements-derived integration-first precedence for the v4 matrix rows", () => {
    const unverifiedSetup: AutomationSetupStates = {
      slack: "unverified",
      github: "unverified",
      linear: "unverified",
      jira: "unverified",
      gsc: "unverified",
      agentmail: "unverified",
      agentfs: "unverified",
    };
    const cases: Array<{
      name: string;
      requires: AutomationIntegrationId[];
      param: string;
      fixUrl: string;
    }> = [
      {
        name: "gsc-topic-miner",
        requires: ["gsc", "agentfs"],
        param: "GSC_PROPERTY",
        fixUrl: "/settings/secrets",
      },
      {
        name: "linear-drain-loop",
        requires: ["linear"],
        param: "LINEAR_PROJECT_ID",
        fixUrl: "/settings/integrations/linear",
      },
      {
        name: "daily-hn-briefing",
        requires: ["agentmail"],
        param: "REPORT_EMAIL",
        fixUrl: "/settings/integrations/agentmail",
      },
      {
        name: "gtm-weekly-review",
        requires: ["github", "gsc"],
        param: "REPO_URL",
        fixUrl: "/settings/integrations/github",
      },
    ];

    for (const testCase of cases) {
      const result = preflightAutomation(
        {
          id: testCase.name,
          name: testCase.name,
          kind:
            testCase.name.includes("weekly") || testCase.name.includes("briefing")
              ? "schedule"
              : "workflow",
          requiredParams: [testCase.param],
          requires: testCase.requires,
        },
        unverifiedSetup,
      );
      expect(result.missing.params).toEqual([testCase.param]);
      expect(result.fixUrl).toBe(testCase.fixUrl);
    }
  });

  test("keeps parameter-first precedence for delivery-bound alerts", () => {
    const result = preflightAutomation(
      {
        id: "alerts-triage",
        name: "alerts-triage",
        kind: "workflow",
        requiredParams: ["ALERTS_CHANNEL_ID"],
        requires: ["slack"],
      },
      setup,
    );

    expect(result.failureReason).toBe(
      "needs_setup: params=[ALERTS_CHANNEL_ID] integrations=[slack]",
    );
    expect(result.fixUrl).toBe("/workflows/alerts-triage?param=ALERTS_CHANNEL_ID");
  });

  test("points every missing integration at an existing actionable settings route", () => {
    const cases: Array<[AutomationIntegrationId, string]> = [
      ["slack", "/settings/integrations/slack"],
      ["github", "/settings/integrations/github"],
      ["linear", "/settings/integrations/linear"],
      ["jira", "/settings/integrations/jira"],
      ["agentmail", "/settings/integrations/agentmail"],
      ["gsc", "/settings/secrets"],
      ["agentfs", "/settings/secrets"],
    ];
    const unverifiedSetup: AutomationSetupStates = {
      slack: "unverified",
      github: "unverified",
      linear: "unverified",
      jira: "unverified",
      agentmail: "unverified",
      gsc: "unverified",
      agentfs: "unverified",
    };

    for (const [id, fixUrl] of cases) {
      expect(
        preflightAutomation(
          { id: `workflow-${id}`, name: id, kind: "workflow", requires: [id] },
          unverifiedSetup,
        ).fixUrl,
      ).toBe(fixUrl);
    }
  });

  test("returns running with the automation detail URL when setup is complete", () => {
    const result = preflightAutomation(
      {
        id: "workflow-2",
        name: "Linear Drain",
        kind: "workflow",
        params: { LINEAR_PROJECT_ID: "project-1" },
        requiredParams: ["LINEAR_PROJECT_ID"],
        requires: ["linear"],
      },
      setup,
    );

    expect(result).toMatchObject({
      state: "running",
      missing: { params: [], integrations: [] },
      fixUrl: "/workflows/workflow-2",
    });
    expect(result.failureReason).toBeUndefined();
  });
});

describe("renderAutomationTokens", () => {
  test("renders declared params while preserving workflow runtime tokens and value types", () => {
    const rendered = renderAutomationTokens(
      {
        task: "Inspect {{REPO_URL}} for {{trigger.ref}}",
        competitors: "{{COMPETITORS}}",
        untouched: "{{UNKNOWN}}",
      } as Record<string, unknown>,
      {
        REPO_URL: "acme/widgets",
        COMPETITORS: ["one", "two"],
      },
    );

    expect(rendered).toEqual({
      task: "Inspect acme/widgets for {{trigger.ref}}",
      competitors: ["one", "two"],
      untouched: "{{UNKNOWN}}",
    });
  });
});
