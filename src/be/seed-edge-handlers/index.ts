import type { EdgeHandler, EdgeHandlerMatcher } from "../../types";
import { computeContentHash } from "../db";
import { createEdgeHandler, getEdgeHandlerByName, patchEdgeHandler } from "../edge-handlers-db";
import type { Seeder, SeedItem } from "../seed/types";

type SeedEdgeHandler = {
  name: string;
  edge: EdgeHandler["edge"];
  scriptName: string;
  description: string;
  flavor: EdgeHandler["flavor"];
  mode: EdgeHandler["mode"];
  priority: number;
  matcher: EdgeHandlerMatcher;
  enabled: boolean;
};

const DEFAULT_CONTINUITY_PIN: SeedEdgeHandler = {
  name: "default-continuity-pin",
  edge: "task.before_assign",
  scriptName: "default-continuity-pin",
  description:
    "Advisory default continuity pin for delegated follow-ups; classifies intent before suggesting the parent agent.",
  flavor: "route",
  mode: "soft",
  priority: 900,
  matcher: { via: "delegation" },
  enabled: true,
};

type EdgeHandlerSeedItem = SeedItem & { handler: SeedEdgeHandler };

function handlerHash(handler: SeedEdgeHandler): string {
  return computeContentHash(JSON.stringify(handler));
}

/**
 * Seeds built-in handler descriptors after their scripts exist. The generic
 * framework records the exact descriptor hash, so pristine seeded rows may be
 * evolved while any user edit is preserved unchanged.
 */
export const edgeHandlersSeeder: Seeder<EdgeHandlerSeedItem> = {
  kind: "edge_handler",

  items(): EdgeHandlerSeedItem[] {
    return [
      {
        key: DEFAULT_CONTINUITY_PIN.name,
        contentHash: handlerHash(DEFAULT_CONTINUITY_PIN),
        handler: DEFAULT_CONTINUITY_PIN,
      },
    ];
  },

  upstreamHash(item): string | null {
    const existing = getEdgeHandlerByName(item.key);
    if (!existing) return null;
    return handlerHash({
      name: existing.name,
      edge: existing.edge,
      scriptName: existing.scriptName,
      description: existing.description ?? "",
      flavor: existing.flavor,
      mode: existing.mode,
      priority: existing.priority,
      matcher: existing.matcher ?? {},
      enabled: existing.enabled,
    });
  },

  apply(item): void {
    const existing = getEdgeHandlerByName(item.key);
    if (!existing) {
      createEdgeHandler(item.handler);
      return;
    }
    patchEdgeHandler(existing.id, item.handler);
  },
};
