# comms-adherence-gate

Agents finish Slack tasks with a final message a human reads. This extension judges that message against the requester's stated comms preferences and their latest request with Jev, [TypeSafe](https://typesafe.ai)'s decision model. In `enforce` it blocks a non-adherent completion once and tells the agent what to fix.

Install config:

```json
{ "mode": "shadow" }
```

Start in `shadow`, read the verdicts in KV for a few days, then switch to `enforce`.

## Modes

| `mode` | Effect |
|---|---|
| `off` | Never evaluates. |
| `shadow` (default) | Asks Jev and records the verdict. Never blocks. |
| `enforce` | Asks Jev, records the verdict, and blocks the `store-progress` call when a dimension fails, at most `maxBlocksPerTask` times per task. The agent gets the failed dimensions, their scores and the stated preference, and calls again. |

## What it gates

Hook: `pre.tool.call` on `store-progress` with `status: "completed"` and a non-empty `output`. Calls made by extensions are skipped. The task must:

1. Come from Slack (`source = "slack"` or a `slackThreadTs`). Other tasks pass without a Jev call.
2. Have a requester with stated preferences in `users.metadata.comms`. A requester with none passes. Set them with the `manage-user` tool.

## Decision

The gate reads the task row and asks one `noul` question per stated preference it knows: `verbosity`, `tone`, `language`. Any other key in `comms` is context only.

Jev sees the preferences, the requester's latest message (the text after the last `</thread_context>`, from the last 1,400 characters of the task), the first 400 characters of the task, and the output. Its judging rules say an explicit request outranks the stored default. A requested long answer, story or document is not a verbosity failure.

A dimension fails when its score is below `threshold`. Any failed dimension fails the output.

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

Call `store-progress` with a non-completed status and `progress` starting with `comms-gate-selftest`. The gate judges a known-bad and a known-good message against a terse preference and writes `selftest:last`: both scores, the threshold, the provider, and `controlsOk` (bad below threshold and good at or above it). Real traffic is untouched.

## Config

| Key | Default | Notes |
|---|---|---|
| `mode` | `shadow` | `off`, `shadow`, or `enforce` |
| `threshold` | `0.5` | A dimension scoring below this fails |
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

- `last`: the latest verdict, with `scores`, `failed`, `provider`, `latencyMs`, the preferences, a 400-character `askPreview` and a 700-character `outputPreview`.
- `fail:<epochMs>:<taskId>`: one row per failed verdict, with `action` (`blocked` or `recorded`).
- `blocks:<taskId>`: blocks issued for that task.
- `error:last`, `selftest:last`.
- Counters: `total`, `pass`, `fail`, `blocked`, `escaped` (enforce, block budget spent), `shadowed`, `error`, and `dim:<dimension>`.

## Known limits

- Only the last 1,400 characters of the task are searched for the latest request. A very long final message is cut to its last 900 characters.
- The block budget is per task, so a retried completion after a block goes through once the budget is spent, even if it still fails.
