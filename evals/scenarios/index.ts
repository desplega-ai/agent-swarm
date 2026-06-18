import type { Scenario } from "../src/types.ts";
import { bugLadder } from "./bug-ladder.ts";
import { delegationProbe } from "./delegation-probe.ts";
import { distributedAudit } from "./distributed-audit.ts";
import { memoryDistractor } from "./memory-distractor.ts";
import { relayPipeline } from "./relay-pipeline.ts";
import { sqlAudit } from "./sql-audit.ts";

// v8.0 round-11 catalog (OutcomeSpec v2). The swarm-redesign prune (Plan A) cut
// the four clearly-measured non-discriminators — memory-coordination,
// failure-recovery, failure-recovery-mixed, and cross-worker-invent. A follow-up
// scenario audit additionally killed plan-implement-review (expensive lead+2; only
// a noisy weight-1 judge moved the aggregate) — leaving the scenarios that still
// discriminate harness+model or swarm mechanics.
// Historical runs referencing deleted ids keep rendering via stored ids (no
// registry lookup) with the unregistered-scenario fallback on the detail route.
export const scenarios: Scenario[] = [
  sqlAudit,
  memoryDistractor,
  bugLadder,
  relayPipeline,
  distributedAudit,
  delegationProbe,
];

// Cheap smoke default for `--scenarios` when none are passed. sql-audit is the
// designated Data smoke scenario (seeds a dump, one worker, ~$0.15-0.3).
export const DEFAULT_SCENARIO_IDS: string[] = ["sql-audit"];
