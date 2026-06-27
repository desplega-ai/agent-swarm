import { describe, expect, test } from "bun:test";
import type { AgentJson, SessionCostRow } from "../swarm/client.ts";
import type { BootMember, WorkerHandle } from "../swarm/sandbox.ts";
import type { HarnessConfig, Scenario } from "../types.ts";
import {
  buildRosterEntries,
  isHeterogeneousRoster,
  resolveBootMembers,
  resolveMemberConfig,
} from "./index.ts";

/**
 * v7 §9.3/§10.1/§12.3 unit coverage: member-config resolution (frozen rule),
 * roster boot-member assembly (lead appended at index N), heterogeneity
 * detection, and the roster-entry builder (agent match + no-match, per-member
 * cost/token attribution).
 */

const CELL: HarnessConfig = { id: "claude-haiku", provider: "claude", model: "haiku" };
const PI_FLASH: HarnessConfig = {
  id: "pi-deepseek-flash",
  provider: "pi",
  model: "openrouter/deepseek/deepseek-v4-flash",
};
const CLAUDE_SONNET: HarnessConfig = { id: "claude-sonnet", provider: "claude", model: "sonnet" };
const CATALOG = new Map<string, HarnessConfig>([
  [CELL.id, CELL],
  [PI_FLASH.id, PI_FLASH],
  [CLAUDE_SONNET.id, CLAUDE_SONNET],
]);

describe("resolveMemberConfig (v7 §12.3 frozen rule)", () => {
  test("empty spec → the cell config, not overridden", () => {
    const { config, overridden } = resolveMemberConfig({}, CELL, CATALOG);
    expect(config).toEqual(CELL);
    expect(overridden).toBe(false);
  });

  test("configId override → the catalog config, overridden", () => {
    const { config, overridden } = resolveMemberConfig(
      { configId: "pi-deepseek-flash" },
      CELL,
      CATALOG,
    );
    expect(config).toEqual(PI_FLASH);
    expect(overridden).toBe(true);
  });

  test("model override on top of the cell config: provider stays the base's", () => {
    const { config, overridden } = resolveMemberConfig({ model: "sonnet" }, CELL, CATALOG);
    expect(config.provider).toBe("claude");
    expect(config.id).toBe("claude-haiku");
    expect(config.model).toBe("sonnet");
    expect(overridden).toBe(true);
  });

  test("configId + model: model applies on top of the catalog base", () => {
    const { config } = resolveMemberConfig(
      { configId: "pi-deepseek-flash", model: "openrouter/deepseek/deepseek-v4-pro" },
      CELL,
      CATALOG,
    );
    expect(config.provider).toBe("pi");
    expect(config.model).toBe("openrouter/deepseek/deepseek-v4-pro");
  });

  test("unknown configId throws a clear error", () => {
    expect(() => resolveMemberConfig({ configId: "nope" }, CELL, CATALOG)).toThrow(
      'member configId "nope"',
    );
  });
});

describe("resolveBootMembers (v7 §9.3/§12.4)", () => {
  test("numeric workers shape → homogeneous default members", () => {
    const scenario = { workers: 2, tasks: [], outcome: {} } as unknown as Scenario;
    const members = resolveBootMembers(scenario, CELL, CATALOG);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.index)).toEqual([0, 1]);
    expect(members.every((m) => m.role === "worker")).toBe(true);
    expect(members.every((m) => !m.overridden)).toBe(true);
    expect(members.every((m) => m.config.id === "claude-haiku")).toBe(true);
    expect(members.every((m) => Object.keys(m.spec).length === 0)).toBe(true);
  });

  test("undefined workers → one default worker", () => {
    const scenario = { tasks: [], outcome: {} } as unknown as Scenario;
    expect(resolveBootMembers(scenario, CELL, CATALOG)).toHaveLength(1);
  });

  test("spec array + lead: lead is APPENDED at index N with role lead", () => {
    const scenario = {
      workers: [{ name: "a", template: "coder" }, { configId: "pi-deepseek-flash" }],
      lead: { name: "boss", configId: "claude-sonnet" },
      tasks: [],
      outcome: {},
    } as unknown as Scenario;
    const members = resolveBootMembers(scenario, CELL, CATALOG);
    expect(members).toHaveLength(3);
    expect(members.map((m) => [m.index, m.role])).toEqual([
      [0, "worker"],
      [1, "worker"],
      [2, "lead"],
    ]);
    expect(members[0]?.overridden).toBe(false);
    expect(members[1]?.overridden).toBe(true);
    expect(members[1]?.config.provider).toBe("pi");
    expect(members[2]?.config).toEqual(CLAUDE_SONNET);
  });
});

describe("isHeterogeneousRoster (v7 §12.5)", () => {
  const member = (over: Partial<BootMember>): BootMember => ({
    index: 0,
    role: "worker",
    spec: {},
    config: CELL,
    overridden: false,
    ...over,
  });

  test("all-default roster (even with a same-provider lead) is homogeneous", () => {
    expect(isHeterogeneousRoster([member({}), member({ index: 1 })], CELL)).toBe(false);
    expect(isHeterogeneousRoster([member({}), member({ index: 1, role: "lead" })], CELL)).toBe(
      false,
    );
  });

  test("any overridden member makes it heterogeneous", () => {
    expect(
      isHeterogeneousRoster(
        [member({}), member({ index: 1, config: PI_FLASH, overridden: true })],
        CELL,
      ),
    ).toBe(true);
  });

  test("a lead on a different provider makes it heterogeneous", () => {
    expect(
      isHeterogeneousRoster(
        [member({}), member({ index: 1, role: "lead", config: PI_FLASH })],
        CELL,
      ),
    ).toBe(true);
  });
});

