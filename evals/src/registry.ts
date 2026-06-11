import { configs } from "../configs/index.ts";
import { scenarios } from "../scenarios/index.ts";
import type { Registry } from "./runner/index.ts";

export function loadRegistry(): Registry {
  return {
    scenarios: new Map(scenarios.map((s) => [s.id, s])),
    configs: new Map(configs.map((c) => [c.id, c])),
  };
}
