# comms-adherence-gate

Agents finish Slack tasks with a final message a human reads, and post to Slack threads directly. This extension judges that text with Jev, [TypeSafe](https://typesafe.ai)'s decision model: against the requester's stated comms preferences and their latest request, and against a plain-language rubric that applies to every message. In `enforce` it blocks a failing call once and tells the agent what to fix. A `plain` failure points the agent at the `comms` skill.

Install config:

```json
{ "mode": "shadow", "plainMode": "shadow" }
```

Start in `shadow`, read the verdicts in KV for a few days, then switch to `enforce`. `mode` and `plainMode` move independently.

## Modes

| `mode` | Effect |
|---|---|
| `off` | Never evaluates. |
| `shadow` (default) | Asks Jev and records the verdict. Never blocks. |
| `enforce` | Asks Jev, records the verdict, and blocks the call when a dimension fails, at most `maxBlocksPerTask` times per task. The agent gets the failed dimensions, their scores and the stated preference, and calls again. |

`mode` governs the preference dimensions (`verbosity`, `tone`, `language`). `plainMode` governs `plain`. A dimension blocks only when its own mode is `enforce`. Both share one block budget per task, across every gated tool.

## What it gates

Hook: `pre.tool.call` on:

- `store-progress` with `status: "completed"` and a non-empty `output`, on a task that came from Slack (`source = "slack"` or a `slackThreadTs`). Other completions pass without a Jev call.
- `slack-reply`, `slack-post`, `slack-start-thread` and `slack-update`, judged on `message`. The task is `slack-reply`'s `taskId`, else the caller's task context. A post with no task context passes.

Only a call the tool itself accepts is judged, so no other task's text reaches Jev. For `store-progress` the caller must own the task, the task must be unassigned, or the caller must be a lead. For the Slack tools the caller must be the task's assignee or its creator, the rule `slack-reply` enforces. Calls made by extensions are skipped. Script SDK calls never reach `pre.tool.call` (the tool registrar dispatches it only for MCP calls); if one ever does, the gate records it and never blocks.

A requester with no stated preferences in `users.metadata.comms` still gets the `plain` question. Set preferences with the `manage-user` tool.

In a thread with several people, the requester is the person whose message created the task. A message that @-mentions someone (`<@U123>`) is judged against the first mentioned person with stored preferences, resolved through their Slack identity in `user_external_ids`; otherwise against the requester. The lookup is one SQL read, only when the text mentions someone and `mode` is not `off`. The verdict records who was judged in `judgedFor` (`mention` or `requester`) and `audience`.

## Decision

The gate reads the task row and asks one `noul` question per stated preference it knows: `verbosity`, `tone`, `language`. Any other key in `comms` is context only.

Jev sees the preferences, the requester's latest message (the text after the last `</thread_context>`, from the last 1,400 characters of the task), the first 400 characters of the task, and the output. Its judging rules say an explicit request outranks the stored default. A requested long answer, story or document is not a verbosity failure.

It also asks `plain` on every message unless `plainMode` is `off` or the text is a JSON document (structured output for an `outputSchema`). The rubric comes from the `comms` skill: everyday words, one idea per sentence, every number with a unit and a direction word, and no unexplained shorthand (n, median, p90, cohort, baseline, delta, `±X at 95%`). Code identifiers, task ids, PR numbers, links and versions are fine. Jev gets contrasting plain and dense examples in `plain_language_rules`; a prose-only rubric scored plain rewrites as low as the dense originals.

All questions go in one Jev request. A preference dimension fails below `threshold`; `plain` fails below `plainThreshold`. Any failed dimension fails the message.

### Calibration of `plain`

Jev scores dense status text near 0 and plain text near 0.8 to 0.9, with a wide middle of compact but readable engineering notes. Measured on 400 Slack-facing completions over 7 days, at `threshold` 0.75 for preferences:

| `plainThreshold` | Newly blocked (of messages that pass today) |
|---|---|
| 0.75 | 81% to 83% |
| 0.3 | 9% to 13% |
| 0.25 (default) | 5% to 7% |

At 0.25 the dense prompt-cache-monitor post scores about 0.15 and its plain rewrite about 0.81.

## Jev transport

Jev is reachable two ways. Both take the same request and return the same answer.

| `provider` | Endpoint | Key | Model |
|---|---|---|---|
| `typesafe` | `POST https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` (or `apiKey`) | `model`, default `jev-latest` |
| `openrouter` | `POST https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | `openrouterModel`, default `typesafe/jev-1.13` |
| `auto` (default) | TypeSafe when its key is set, else OpenRouter | | |

Each verdict row records the `provider` that answered.

## Fail open

Every error lets the completion through: a missing key, an HTTP error, a network error, a timeout, a malformed answer, or a failed DB read. The handler never throws, so an outage cannot auto-disable the extension. Each failure bumps the `error` counter and overwrites `error:last`.

## Self-test

Call `store-progress` with a non-completed status and `progress` starting with `comms-gate-selftest`. The gate judges a known-bad and a known-good message against a terse preference, and a dense and a plain message on `plain`, then writes `selftest:last`: every score, both thresholds, the provider, `controlsOk` (verbosity: bad below `threshold`, good at or above it) and `plainControlsOk` (the same against `plainThreshold`). Real traffic is untouched.

## Config

| Key | Default | Notes |
|---|---|---|
| `mode` | `shadow` | `off`, `shadow`, or `enforce` |
| `threshold` | `0.5` | A preference dimension scoring below this fails |
| `plainMode` | `shadow` | `off`, `shadow`, or `enforce` for the `plain` dimension |
| `plainThreshold` | `0.25` | `plain` scoring below this fails. See [Calibration](#calibration-of-plain) |
| `timeoutMs` | `4000` | Jev call timeout, capped at 4000 (the dispatcher cancels a handler at 5 s) |
| `maxBlocksPerTask` | `1` | Blocks per task in `enforce`; after that the gate records and lets it through |
| `provider` | `auto` | `auto`, `typesafe`, or `openrouter`. See [Jev transport](#jev-transport) |
| `model` | `jev-latest` | Jev model on TypeSafe |
| `openrouterModel` | `typesafe/jev-1.13` | Jev model on OpenRouter |
| `apiKey` | unset | Explicit TypeSafe key. Prefer the `TYPESAFE_API_KEY` secret below |

## Required secrets

Read from the API process environment at call time. Set them as global `swarm_config` secrets: the API process loads global rows into `process.env` at boot and on config reload.

- `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`: one is required for any evaluation. Under `auto`, TypeSafe wins when both are set. Without either, every completion fails open.

No key is written to config, KV, logs, or a block reason.

## KV namespace `ext:comms-gate`

- `last`: the latest verdict, with `tool`, `scores`, `failed`, `mode`, `plainMode`, `provider`, `latencyMs`, the preferences, a 400-character `askPreview` and a 700-character `outputPreview`.
- `fail:<epochMs>:<taskId>`: one row per failed verdict, with `action` (`blocked` or `recorded`).
- `blocks:<taskId>`: blocks issued for that task.
- `error:last`, `selftest:last`.
- Counters: `total`, `pass`, `fail`, `blocked`, `escaped` (a blocking dimension failed, block budget spent), `shadowed` (only non-blocking dimensions failed), `error`, and `dim:<dimension>`.

## Known limits

- Only the last 1,400 characters of the task are searched for the latest request. A very long final message is cut to its last 900 characters.
- The block budget is per task, so a retried call after a block goes through once the budget is spent, even if it still fails.
- Each gated Slack post waits for one Jev call (about 0.2 s measured, capped by `timeoutMs`).
