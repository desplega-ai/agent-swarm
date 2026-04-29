#!/usr/bin/env bun
/**
 * Seed local approval requests for HITL UI testing.
 *
 * Posts a handful of varied requests (markdown-heavy, simple yes/no, multi-question,
 * already-resolved) to the running local API so you can browse them at
 *   http://localhost:5274/approval-requests
 *
 * Usage:
 *   bun run scripts/seed-approvals.ts
 *   API_URL=http://localhost:3013 API_KEY=123123 bun run scripts/seed-approvals.ts
 */

// Local-only seeding script — does not honor MCP_BASE_URL because that
// usually points at a remote tunnel (ngrok) in dev sessions.
const API_URL = process.env.API_URL || "http://localhost:3013";
const API_KEY = process.env.API_KEY || "123123";

type Question = {
  id: string;
  type: "approval" | "text" | "single-select" | "multi-select" | "boolean";
  label: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
  multiline?: boolean;
  options?: { value: string; label: string }[];
};

type SeedRequest = {
  title: string;
  questions: Question[];
  resolveAs?: { status: "approved" | "rejected"; responses: Record<string, unknown> };
};

const MARKDOWN_RATIONALE = `**Usage accuracy:** 76% over 23 task(s).

**Summary**
This update addresses the \`db-query lead-only\` blocker by providing a workaround,
expands guidance on issue creation, and reinforces the importance of Linear updates
upon task completion.

**Rationale**
The evaluation highlighted that worker agents are blocked by their inability to use
\`db-query\` to access the Linear token. The skill should be more prominently featured.

**Proposed changes**
- Add a section detailing a workaround for worker agents to obtain the Linear access token.
- Clarify the skill description to prominently feature the issue creation use case.
- Emphasize that Linear tickets *must* be updated when Linear-sourced tasks are completed.

**Token details**
- Scopes: \`app:assignable\`, \`app:mentionable\`, \`comments:create\`, \`issues:create\`, \`read\`, \`write\`
- Tokens expire — check the \`expiresAt\` column. If expired, re-authorize via OAuth.
- API endpoint: \`https://api.linear.app/graphql\`

\`\`\`bash
# Use db-query MCP tool to fetch the token
SELECT accessToken FROM oauth_tokens WHERE provider = 'linear'
\`\`\`

Approve to apply, reject to abandon.`;

const requests: SeedRequest[] = [
  {
    title: "Apply proposed changes to skill `linear-interaction`?",
    questions: [
      {
        id: "approve",
        type: "approval",
        label: "Apply proposed changes to skill `linear-interaction`?",
        description: MARKDOWN_RATIONALE,
        required: true,
      },
    ],
  },
  {
    title: "Deploy `agent-swarm` v1.72.0 to production?",
    questions: [
      {
        id: "approve",
        type: "approval",
        label: "Deploy **v1.72.0** to production?",
        description: `## Release notes

- feat(providers): claude-managed harness provider
- feat(new-ui): budgets + spend dashboard at \`/budgets\`
- feat: per-agent + global daily cost budgets

> Production cluster will be rolled in two waves. Rollback via \`pm2 restart\` if anomalies.`,
        required: true,
      },
      {
        id: "rollout-strategy",
        type: "single-select",
        label: "Rollout strategy",
        description: "Pick the rollout pace.",
        required: true,
        options: [
          { value: "canary", label: "Canary (5% → 50% → 100%)" },
          { value: "blue-green", label: "Blue/Green" },
          { value: "all-at-once", label: "All at once" },
        ],
      },
      {
        id: "notify-channels",
        type: "multi-select",
        label: "Notify channels",
        options: [
          { value: "engineering", label: "#engineering" },
          { value: "ops", label: "#ops" },
          { value: "founders", label: "#founders" },
        ],
      },
      {
        id: "comment",
        type: "text",
        label: "Additional comments",
        multiline: true,
        placeholder: "Anything the on-call should know?",
      },
    ],
  },
  {
    title: "Approve refund for customer #4821?",
    questions: [
      {
        id: "approve",
        type: "approval",
        label: "Approve refund of **$1,240.00** for customer #4821?",
        description: `Customer reported a duplicate charge on 2026-04-22.

| Field | Value |
| ----- | ----- |
| Order | \`ORD-4821\` |
| Amount | $1,240.00 |
| Reason | Duplicate charge |
| First contact | 2026-04-22 |

[See ticket](https://example.com/tickets/4821)`,
        required: true,
      },
    ],
    resolveAs: {
      status: "approved",
      responses: { approve: { approved: true } },
    },
  },
  {
    title: "Allow agent to push to `main`?",
    questions: [
      {
        id: "approve",
        type: "approval",
        label: "Allow `worker-7` to push directly to `main`?",
        description:
          "Worker is requesting a one-time exception to bypass the PR review requirement. " +
          "Reason given: *hotfix for production outage*.\n\n" +
          "**Risk:** push happens without a code review. Logs will be retained for audit.",
        required: true,
      },
    ],
    resolveAs: {
      status: "rejected",
      responses: { approve: { approved: false } },
    },
  },
  {
    title: "Quick yes/no — proceed with cleanup?",
    questions: [
      {
        id: "go",
        type: "boolean",
        label: "Proceed with deleting 142 stale workflow runs older than 30 days?",
        description: "This action is *irreversible*.",
        required: true,
      },
    ],
  },
];

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  console.log(`→ Seeding approval requests at ${API_URL}`);
  let created = 0;
  let resolved = 0;

  for (const r of requests) {
    const payload = {
      title: r.title,
      questions: r.questions,
      approvers: { policy: "any" as const, users: ["taras"] },
    };
    const result = (await postJson("/api/approval-requests", payload)) as {
      approvalRequest: { id: string };
    };
    created++;
    console.log(`  ✓ created ${result.approvalRequest.id}  ${r.title}`);

    if (r.resolveAs) {
      await postJson(`/api/approval-requests/${result.approvalRequest.id}/respond`, {
        responses: r.resolveAs.responses,
        respondedBy: "seed-script",
      });
      resolved++;
      console.log(`    ↳ resolved as ${r.resolveAs.status}`);
    }
  }

  console.log(`\n✅ Done. Created ${created} request(s), ${resolved} pre-resolved.`);
  console.log(`   View at: http://localhost:5274/approval-requests`);
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
