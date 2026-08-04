import { validateDefinition } from "../../workflows/definition";
import { computeContentHash, createWorkflow, getWorkflowByName, updateWorkflow } from "../db";
import { ADDONS, type Addon, type AddonWorkflowDef, canonicalJson } from "./addons";
import { getSeedState } from "./state-db";
import type { Seeder, SeedItem } from "./types";

type WorkflowSeedItem = SeedItem & { workflow: AddonWorkflowDef };

function workflowSeedHash(workflow: AddonWorkflowDef): string {
  return computeContentHash(
    canonicalJson({
      name: workflow.name,
      description: workflow.description,
      enabled: workflow.enabled,
      definition: workflow.definition,
    }),
  );
}

/**
 * True when the live workflow row named `name` is the add-on's own seed, untouched by
 * the operator — i.e. it is safe for another seeder to bind to it.
 *
 * A name match alone is NOT proof of ownership: if an operator already owns a workflow
 * called `dream`, the workflow seeder deliberately preserves it, and anything that then
 * resolves "dream" by name would be pointing at user-authored graph. Mirrors the
 * pristine test in {@link ../seed/runner}: recorded seed state wins; with no recorded
 * state the live copy must be byte-identical to the shipped definition.
 */
export function isPristineSeededWorkflow(name: string, addons: readonly Addon[] = ADDONS): boolean {
  const shipped = addons.flatMap((addon) => addon.workflows).find((w) => w.name === name);
  if (!shipped) return false;
  const existing = getWorkflowByName(name);
  if (!existing) return false;
  const liveHash = workflowSeedHash({
    name: existing.name,
    description: existing.description ?? "",
    enabled: existing.enabled,
    definition: existing.definition,
  });
  const state = getSeedState("workflow", name);
  return state ? liveHash === state.seededHash : liveHash === workflowSeedHash(shipped);
}

export function createWorkflowsSeeder(addons: readonly Addon[] = ADDONS): Seeder<WorkflowSeedItem> {
  return {
    kind: "workflow",

    items(): WorkflowSeedItem[] {
      return addons.flatMap((addon) =>
        addon.workflows.map((workflow) => ({
          key: workflow.name,
          contentHash: workflowSeedHash(workflow),
          workflow,
        })),
      );
    },

    upstreamHash(item): string | null {
      const existing = getWorkflowByName(item.key);
      if (!existing) return null;
      return workflowSeedHash({
        name: existing.name,
        description: existing.description ?? "",
        enabled: existing.enabled,
        definition: existing.definition,
      });
    },

    apply(item): void {
      const { workflow } = item;
      const validation = validateDefinition(workflow.definition);
      if (!validation.valid) {
        throw new Error(`Invalid workflow definition: ${validation.errors.join("; ")}`);
      }

      const existing = getWorkflowByName(workflow.name);
      if (!existing) {
        const created = createWorkflow({
          name: workflow.name,
          description: workflow.description,
          definition: workflow.definition,
        });
        // createWorkflow has no `enabled` param (schema defaults to 1), so a
        // disabled-by-default workflow needs this second write.
        if (!workflow.enabled) updateWorkflow(created.id, { enabled: false });
        return;
      }

      updateWorkflow(existing.id, {
        description: workflow.description,
        enabled: workflow.enabled,
        definition: workflow.definition,
      });
    },
  };
}

export const workflowsSeeder = createWorkflowsSeeder();
