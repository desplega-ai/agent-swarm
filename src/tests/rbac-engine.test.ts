/**
 * RBAC engine unit tests (DES-445, Phase 3).
 *
 * Table-driven: every permission verb × 7 principal archetypes {lead agent,
 * worker agent, owner-worker, task-creator-worker, user-requester, foreign
 * user, operator} → expected decision, mirroring the legacy rules from
 * research §3 / plan Appendix A. Nothing calls `can()` in production yet —
 * this suite defines the engine's contract for the Phase-4/5 migration.
 *
 * Pure engine tests — no DB, no MCP server, no HTTP.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { can, clearAuditSink, setAuditSink } from "../rbac";
import { LEGACY_POLICY } from "../rbac/legacy-policy";
import type { PermissionVerb } from "../rbac/permissions";
import { PERMISSION_VERBS } from "../rbac/permissions";
import type { RbacCheck, RbacDecision, RbacPrincipal, RbacResource } from "../rbac/types";

// ── Principal archetypes ─────────────────────────────────────────────────────

const LEAD_ID = "lead-agent-id";
const WORKER_ID = "plain-worker-id";
const OWNER_WORKER_ID = "owner-worker-id"; // resource owner / kv-namespace owner / task assignee
const CREATOR_WORKER_ID = "creator-worker-id"; // task creator
const REQUESTER_USER_ID = "requester-user-id"; // task.requestedByUserId
const FOREIGN_USER_ID = "foreign-user-id";

const PRINCIPALS = {
  lead: { kind: "agent", agentId: LEAD_ID, isLead: true },
  worker: { kind: "agent", agentId: WORKER_ID, isLead: false },
  ownerWorker: { kind: "agent", agentId: OWNER_WORKER_ID, isLead: false },
  creatorWorker: { kind: "agent", agentId: CREATOR_WORKER_ID, isLead: false },
  userRequester: { kind: "user", userId: REQUESTER_USER_ID },
  foreignUser: { kind: "user", userId: FOREIGN_USER_ID },
  operator: { kind: "operator" },
} as const satisfies Record<string, RbacPrincipal>;

type PrincipalName = keyof typeof PRINCIPALS;
type Expected = Record<PrincipalName, boolean>;

// ── Verb groups (must partition PERMISSION_VERBS exactly) ────────────────────

const LEAD_ONLY_VERBS: PermissionVerb[] = [
  "user.manage",
  "tool.publish",
  "agent.profile.update.any",
  "agent.context.read.any",
  "memory.learning.inject",
  "channel.delete",
  "integration.kapso.manage",
  "integration.slack.post",
  "integration.slack.read",
  "integration.slack.thread.start",
  "integration.slack.upload",
  "integration.slack.delete",
  "integration.slack.update",
  "credential-binding.manage",
  "script-connection.manage",
  "config.credential-bindings.write",
  "config.write.any",
  "config.delete.any",
  "config.read.secrets",
  "skill.create.swarm",
  "skill.install.any",
  "skill.install.global",
  "skill.uninstall.any",
  "skill.promote.swarm",
  "mcp-server.create.swarm",
  "mcp-server.install.any",
  "mcp-server.uninstall.any",
  "mcp-server.read.secrets",
  "script.global.write",
  "script.global.delete",
  "script.api.read.secrets",
  "script.api.create",
  "script.api.update",
  "script.api.rotate",
  "script.api.delete",
];

const LEAD_OR_RESOURCE_OWNER_VERBS: PermissionVerb[] = [
  "skill.update.any",
  "skill.delete.any",
  "mcp-server.delete.any",
  "mcp-server.update.any",
  "page.delete.any",
  "subscription.mutate.any",
];

const LEAD_OR_TASK_CREATOR_VERBS: PermissionVerb[] = ["task.cancel.any"];

const LEAD_OR_OWN_NAMESPACE_VERBS: PermissionVerb[] = ["kv.write.any"];

const ANY_AUTHENTICATED_VERBS: PermissionVerb[] = [
  "script-connection.invoke",
  "mcp-oauth.authorize.any",
  "task.create.own",
  "favorite.write.own",
  "script.search",
  "subscription.write",
];

const REQUESTER_OWNS_TASK_VERBS: PermissionVerb[] = [
  "task.read.own",
  "task.cancel.own",
  "task.action.own",
];

const COMPOSITE_VERBS: PermissionVerb[] = ["memory.delete.any", "task.fs.mutate"];

// ── Resource fixtures ────────────────────────────────────────────────────────

const TASK_RESOURCE: RbacResource = {
  kind: "task",
  taskId: "task-1",
  requestedByUserId: REQUESTER_USER_ID,
  creatorAgentId: CREATOR_WORKER_ID,
  agentId: OWNER_WORKER_ID, // assignee
};

const OWNED_RESOURCE: RbacResource = { kind: "owned", ownerAgentId: OWNER_WORKER_ID };

const SWARM_MEMORY_RESOURCE: RbacResource = {
  kind: "owned",
  ownerAgentId: OWNER_WORKER_ID,
  scope: "swarm",
};

const AGENT_MEMORY_RESOURCE: RbacResource = {
  kind: "owned",
  ownerAgentId: OWNER_WORKER_ID,
  scope: "agent",
};

const OWN_NAMESPACE_RESOURCE: RbacResource = {
  kind: "kv-namespace",
  namespace: `task:agent:${OWNER_WORKER_ID}`,
};

// ── Shared assertion helper ──────────────────────────────────────────────────

function expectDecisions(
  verb: PermissionVerb,
  resource: RbacResource | undefined,
  expected: Expected,
) {
  for (const [name, principal] of Object.entries(PRINCIPALS) as [PrincipalName, RbacPrincipal][]) {
    const decision = can({ principal, verb, resource, source: "mcp" });
    expect(decision.allow, `${verb} × ${name}`).toBe(expected[name]);
    if (!decision.allow) {
      expect(decision.missing, `${verb} × ${name} missing`).toBe(verb);
      expect(decision.reason.length, `${verb} × ${name} reason`).toBeGreaterThan(0);
    }
  }
}

// ── Group completeness ───────────────────────────────────────────────────────

describe("verb-group partition", () => {
  test("test groups cover every registered verb exactly once", () => {
    const grouped = [
      ...LEAD_ONLY_VERBS,
      ...LEAD_OR_RESOURCE_OWNER_VERBS,
      ...LEAD_OR_TASK_CREATOR_VERBS,
      ...LEAD_OR_OWN_NAMESPACE_VERBS,
      ...ANY_AUTHENTICATED_VERBS,
      ...REQUESTER_OWNS_TASK_VERBS,
      ...COMPOSITE_VERBS,
    ];
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(grouped.sort()).toEqual([...PERMISSION_VERBS].sort());
  });

  test("every verb has a legacy-policy rule", () => {
    for (const verb of PERMISSION_VERBS) {
      const rule = LEGACY_POLICY[verb];
      expect(rule, verb).toBeDefined();
      expect(rule.name.length).toBeGreaterThan(0);
      expect(rule.denyReason.length).toBeGreaterThan(0);
    }
  });
});

// ── Rule tables ──────────────────────────────────────────────────────────────

describe("lead-only verbs", () => {
  const expected: Expected = {
    lead: true,
    worker: false,
    ownerWorker: false,
    creatorWorker: false,
    userRequester: false,
    foreignUser: false,
    operator: false,
  };
  for (const verb of LEAD_ONLY_VERBS) {
    test(`${verb}: only lead allowed`, () => {
      expectDecisions(verb, { kind: "none" }, expected);
    });
  }

  test("deny reason names the failed rule", () => {
    const decision = can({
      principal: PRINCIPALS.worker,
      verb: "user.manage",
      resource: { kind: "none" },
      source: "mcp",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("requires lead agent");
  });
});

describe("lead-or-resource-owner verbs", () => {
  const expected: Expected = {
    lead: true,
    worker: false,
    ownerWorker: true,
    creatorWorker: false,
    userRequester: false,
    foreignUser: false,
    operator: false,
  };
  for (const verb of LEAD_OR_RESOURCE_OWNER_VERBS) {
    test(`${verb}: lead or owner allowed`, () => {
      expectDecisions(verb, OWNED_RESOURCE, expected);
    });
  }

  test("ownerless resource denies non-lead agents", () => {
    const decision = can({
      principal: PRINCIPALS.ownerWorker,
      verb: "skill.update.any",
      resource: { kind: "owned", ownerAgentId: null },
      source: "mcp",
    });
    expect(decision.allow).toBe(false);
  });
});

describe("lead-or-task-creator verbs (task.cancel.any)", () => {
  const expected: Expected = {
    lead: true,
    worker: false,
    ownerWorker: false, // assignee is NOT allowed to cancel (cancel-task.ts:74)
    creatorWorker: true,
    userRequester: false,
    foreignUser: false,
    operator: false,
  };
  for (const verb of LEAD_OR_TASK_CREATOR_VERBS) {
    test(`${verb}: lead or creator allowed`, () => {
      expectDecisions(verb, TASK_RESOURCE, expected);
    });
  }
});

describe("lead-or-own-namespace verbs (kv.write.any)", () => {
  const expected: Expected = {
    lead: true,
    worker: false,
    ownerWorker: true, // namespace = task:agent:<ownerWorker>
    creatorWorker: false,
    userRequester: false,
    foreignUser: false,
    operator: false,
  };
  for (const verb of LEAD_OR_OWN_NAMESPACE_VERBS) {
    test(`${verb}: lead or namespace owner allowed`, () => {
      expectDecisions(verb, OWN_NAMESPACE_RESOURCE, expected);
    });
  }

  test("worker writing its OWN namespace is allowed", () => {
    const decision = can({
      principal: PRINCIPALS.worker,
      verb: "kv.write.any",
      resource: { kind: "kv-namespace", namespace: `task:agent:${WORKER_ID}` },
      source: "mcp",
    });
    expect(decision.allow).toBe(true);
  });

  test("blank agent id never owns the literal `task:agent:` namespace", () => {
    // Pre-migration guards used truthiness (`if (info.agentId && ...)`), so an
    // empty X-Agent-ID writing to namespace "task:agent:" was denied — the
    // template `task:agent:${""}` must not be treated as a match.
    const decision = can({
      principal: { kind: "agent", agentId: "", isLead: false },
      verb: "kv.write.any",
      resource: { kind: "kv-namespace", namespace: "task:agent:" },
      source: "http",
    });
    expect(decision.allow).toBe(false);
  });
});

describe("any-authenticated verbs", () => {
  const expected: Expected = {
    lead: true,
    worker: true,
    ownerWorker: true,
    creatorWorker: true,
    userRequester: true,
    foreignUser: true,
    operator: true,
  };
  for (const verb of ANY_AUTHENTICATED_VERBS) {
    test(`${verb}: every authenticated principal is allowed`, () => {
      expectDecisions(verb, { kind: "none" }, expected);
    });
  }
});

describe("requester-owns-task verbs", () => {
  // Mirrors assertOwnsTask: owner contexts (agents, operator) always pass;
  // only a user principal that is not the requester is denied.
  const expected: Expected = {
    lead: true,
    worker: true,
    ownerWorker: true,
    creatorWorker: true,
    userRequester: true,
    foreignUser: false,
    operator: true,
  };
  for (const verb of REQUESTER_OWNS_TASK_VERBS) {
    test(`${verb}: everyone but a foreign user allowed`, () => {
      expectDecisions(verb, TASK_RESOURCE, expected);
    });
  }

  test("deny reason names the failed rule", () => {
    const decision = can({
      principal: PRINCIPALS.foreignUser,
      verb: "task.read.own",
      resource: TASK_RESOURCE,
      source: "mcp",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("not the task requester");
  });
});

describe("any-authenticated verbs", () => {
  const expected: Expected = {
    lead: true,
    worker: true,
    ownerWorker: true,
    creatorWorker: true,
    userRequester: true,
    foreignUser: true,
    operator: true,
  };
  for (const verb of ANY_AUTHENTICATED_VERBS) {
    test(`${verb}: any authenticated principal allowed`, () => {
      expectDecisions(verb, { kind: "none" }, expected);
    });
  }
});

describe("memory.delete.any composite (owner OR (lead AND scope=swarm))", () => {
  test("swarm-scoped memory: owner or lead allowed", () => {
    expectDecisions("memory.delete.any", SWARM_MEMORY_RESOURCE, {
      lead: true,
      worker: false,
      ownerWorker: true,
      creatorWorker: false,
      userRequester: false,
      foreignUser: false,
      operator: false,
    });
  });

  test("agent-scoped memory: only owner allowed — lead is denied (deny edge)", () => {
    expectDecisions("memory.delete.any", AGENT_MEMORY_RESOURCE, {
      lead: false,
      worker: false,
      ownerWorker: true,
      creatorWorker: false,
      userRequester: false,
      foreignUser: false,
      operator: false,
    });
  });
});

describe("task.fs.mutate composite (operator OR user OR lead OR assignee OR creator)", () => {
  test("only an unrelated worker agent is denied", () => {
    expectDecisions("task.fs.mutate", TASK_RESOURCE, {
      lead: true,
      worker: false,
      ownerWorker: true, // assignee (task.agentId)
      creatorWorker: true,
      userRequester: true,
      foreignUser: true, // any authenticated user passes (fs.ts canMutateTask)
      operator: true,
    });
  });
});

// ── Audit sink seam ──────────────────────────────────────────────────────────

describe("audit sink", () => {
  afterEach(() => {
    clearAuditSink();
  });

  test("sink receives (check, decision) on allow AND deny", () => {
    const calls: Array<{ check: RbacCheck; decision: RbacDecision }> = [];
    setAuditSink((check, decision) => {
      calls.push({ check, decision });
    });

    const allowCheck: RbacCheck = {
      principal: PRINCIPALS.lead,
      verb: "user.manage",
      resource: { kind: "none" },
      source: "mcp",
    };
    const denyCheck: RbacCheck = {
      principal: PRINCIPALS.worker,
      verb: "user.manage",
      resource: { kind: "none" },
      source: "http",
    };

    expect(can(allowCheck).allow).toBe(true);
    expect(can(denyCheck).allow).toBe(false);

    expect(calls.length).toBe(2);
    expect(calls[0]?.check).toBe(allowCheck);
    expect(calls[0]?.decision.allow).toBe(true);
    expect(calls[1]?.check).toBe(denyCheck);
    expect(calls[1]?.decision.allow).toBe(false);
    if (calls[1] && !calls[1].decision.allow) {
      expect(calls[1].decision.missing).toBe("user.manage");
    }
  });

  test("a throwing sink never breaks can()", () => {
    setAuditSink(() => {
      throw new Error("sink exploded");
    });
    const decision = can({
      principal: PRINCIPALS.lead,
      verb: "user.manage",
      resource: { kind: "none" },
      source: "mcp",
    });
    expect(decision.allow).toBe(true);
  });

  test("unset sink is a no-op; clearAuditSink stops delivery", () => {
    // Unset from the start — decisions still work.
    expect(
      can({
        principal: PRINCIPALS.worker,
        verb: "channel.delete",
        resource: { kind: "none" },
        source: "mcp",
      }).allow,
    ).toBe(false);

    let count = 0;
    setAuditSink(() => {
      count += 1;
    });
    can({
      principal: PRINCIPALS.lead,
      verb: "channel.delete",
      resource: { kind: "none" },
      source: "mcp",
    });
    expect(count).toBe(1);

    clearAuditSink();
    can({
      principal: PRINCIPALS.lead,
      verb: "channel.delete",
      resource: { kind: "none" },
      source: "mcp",
    });
    expect(count).toBe(1); // no further deliveries
  });
});
