# Linear Drain Loop

A two-node issue-triage and dispatch workflow. The lead agent reviews child issues under a parent issue in Linear (or any tracker), categorizes them by readiness, and dispatches implementation tasks for those that are ready. Blocked or ambiguous items are surfaced for human review rather than auto-dispatched.

## Configuration

```json
{
  "name": "Linear drain loop",
  "description": "Drain ready child issues from a parent issue.",
  "triggerSchema": {
    "type": "object",
    "required": ["parentIssueKey"],
    "properties": {
      "parentIssueKey": { "type": "string" },
      "projectId": { "type": "string" },
      "repoUrl": { "type": "string" }
    }
  },
  "nodes": [
    {
      "id": "triage",
      "type": "agent-task",
      "config": {
        "role": "lead",
        "task": "Review child issues under {{parentIssueKey}} in project {{projectId}}. Identify ready, blocked, duplicate, and needs-human-decision items."
      },
      "next": ["dispatch"]
    },
    {
      "id": "dispatch",
      "type": "agent-task",
      "inputs": { "triage": "triage" },
      "config": {
        "role": "lead",
        "task": "For ready items only, create or assign implementation tasks against {{repoUrl}}. Leave a tracker comment summarizing what was dispatched."
      }
    }
  ]
}
```

## What It Does

A two-node pipeline:

1. **Triage node (lead):** Reads all child issues under `parentIssueKey` in the given `projectId`. Classifies each as: ready (has acceptance criteria, unblocked), blocked (waiting on another issue or external dependency), duplicate (same scope as an existing issue), or needs-human-decision (ambiguous scope or missing spec).

2. **Dispatch node (lead):** Takes the triage output and creates or assigns implementation tasks **only for ready items**. Posts a tracker comment summarizing what was dispatched and what was skipped.

Blocked and ambiguous items are explicitly left alone — the dispatch node surfaces them in the comment for human follow-up rather than guessing.

## When to Use

- Weekly sprint grooming: run against a milestone or epic to drain everything that's ready
- After a planning session: turn a batch of newly-specified issues into assigned tasks
- Continuous drain: schedule this workflow daily against a backlog parent issue to keep work flowing automatically

## Customization Notes

- **`projectId`** is optional but strongly recommended — without it the triage agent may search the wrong project.
- **`repoUrl`** is used by the dispatch node when creating implementation tasks. Pass the target repo where code changes will land.
- **Add a notification node:** Extend with a third `agent-task` or `slack-post` node that pings a channel with the dispatch summary.
- **Filter by label:** Modify the triage node's task prompt to only consider issues with a specific label (e.g., `"Only triage issues labelled 'ready-for-dev'"`) to avoid pulling in issues outside your sprint.

## Trade-offs

**Linear-specific prompt:** The triage and dispatch node tasks reference Linear concepts (issues, projects, comments). If your tracker is Jira or GitHub Issues, rephrase the task prompts — the workflow shape is tracker-agnostic but the agent prompts are not.

**No iteration:** This is a single-pass drain. Issues that become ready after the run are not picked up until the workflow runs again. Pair with a daily schedule trigger for continuous drain.

**Human-in-the-loop for ambiguous items:** By design, needs-human-decision items are not auto-dispatched. If your team wants a fully automated drain, strengthen the `ready` criteria in the triage prompt so fewer items land in the ambiguous bucket.
