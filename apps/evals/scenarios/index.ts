import type { Scenario } from "../src/types.ts";
import { delegationChain } from "./delegation-chain.ts";
import { delegationProbe } from "./delegation-probe.ts";
import { fanoutResearch, fanoutResearchSolo } from "./fanout-research.ts";
import { scriptAuthoring } from "./script-authoring.ts";
import { sqlAudit } from "./sql-audit.ts";
import { toolRouting } from "./tool-routing.ts";
import { workerRecovery, workerRecoverySolo } from "./worker-recovery.ts";
import { workflowAuthoring } from "./workflow-authoring.ts";

// v9 orchestration-substrate catalog. These scenarios measure swarm mechanics the
// harness uniquely exposes: workflows, scripts, delegation, tool routing, and
// structured output. Keep delegation-probe as the gold-standard behavioral eval
// and sql-audit as the cheap smoke. Saturated / zero-pilot legacy scenarios are
// left in source for historical reference but are no longer active registry ids.
// structured-output-adherence is folded into tool-routing as a gate.
// Swarm scenarios (lead + workers) ship with their `-solo` single-agent baseline
// next to them (plan Q6); src/baseline.ts compares the pair.
export const scenarios: Scenario[] = [
  sqlAudit,
  delegationProbe,
  workflowAuthoring,
  scriptAuthoring,
  delegationChain,
  toolRouting,
  fanoutResearch,
  fanoutResearchSolo,
  workerRecovery,
  workerRecoverySolo,
];

// Cheap smoke default for `--scenarios` when none are passed. sql-audit is the
// designated Data smoke scenario (seeds a dump, one worker, ~$0.15-0.3).
export const DEFAULT_SCENARIO_IDS: string[] = ["sql-audit"];
