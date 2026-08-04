import type { WorkflowDefinition } from "../../types";
import { ApprovedDeltaSetSchema, ReflectionDeltaSchema } from "../seed-scripts/dream-schemas";

const EMPTY_DELTA_SET_EXAMPLE = JSON.stringify({ deltas: [] });

function deltaSetSchemaForKind(kind?: "skill" | "hygiene") {
  const approvedProperties = ApprovedDeltaSetSchema.properties as Record<string, unknown>;
  const reflectionProperties = ReflectionDeltaSchema.properties as Record<string, unknown>;
  return {
    ...ApprovedDeltaSetSchema,
    properties: {
      ...approvedProperties,
      deltas: {
        type: "array",
        items: kind
          ? {
              ...ReflectionDeltaSchema,
              properties: {
                ...reflectionProperties,
                kind: { type: "string", const: kind },
              },
            }
          : ReflectionDeltaSchema,
      },
    },
  };
}

export const DREAM_WORKFLOW_DEFINITION: WorkflowDefinition = {
  onNodeFailure: "continue",
  nodes: [
    {
      id: "gather",
      type: "swarm-script",
      label: "Gather daily evidence",
      config: {
        scriptName: "dream-gather",
        scope: "global",
        args: { days: 1, preflightOnly: true },
      },
      next: "proceed",
    },
    {
      id: "proceed",
      type: "code-match",
      label: "Activity gate",
      inputs: { gather: "gather.result" },
      config: {
        code: "(input) => Boolean(input.gather?.enabled && input.gather?.hasActivity)",
        outputPorts: ["true", "false"],
      },
      next: { true: "gather-rich", false: "done" },
    },
    {
      id: "gather-rich",
      type: "swarm-script",
      label: "Gather rich daily evidence as Lead",
      inputs: { leadAgentId: "gather.result.leadAgentId" },
      config: {
        scriptName: "dream-gather",
        scope: "global",
        agentId: "{{leadAgentId}}",
        args: { days: 1 },
      },
      next: "rich-proceed",
    },
    {
      id: "rich-proceed",
      type: "code-match",
      label: "Rich gather gate",
      inputs: { gather: "gather-rich.result" },
      config: {
        code: "(input) => Boolean(input.gather?.enabled && input.gather?.hasActivity)",
        outputPorts: ["true", "false"],
      },
      next: { true: "hygiene-snapshot", false: "done" },
    },
    {
      id: "reflect",
      type: "foreach",
      label: "Agent reflections",
      inputs: { agents: "gather-rich.result.agents" },
      config: {
        over: "{{agents}}",
        itemKey: "id",
        body: {
          type: "agent-task",
          config: {
            agentId: "{{item.id}}",
            template:
              "Run the `dreaming` skill for yourself. Call the global `dream-agent-slice` script with " +
              '`{"agentId":"{{item.id}}","days":1}` and use only that evidence. Return one JSON ' +
              `ReflectionDelta set such as ${EMPTY_DELTA_SET_EXAMPLE} containing only evidence-backed ` +
              "improvements (an empty deltas array is valid on a quiet day). Quote any profile H2 " +
              "anchor exactly; do not invent evidence or an anchor.",
            outputSchema: deltaSetSchemaForKind(),
          },
        },
      },
      next: "critique",
    },
    {
      id: "skills",
      type: "agent-task",
      label: "Skill adoption review",
      inputs: {
        leadAgentId: "gather-rich.result.leadAgentId",
        skills: "gather-rich.result.insights.skills",
        compound: "gather-rich.result.insights.compound",
        activity: "gather-rich.result.insights.activity",
      },
      config: {
        agentId: "{{leadAgentId}}",
        template:
          "Review skill adoption using this current catalog: {{skills}}. " +
          "Daily compound evidence: {{compound}}. Activity counts: {{activity}}. " +
          `Return only an ApprovedDeltaSet JSON object such as ${EMPTY_DELTA_SET_EXAMPLE}. ` +
          "Every delta must have kind `skill`; an empty deltas array is valid.",
        outputSchema: deltaSetSchemaForKind("skill"),
      },
      next: "critique",
    },
    {
      id: "hygiene-snapshot",
      type: "swarm-script",
      label: "Snapshot rotating pull request when available",
      inputs: {
        snapshotArgs: "gather-rich.result.blockers.rotation.snapshotArgs",
      },
      config: {
        scriptName: "gh-pr-snapshot",
        scope: "global",
        args: "{{snapshotArgs}}",
      },
      next: ["reflect", "skills", "hygiene"],
    },
    {
      id: "hygiene",
      type: "agent-task",
      label: "Heartbeat and blocker hygiene",
      inputs: {
        leadAgentId: "gather-rich.result.leadAgentId",
        heartbeatClaims: "gather-rich.result.blockers.heartbeatClaims",
        stuckOrFailedTasks: "gather-rich.result.blockers.stuckOrFailedTasks",
        awaitingUserReply: "gather-rich.result.blockers.awaitingUserReply",
        rotation: "gather-rich.result.blockers.rotation",
        prSnapshot: "hygiene-snapshot.result",
        compound: "gather-rich.result.insights.compound",
        activity: "gather-rich.result.insights.activity",
      },
      config: {
        agentId: "{{leadAgentId}}",
        template:
          "Review HEARTBEAT hygiene and the current rotation target. Heartbeat claims: " +
          "{{heartbeatClaims}}. Stuck or failed tasks: {{stuckOrFailedTasks}}. Awaiting user reply: " +
          "{{awaitingUserReply}}. Rotation: {{rotation}}. Pull-request snapshot: {{prSnapshot}}. " +
          "Daily compound evidence: {{compound}}. Activity counts: {{activity}}. " +
          "Verify claims and mark stale claims " +
          `RESOLVED-STALE. Return only an ApprovedDeltaSet JSON object such as ${EMPTY_DELTA_SET_EXAMPLE}; ` +
          "every delta must have kind `hygiene`, and anchors must be quoted verbatim. " +
          "When the rotation target is available and a HEARTBEAT change is approved, include " +
          "rotationCursorKey, rotationCursorNamespace, and rotationCursorBy: 1 on that hygiene delta.",
        outputSchema: deltaSetSchemaForKind("hygiene"),
      },
      next: "critique",
    },
    {
      id: "critique",
      type: "agent-task",
      label: "Lead critique",
      inputs: {
        leadAgentId: "gather-rich.result.leadAgentId",
        reflections: "reflect.results",
        skills: "skills.taskOutput",
        hygiene: "hygiene.taskOutput",
        profileEvidence: "gather-rich.result.insights.profileEvidence",
      },
      config: {
        agentId: "{{leadAgentId}}",
        template:
          "Critique, deduplicate, and arbitrate these proposed Dreaming changes in one pass. " +
          "A lane's input may be empty or absent if that lane failed; treat that as no proposals " +
          "from that lane. " +
          "Agent reflections: {{reflections}}. Skill proposals: {{skills}}. Hygiene proposals: {{hygiene}}. " +
          "Exact profile H2 anchor text: {{profileEvidence}}. " +
          `Return only an ApprovedDeltaSet JSON object such as ${EMPTY_DELTA_SET_EXAMPLE}. ` +
          "Reject drift and weak evidence. For every anchored profile operation, copy the H2 anchor verbatim " +
          "from that profile evidence input; never invent an anchor.",
        outputSchema: ApprovedDeltaSetSchema,
      },
      next: "apply",
    },
    {
      id: "apply",
      type: "swarm-script",
      label: "Apply approved deltas",
      inputs: {
        approved: "critique.taskOutput",
        leadAgentId: "gather-rich.result.leadAgentId",
        runId: "run.id",
      },
      config: {
        scriptName: "dream-apply",
        scope: "global",
        agentId: "{{leadAgentId}}",
        // runId keys the per-delta idempotency receipts that make retries safe.
        args: { deltas: "{{approved}}", runId: "{{runId}}" },
      },
      next: "receipt",
    },
    {
      id: "receipt",
      type: "swarm-script",
      label: "Write Dreaming receipt",
      inputs: {
        apply: "apply.result",
        leadAgentId: "gather-rich.result.leadAgentId",
        runId: "run.id",
      },
      config: {
        scriptName: "dream-receipt",
        scope: "global",
        agentId: "{{leadAgentId}}",
        // The receipt's "Run: …" line correlates the durable memory/Slack audit
        // with the workflow run that performed the mutations.
        args: { apply: "{{apply}}", runId: "{{runId}}" },
      },
      next: "done",
    },
    {
      id: "done",
      type: "code-match",
      label: "Dream complete",
      config: { code: "() => 'done'", outputPorts: ["done"] },
    },
  ],
};

export default DREAM_WORKFLOW_DEFINITION;
