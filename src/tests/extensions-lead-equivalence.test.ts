import { describe, expect, test } from "bun:test";
import { can } from "@/rbac/can";
import {
  grantLeadEquivalence,
  hasLeadEquivalence,
  revokeLeadEquivalence,
} from "@/rbac/elevated-agents";

const extensionAgentId = "11111111-2222-4333-8444-555555555555";

describe("extension agents act with lead privileges while registered", () => {
  test("lead-only verbs follow the registry", () => {
    const check = {
      principal: { kind: "agent" as const, agentId: extensionAgentId, isLead: false },
      verb: "integration.slack.post" as const,
      resource: { kind: "none" as const },
      source: "mcp" as const,
    };
    expect(hasLeadEquivalence(extensionAgentId)).toBe(false);
    expect(can(check).allow).toBe(false);

    grantLeadEquivalence(extensionAgentId);
    expect(hasLeadEquivalence(extensionAgentId)).toBe(true);
    expect(can(check).allow).toBe(true);
    expect(can({ ...check, verb: "extension.write", resource: { kind: "none" } }).allow).toBe(true);

    revokeLeadEquivalence(extensionAgentId);
    expect(can(check).allow).toBe(false);
  });

  test("operators and plain workers are unaffected", () => {
    expect(
      can({
        principal: { kind: "agent", agentId: "worker-1", isLead: false },
        verb: "integration.slack.post",
        resource: { kind: "none" },
        source: "mcp",
      }).allow,
    ).toBe(false);
    expect(
      can({
        principal: { kind: "operator" },
        verb: "extension.activate",
        resource: { kind: "none" },
        source: "http",
      }).allow,
    ).toBe(true);
  });
});
