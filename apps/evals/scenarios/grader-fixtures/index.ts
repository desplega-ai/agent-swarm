import type { GraderFixture } from "../grader-validation-support.ts";
import { fixture as capabilityRouting } from "./capability-routing.ts";
import { fixture as delegationChain } from "./delegation-chain.ts";
import { fixture as delegationProbe } from "./delegation-probe.ts";
import { fixture as fanoutResearch, soloFixture as fanoutResearchSolo } from "./fanout-research.ts";
import { fixture as humanInLoop, soloFixture as humanInLoopSolo } from "./human-in-loop.ts";
import {
  fixture as implementReview,
  soloFixture as implementReviewSolo,
} from "./implement-review.ts";
import { fixture as realDiffAgentFs } from "./real-diff-agent-fs.ts";
import { fixture as scriptAuthoring } from "./script-authoring.ts";
import { fixture as sqlAudit } from "./sql-audit.ts";
import { fixture as toolRouting } from "./tool-routing.ts";
import { fixture as workerRecovery, soloFixture as workerRecoverySolo } from "./worker-recovery.ts";
import { fixture as workflowAuthoring } from "./workflow-authoring.ts";

/**
 * One fixture per registered scenario id. grader-validation.test.ts fails for a
 * registered scenario without an entry here, so a new scenario cannot ship
 * without a null-agent and reference-agent check.
 */
export const GRADER_FIXTURES: Readonly<Record<string, GraderFixture>> = {
  "sql-audit": sqlAudit,
  "delegation-probe": delegationProbe,
  "workflow-authoring": workflowAuthoring,
  "script-authoring": scriptAuthoring,
  "delegation-chain": delegationChain,
  "tool-routing": toolRouting,
  "fanout-research": fanoutResearch,
  "fanout-research-solo": fanoutResearchSolo,
  "worker-recovery": workerRecovery,
  "worker-recovery-solo": workerRecoverySolo,
  "implement-review": implementReview,
  "implement-review-solo": implementReviewSolo,
  "capability-routing": capabilityRouting,
  "human-in-loop": humanInLoop,
  "human-in-loop-solo": humanInLoopSolo,
  "real-diff-agent-fs": realDiffAgentFs,
};
