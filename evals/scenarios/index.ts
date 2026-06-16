import type { Scenario } from "../src/types.ts";
import { bugLadder } from "./bug-ladder.ts";
import { crossWorkerInvent } from "./cross-worker-invent.ts";
import { delegationProbe } from "./delegation-probe.ts";
import { distributedAudit } from "./distributed-audit.ts";
import { failureRecovery, failureRecoveryMixed } from "./failure-recovery.ts";
import { memoryCoordination } from "./memory-coordination.ts";
import { memoryDistractor } from "./memory-distractor.ts";
import { planImplementReview } from "./plan-implement-review.ts";
import { relayPipeline } from "./relay-pipeline.ts";
import { sqlAudit } from "./sql-audit.ts";

// v8.0 round-11 catalog (OutcomeSpec v2). The 7 old scenarios were deleted in
// Phase 6 scaffolding; the new discriminating scenarios are appended here as
// each is authored. The first seven — sql-audit, memory-distractor, bug-ladder,
// cross-worker-invent, relay-pipeline, plan-implement-review, distributed-audit
// — are joined by the swarm-mechanics spike (memory-coordination,
// failure-recovery, failure-recovery-mixed), where the bottleneck is the SWARM
// (shared-memory handoff + recovery from a poisoned teammate), not single-model
// capability. Historical runs referencing deleted ids keep rendering via stored
// ids (no registry lookup) with the unregistered-scenario fallback on the
// detail route.
export const scenarios: Scenario[] = [
  sqlAudit,
  memoryDistractor,
  bugLadder,
  crossWorkerInvent,
  relayPipeline,
  planImplementReview,
  distributedAudit,
  memoryCoordination,
  failureRecovery,
  failureRecoveryMixed,
  delegationProbe,
];

// Cheap smoke default for `--scenarios` when none are passed. sql-audit is the
// designated Data smoke scenario (seeds a dump, one worker, ~$0.15-0.3).
export const DEFAULT_SCENARIO_IDS: string[] = ["sql-audit"];
