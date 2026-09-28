import type { Scenario } from "../src/types.ts";
import { delegationChain } from "./delegation-chain.ts";
import { delegationProbe } from "./delegation-probe.ts";
import { scriptAuthoring } from "./script-authoring.ts";
import { sqlAudit } from "./sql-audit.ts";
import { structuredOutputAdherence } from "./structured-output-adherence.ts";
import { toolRouting } from "./tool-routing.ts";
import { workflowAuthoring } from "./workflow-authoring.ts";

// v9 orchestration-substrate catalog. These scenarios measure swarm mechanics the
// harness uniquely exposes: workflows, scripts, delegation, tool routing, and
// structured output. Keep delegation-probe as the gold-standard behavioral eval
// and sql-audit as the cheap smoke. Saturated / zero-pilot legacy scenarios are
// left in source for historical reference but are no longer active registry ids.
export const scenarios: Scenario[] = [
  sqlAudit,
  delegationProbe,
  workflowAuthoring,
  scriptAuthoring,
  delegationChain,
  toolRouting,
  structuredOutputAdherence,
];

// Cheap smoke default for `--scenarios` when none are passed. sql-audit is the
// designated Data smoke scenario (seeds a dump, one worker, ~$0.15-0.3).
export const DEFAULT_SCENARIO_IDS: string[] = ["sql-audit"];
