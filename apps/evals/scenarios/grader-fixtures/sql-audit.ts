import { type GraderFixture, makeContext, nullTasks } from "../grader-validation-support.ts";
import { sqlAudit } from "../sql-audit.ts";

/**
 * Reference: the worker answers the three questions from the seeded history
 * (answer key in sql-audit.ts: 12 completed, "Rotate the payments service API
 * keys" at priority 95, the checkout-redesign deploy as the status/output
 * anomaly) and writes the report. The null agent completes its task and writes
 * no file, so the report gate must fail.
 */
export const fixture: GraderFixture = {
  reference: () =>
    makeContext(sqlAudit, {
      tasks: nullTasks(sqlAudit).map((t) => ({
        ...t,
        result: "Audit written to /workspace/audit/.",
      })),
      files: {
        "w0:/workspace/audit/completed-count.txt": "12\n",
        "w0:/workspace/audit/top-priority-completed.txt": "Rotate the payments service API keys\n",
        "w0:/workspace/audit/anomaly.txt": "Deploy the checkout redesign to production\n",
        "w0:/workspace/audit/report.md": [
          "# Audit of the seeded task history",
          "",
          "- 12 tasks have status `completed` (counted over all 20 rows).",
          "- Highest-priority completed task: Rotate the payments service API keys (priority 95).",
          "- Anomaly: Deploy the checkout redesign to production is `failed` but its output claims success.",
        ].join("\n"),
      },
    }),
};
