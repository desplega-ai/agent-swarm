import { describe, expect, test } from "bun:test";
import { loadSeedWorkflows } from "../be/seed/workflows-seeder";
import { SEED_SCRIPTS } from "../be/seed-scripts";
import { findEntryNodes, getNextTargets, validateDefinition } from "../workflows/definition";

// Static checks on the seeded `dreaming` workflow graph. The engine only fails a bad
// reference at run time, so these catch a broken template before it ships.
const BUILTIN_ROOTS = new Set(["trigger", "input", "workflow", "swarm", "run", "item", "index"]);
const LEAD_WRITES = ["apply", "trim-apply", "hb-apply", "memtax-create-apply"];

const workflow = loadSeedWorkflows().find((w) => w.name === "dreaming");
if (!workflow) throw new Error("dreaming template did not load");
const def = workflow.definition;
const ids = new Set(def.nodes.map((n) => n.id));
const byId = new Map(def.nodes.map((n) => [n.id, n]));

describe("seeded dreaming workflow", () => {
  test("passes engine validation with a single entry node", () => {
    expect(validateDefinition(def)).toEqual({ valid: true, errors: [] });
    expect(findEntryNodes(def).map((n) => n.id)).toEqual(["gather"]);
  });

  test("every node is reachable from gather and every edge has a target", () => {
    const seen = new Set(["gather"]);
    const queue = ["gather"];
    const badEdges: string[] = [];
    while (queue.length) {
      const node = byId.get(queue.shift() as string);
      for (const target of node?.next ? getNextTargets(node.next) : []) {
        if (!ids.has(target)) badEdges.push(`${node?.id}->${target}`);
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    expect(badEdges).toEqual([]);
    expect([...ids].filter((id) => !seen.has(id))).toEqual([]);
  });

  test("has no install-specific seed-PR lane and no triggers", () => {
    expect(ids.has("seed-gate")).toBe(false);
    expect(ids.has("seed-pr")).toBe(false);
    expect(JSON.stringify(def)).not.toContain("seed-patch");
    expect(workflow.triggers).toEqual([]);
  });

  test("every {{alias}} and input mapping resolves to a declared input, a node, or a built-in root", () => {
    const undeclared: string[] = [];
    for (const node of def.nodes) {
      const declared = new Set(Object.keys(node.inputs ?? {}));
      for (const m of JSON.stringify(node.config ?? {}).matchAll(/\{\{\s*([A-Za-z_][\w-]*)/g)) {
        const root = m[1] as string;
        if (!declared.has(root) && !BUILTIN_ROOTS.has(root))
          undeclared.push(`${node.id}:{{${root}`);
      }
      for (const [key, value] of Object.entries(node.inputs ?? {})) {
        const root = String(value).split(".")[0] as string;
        if (!ids.has(root) && !BUILTIN_ROOTS.has(root)) undeclared.push(`${node.id}.inputs.${key}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  test("every swarm-script node runs a seeded global script", () => {
    const seeded = new Set(SEED_SCRIPTS.map((s) => s.name));
    const scriptNodes = def.nodes.filter((n) => n.type === "swarm-script");
    expect(scriptNodes.length).toBeGreaterThan(0);
    for (const node of scriptNodes) {
      expect(seeded.has(String(node.config.scriptName)), node.id).toBe(true);
      expect(node.config.scope, node.id).toBe("global");
    }
  });

  test("assignees come from gather, never from hardcoded ids", () => {
    const text = JSON.stringify(def);
    expect(text).not.toMatch(/"agentId":"[0-9a-f]{8}-/);
    for (const node of def.nodes) {
      const agentId = (node.config as { agentId?: unknown }).agentId;
      if (typeof agentId !== "string") continue;
      expect(["{{lead}}", "{{coder}}", "{{writer}}", "{{item.id}}"], node.id).toContain(agentId);
    }
    expect(workflow.input).toMatchObject({
      leadAgentId: "",
      coderAgentId: "",
      writerAgentId: "",
      v3Writes: "off",
    });
  });

  test("Lead-authority writes run as a lead agent-task, then a loader returns the stored result", () => {
    for (const id of LEAD_WRITES) {
      const lead = byId.get(`${id}-lead`);
      const loader = byId.get(id);
      expect(lead?.type, id).toBe("agent-task");
      expect(lead?.config.agentId, id).toBe("{{lead}}");
      expect(lead?.inputs?.lead, id).toBe("gather.result.leadAgentId");
      expect(String(lead?.config.template), id).toContain('"fromRun":true');
      expect(lead?.next, id).toBe(id);
      expect(loader?.type, id).toBe("swarm-script");
      expect((loader?.config.args as Record<string, unknown>).loadResult, id).toBe(true);
      // Nothing else reaches the loader directly, so the write always goes through the lead.
      const into = def.nodes.filter((n) => n.next && getNextTargets(n.next).includes(id));
      expect(
        into.map((n) => n.id),
        id,
      ).toEqual([`${id}-lead`]);
    }
  });

  test("memtax-distill runs on the lead: its bullets become /longterm text the lead writes", () => {
    const distill = byId.get("memtax-distill");
    const body = distill?.config.body as { config?: { agentId?: unknown } } | undefined;
    expect(body?.config?.agentId).toBe("{{lead}}");
    expect(distill?.inputs?.lead).toBe("gather.result.leadAgentId");
  });
});
