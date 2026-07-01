export interface CheckExplanation {
  title: string;
  verifies: string;
}

const EXACT: Record<string, CheckExplanation> = {
  "tasks-completed": {
    title: "Scenario tasks completed",
    verifies:
      "Every task created for the attempt reached a completed status; failed or cascade-skipped tasks fail this gate.",
  },
  "all-tasks-completed": {
    title: "All tasks completed",
    verifies: "Every task in the scenario context reached a done or completed status.",
  },
  "delegation-dimension": {
    title: "Delegation behavior",
    verifies:
      "The lead delegated the audit to workers, avoided doing the task-history research itself, and merged worker outputs correctly.",
  },
  "merged-correctness": {
    title: "Merged report correctness",
    verifies:
      "The final report contains the required counts, totals, and highest-priority completed task from the seeded history.",
  },
  "report-exists": {
    title: "Report artifact exists",
    verifies: "The worker wrote the expected final report artifact in the sandbox.",
  },
  "workflow-exists": {
    title: "Workflow was created",
    verifies: "The attempt persisted a workflow through the swarm workflow tool.",
  },
  "workflow-dag": {
    title: "Workflow DAG and routing",
    verifies:
      "The persisted workflow has the required multi-node shape, correct node types, and expected input mappings.",
  },
  "trigger-schema": {
    title: "Trigger schema validity",
    verifies:
      "The workflow trigger schema uses only supported JSON-schema keywords and contains the required inputs.",
  },
  "workflow-correctness": {
    title: "Workflow correctness",
    verifies:
      "The workflow satisfies the scenario's required authoring contract, including reusable script selection and final notification.",
  },
  "script-exists": {
    title: "Script was created",
    verifies: "The attempt persisted a reusable script rather than only doing local one-off work.",
  },
  "script-runs": {
    title: "Script executes",
    verifies:
      "The created script can be run with parameters and returns the expected deterministic result.",
  },
  "script-correctness": {
    title: "Script correctness",
    verifies:
      "The script is parameterized, type-checkable, reusable, and implements the requested transformation.",
  },
  "delegation-chain": {
    title: "Delegation chain",
    verifies:
      "The attempt created a sequential dependency chain of follow-up tasks instead of independent or unrelated tasks.",
  },
  "chain-correctness": {
    title: "Chain correctness",
    verifies:
      "The chained tasks completed in order and the final task incorporated the required upstream outputs.",
  },
  "mcp-tool-routing": {
    title: "MCP tool routing",
    verifies:
      "The worker used swarm MCP tools for memory, KV state, task lookup, delegation, and progress instead of raw API workarounds.",
  },
  "tool-selection": {
    title: "Tool selection",
    verifies:
      "Aggregates the tool-routing checks that verify memory recall, KV usage, task lookup, delegation, progress reporting, and penalties for raw API workarounds.",
  },
  "routing-output-present": {
    title: "Routing output present",
    verifies:
      "The worker completed with a non-empty final output that can be inspected for the required routing summary.",
  },
  "routing-correctness": {
    title: "Routing correctness",
    verifies:
      "The worker found the relevant Project Alpha history, summarized it, and created the required follow-up task.",
  },
  "routing-output": {
    title: "Structured routing output",
    verifies: "The final task output includes the requested structured summary fields.",
  },
  "structured-output": {
    title: "Structured output adherence",
    verifies: "The final task output is valid JSON matching the scenario's required output schema.",
  },
  "schema-valid": {
    title: "Schema-valid output",
    verifies: "The submitted output parses as JSON and satisfies the required schema.",
  },
  "tests-unmodified": {
    title: "Tests left intact",
    verifies: "The worker did not change the provided test files while fixing the seeded project.",
  },
  "source-exists": {
    title: "Source artifact exists",
    verifies: "The expected source/input file still exists where the scenario requires it.",
  },
  "all-stages-present": {
    title: "All pipeline stages present",
    verifies: "Every relay-pipeline stage produced its expected receipt or final output.",
  },
};

const PATTERNS: Array<{
  re: RegExp;
  explain: (name: string, match: RegExpMatchArray) => CheckExplanation;
}> = [
  {
    re: /^file-contains(?:\[w(\d+)])?:(.+)$/,
    explain: (name, match) => ({
      title: `File content check: ${match[2] ?? name}`,
      verifies: `Reads ${match[2] ?? "the target file"}${match[1] ? ` on worker ${match[1]}` : ""} and verifies it exists${name.includes(":") ? " and matches the expected pattern" : ""}.`,
    }),
  },
  {
    re: /^file-absent\[w(\d+)]:(.+)$/,
    explain: (_name, match) => ({
      title: `File absence check: ${match[2]}`,
      verifies: `Verifies ${match[2]} is absent on worker ${match[1]}, usually to prove worker isolation.`,
    }),
  },
  {
    re: /^test-groups-green\[w(\d+)]$/,
    explain: (_name, match) => ({
      title: `Test groups pass on worker ${match[1]}`,
      verifies: "Runs the scenario's graded test groups and scores the fraction that pass.",
    }),
  },
  {
    re: /^pipeline-stages-correct\[w(\d+)]:(.+)$/,
    explain: (_name, match) => ({
      title: `Pipeline stages correct on worker ${match[1]}`,
      verifies: `Reads ${match[2]} and checks each relay-pipeline stage's transformed output.`,
    }),
  },
];

export function explainCheck(name: string): CheckExplanation {
  const exact = EXACT[name];
  if (exact) return exact;
  for (const { re, explain } of PATTERNS) {
    const match = name.match(re);
    if (match) return explain(name, match);
  }
  return {
    title: name,
    verifies: `Runs the deterministic check named "${name}" and records its pass/fail result plus any runtime detail it reports.`,
  };
}

export function observedText(
  reasoning: string | null,
  pass: boolean,
  score: number | null,
): string {
  const scoreText = score === null ? null : `score ${score.toFixed(2)}`;
  const verdict = pass ? "Passed" : "Failed";
  if (reasoning && scoreText) return `${verdict} with ${scoreText}: ${reasoning}`;
  if (reasoning) return `${verdict}: ${reasoning}`;
  if (scoreText) return `${verdict} with ${scoreText}.`;
  return `${verdict}; this check did not report additional runtime detail.`;
}
