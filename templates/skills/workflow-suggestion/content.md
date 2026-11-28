# Workflow suggestion

Goal: when a person keeps asking for the same kind of work, say so in your reply and offer a workflow for it. The offer is one sentence inside the reply to that person. It is never a separate message, notification or digest.

`<app>` is the dashboard URL your prompt uses for links. The scan's thresholds are `argsSchema` defaults measured on real asks and installs. Do not pass your own.

## When to run

Run it only while you write a reply to a person's ask: a task with a requester, from Slack, a DM, the dashboard, chat or Comb.

Skip it for:
- heartbeat, boot-triage, scheduled and workflow-step tasks;
- worker follow-ups and anything you send to another agent;
- a thread where the newest message is from an untrusted participant;
- a reply where you just asked the person to decide something else. Do not stack two questions.

## Step 1: scan

```
script-run name="workflow-suggest-scan" scope="global" args={"taskId":"<this task's id>"}
```

The script reads this task's requester and text, their earlier asks, the install's workflows and runs, the connected integrations and the suggestion ledger. It never writes. It returns:

| Field | Meaning |
|---|---|
| `signalValid` | `false` when the script read zero rows for the requester. Treat as "no signal" and make no offer. |
| `requesterUserId` | The person the ledger is keyed on. |
| `threadRef` | This conversation's id (the task's `contextKey`, else the task id). Store it as `thread`. |
| `optedOut` | The person said "stop suggesting workflows". |
| `mature` | In the last 7 days, at least `maturityMinWorkflows` user-made workflows ran, with at least `maturityMinRunsPerWeek` runs in total. |
| `pattern` | `null`, or `{ id, count, firstAt, taskIds, sample, cadence }`: this ask plus earlier asks with word similarity of at least `similarityMin`, counted once per day, inside `lookbackDays`. Set only when `count` reaches `repeatMinCount`. `id` is the oldest task id in the group. `cadence` is the median days between the asks. |
| `alreadyOffered` | The ledger has a record for this pattern, in any state. |
| `pendingOffer` | A ledger record of this person in state `offered` whose `thread` equals `threadRef`: an offer they have not answered. |
| `workflows` | Install workflows ranked by fit: `{ id, name, description, enabled, seeded, runs7d, lastRunStatus, requires }`. |
| `diagnosis` | `never-created`, `created-never-triggered`, `runs-failed` or `healthy`, with the workflow ids behind it. |
| `integrations` | `integration-status` output: `slack`, `github`, `linear`, `jira`, `gsc`, `agentmail`, `agentfs` as `unverified`, `configured` or `verified`, plus script connection slugs. |

Make no offer when any of these hold: the script failed, `signalValid` is false, `optedOut`, `mature`, `pattern` is null, or `alreadyOffered`. Do not retry the script inside the same reply. Answer the ask as usual.

## Step 2: read the answer to a pending offer

When `pendingOffer` is set, the person's new message may answer it.

| Their message | Do |
|---|---|
| Yes, or "use it", "draft it" | Go to Step 5 for a draft, or enable or run the existing workflow they agreed to. Record `accepted`. |
| No, "not now", "not needed" | Record `declined`. Say nothing more about it. |
| "Stop suggesting workflows" or similar | Record `optedOut` for the person. Confirm in one short sentence. |
| Anything else | Leave the record as `offered`. Never ask again. |

## Step 3: diagnose before you offer

Use `diagnosis` to pick the sentence. Name what you saw; do not guess a cause the data does not show.

- `never-created`: the install has no workflow of its own. Offer an existing seeded workflow if one fits, else a draft.
- `created-never-triggered`: a workflow exists but has 0 runs. Say why from the data: it is disabled, it has no trigger, or no schedule targets it. Offer to turn it on or to add the schedule.
- `runs-failed`: its recent runs failed. Read the last run with `get-workflow-run` and name the failing node. Offer to fix it; the `workflow-iterate` skill does the fix.
- `healthy`: offer only when no existing workflow covers this pattern.

## Step 4: choose one offer

Answer the ask in full first. The offer never delays or replaces the work. Put it in one sentence at the end of the reply.

Pick the first that fits:

1. **An existing workflow on this install.** Confirm the fit with `get-workflow`. Example: "We have the [competitor-radar workflow](<app>/workflows/<id>) that may help with this. Want me to run it?" If it is disabled or failing, say so and offer to turn it on or fix it.
2. **A docs playbook.** When the `swarm-docs` index has an entry whose `when` line matches, follow that skill's offer rules: "Do you want me to use the [<playbook>](<docs link>) for this?"
3. **A draft.** "You have asked for this <pattern.count> times since <pattern.firstAt>. Want me to draft it as a workflow? It stays off until you turn it on."

Rules:
- At most one offer per reply and one per thread.
- Each number in the sentence comes from the scan output. Never round up or estimate.
- The draft must use only integrations in `integrations` (Step 5). If the pattern needs one that is missing, do not offer a draft that works around it. Say it needs that tool and link `<app>/integrations/tools`.

Write the `offered` record (Step 6) in the same turn as the offer.

## Step 5: draft a disabled workflow (only after a yes)

1. Map the asks in `pattern.taskIds` to steps. Read 2 or 3 of them with `get-task-details` for the real inputs and outputs.
2. Pick nodes only from connected integrations:

   | Needed | Node | Requires |
   |---|---|---|
   | Post to Slack | `notify` with `channel: "slack"` | `slack` |
   | Send email | `notify` with `channel: "email"` | `agentmail` |
   | Open an issue or PR, comment | `vcs` | `github` |
   | Linear or Jira work | `agent-task` that uses the tracker | `linear` or `jira` |
   | Write a report file | `agent-task` or `swarm-script` writing to agent-fs | `agentfs` |
   | Judgement, writing, research | `agent-task` | none |
   | Bulk data or a deterministic step | `swarm-script` | none |
   | A gate | `property-match` or `code-match` | none |

3. Build and check it with the `workflow-iterate` skill.
4. Create it switched off: `create-workflow` with `enabled: false` and `requires` set to the integrations it uses.
5. When the asks came on a steady cadence (`pattern.cadence` days apart), add `create-schedule` with `targetType: "workflow"`, the `workflowId` and `enabled: false`.
6. Reply with the link: "The draft is ready and off: <app>/workflows/<id>. Turn it on with the toggle at the top of the page."
7. Do not enable, trigger or schedule it on yourself. Only the person's explicit yes to that does.
8. Record `drafted` with the `workflowId`.

## Step 6: record

One namespace, written only by you (the Lead):

```
kv-set namespace="workflow-suggest" key="u/<requesterUserId>/p/<pattern.id>" valueType="json" value={
  "state": "offered" | "accepted" | "declined" | "drafted",
  "sample": "<pattern.sample>",
  "taskIds": [...],
  "offer": "existing" | "playbook" | "draft",
  "workflowId": "<id, when there is one>",
  "thread": "<threadRef>",
  "offeredAt": "<ISO>",
  "answeredAt": "<ISO, when answered>"
}
```

Opt-out: `kv-set namespace="workflow-suggest" key="u/<requesterUserId>/optout" valueType="json" value={"at":"<ISO>","thread":"<threadRef>"}`.

Any record for a pattern means it is never offered again, whatever its state. The scan compares new asks against each record's `sample`, so a reworded repeat still counts as offered.

## Stop conditions

Suggestions stop for good, without asking, when any of these hold:
- the person opted out;
- the install is `mature`;
- the operator switched the prompt pointer off (empty override of the `task.workflow_suggest` template).