describe("buildRosterEntries (v7 §10.1 frozen field sourcing)", () => {
  const handle = (over: {
    index: number;
    agentId: string;
    member?: Partial<BootMember>;
    version?: string | null;
  }): WorkerHandle =>
    ({
      index: over.index,
      member: {
        index: over.index,
        role: "worker",
        spec: {},
        config: CELL,
        overridden: false,
        ...(over.member ?? {}),
      },
      sandbox: { sandboxID: `sbx-${over.index}`, templateID: "agent-swarm-worker-latest" },
      agentId: over.agentId,
      version: over.version === undefined ? "1.94.0" : over.version,
    }) as unknown as WorkerHandle;

  const row = (over: Partial<SessionCostRow>): SessionCostRow => ({
    totalCostUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    model: null,
    costSource: "unpriced",
    ...over,
  });

  const AGENTS: AgentJson[] = [
    {
      id: "agent-0",
      name: "scribe-a",
      isLead: false,
      status: "idle",
      role: "worker",
      capabilities: ["implementation"],
      maxTasks: 3,
      lastActivityAt: "2026-06-12T10:00:00Z",
      provider: "claude",
      harnessProvider: "claude",
    },
  ];

  test("agent match + per-member cost/tokens from that member's task rows", () => {
    const entries = buildRosterEntries({
      workers: [
        handle({ index: 0, agentId: "agent-0", member: { spec: { template: "coder" } } }),
        handle({
          index: 1,
          agentId: "agent-1",
          version: null,
          member: { role: "lead", config: CLAUDE_SONNET, overridden: true },
        }),
      ],
      agents: AGENTS,
      taskMemberIndex: new Map([
        ["t-1", 0],
        ["t-2", 1],
        ["t-3", 0],
      ]),
      costRows: [
        {
          taskId: "t-1",
          rows: [
            row({
              totalCostUsd: 0.01,
              inputTokens: 100,
              outputTokens: 50,
              model: "claude-haiku-4-5",
            }),
          ],
        },
        { taskId: "t-2", rows: [row({})] }, // unpriced, all-null token columns
        { taskId: "t-3", rows: [row({ totalCostUsd: 0.02, inputTokens: 10, outputTokens: 5 })] },
      ],
    });

    expect(entries).toHaveLength(2);
    const [w0, lead] = entries;
    // matched agent row
    expect(w0?.name).toBe("scribe-a");
    expect(w0?.role).toBe("worker");
    expect(w0?.isLead).toBe(false);
    expect(w0?.status).toBe("idle");
    expect(w0?.provider).toBe("claude");
    expect(w0?.capabilities).toEqual(["implementation"]);
    expect(w0?.maxTasks).toBe(3);
    expect(w0?.agentTemplate).toBe("coder");
    // not overridden → null config trio (readers fall back to the cell config)
    expect(w0?.configId).toBeNull();
    expect(w0?.model).toBeNull();
    expect(w0?.taskIds).toEqual(["t-1", "t-3"]);
    expect(w0?.costUsd).toBeCloseTo(0.03);
    expect(w0?.tokens).toEqual({
      model: "claude-haiku-4-5",
      inputTokens: 110,
      outputTokens: 55,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    // no matching agent row → nulls + boot-role fallback
    expect(lead?.memberRole).toBe("lead");
    expect(lead?.name).toBeNull();
    expect(lead?.role).toBeNull();
    expect(lead?.isLead).toBe(true);
    expect(lead?.status).toBeNull();
    expect(lead?.capabilities).toEqual([]);
    expect(lead?.maxTasks).toBeNull();
    // provider falls back to the EFFECTIVE config's provider
    expect(lead?.provider).toBe("claude");
    // overridden → the effective trio is exposed
    expect(lead?.configId).toBe("claude-sonnet");
    expect(lead?.model).toBe("sonnet");
    expect(lead?.version).toBeNull();
    expect(lead?.taskIds).toEqual(["t-2"]);
    // no priced row → null cost; all-null token columns → null tokens
    expect(lead?.costUsd).toBeNull();
    expect(lead?.tokens).toBeNull();
    expect(lead?.sandboxId).toBe("sbx-1");
  });

  test("member with zero tasks → empty taskIds, null cost/tokens (never NaN)", () => {
    const entries = buildRosterEntries({
      workers: [handle({ index: 0, agentId: "agent-0" })],
      agents: [],
      taskMemberIndex: new Map(),
      costRows: [],
    });
    expect(entries[0]?.taskIds).toEqual([]);
    expect(entries[0]?.costUsd).toBeNull();
    expect(entries[0]?.tokens).toBeNull();
    expect(JSON.stringify(entries)).not.toContain("NaN");
  });
});
