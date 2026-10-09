# slack-reply-gate

Lead is woken by every human message in a Slack thread the swarm takes part in, including "lol", an emoji, or two people chatting with each other. This extension asks Jev, [TypeSafe](https://typesafe.ai)'s decision model, whether Lead should answer a new thread message, and drops the wake-up when it should not.

Install config:

```json
{ "mode": "shadow" }
```

Start in `shadow`, read the decisions in KV for a few days, then switch to `enforce`.

## Modes

| `mode` | Effect |
|---|---|
| `off` | Never evaluates. |
| `shadow` (default) | Asks Jev and records the verdict. Never blocks. |
| `enforce` | Asks Jev, records the verdict, and blocks the Lead task when the answer is no. The message gets :mute: instead: no Lead task, no reply, no outcome card. |

## What it gates

Hook: `pre.task.create`, for tasks with origin `slack` whose description carries the thread buffer's header `[Thread follow-up — N message(s) buffered]`. Those are the non-mention thread replies that `src/slack/thread-buffer.ts` batches into a Lead task. A direct @mention of the bot creates a task without that header and is never gated.

The header counts only at the start of the description or right after the closing `</thread_context>`. Thread context quotes old messages verbatim, and an older Lead reply can quote the header itself, so a header inside the context is ignored. Only the text after the real header is treated as new.

## Decision

1. A follow-up with downloaded files (status `draft`) passes without a Jev call.
2. **@mention pass-through.** A new message that @mentions Lead passes without a Jev call. A mention is the bot mention the engine rewrites to `<@U…> (that's you)`, a resolved `<@U…|lead>`, or a literal `@lead` (any name in `leadAliases`). Only the new messages are scanned, never the thread context, so an old mention earlier in the thread does not pass later banter.
3. Otherwise one Jev call (one `choice` question, see [Jev transport](#jev-transport)) with the new message(s), the sender kind, and the last `contextMessages` thread messages. Labels: `direct_ask`, `followup_to_lead`, `instruction_to_lead`, `reaction_only`, `banter_between_others`, `not_addressed_to_lead`, `other`.
4. The answer is no only when the top label is `reaction_only`, `banter_between_others`, or `not_addressed_to_lead`, and the summed probability of those three labels is at least `minConfidence`. A split between two skip labels is still a skip. An unsure verdict replies.

Several buffered messages are judged together. One mention in any of them passes the batch.

## Jev transport

Jev is reachable two ways. Both take the same request and return the same answer, so the decision is identical whichever one runs.

| `provider` | Endpoint | Key | Model |
|---|---|---|---|
| `typesafe` | `POST https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` (or `apiKey`) | `model`, default `jev-latest` |
| `openrouter` | `POST https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | `openrouterModel`, default `typesafe/jev-1.13` |
| `auto` (default) | TypeSafe when its key is set, else OpenRouter | | |

Under `auto`, `TYPESAFE_API_KEY` wins when both keys are set. With neither key, every message fails open and the KV row names both secrets. Each decision row records the `provider` that answered.

## Fail open

Every error lets the task through: a missing key, a TypeSafe HTTP error, a network error, a timeout, a malformed answer, or an unknown label. The handler never throws, so an outage cannot auto-disable the extension. Each failure is recorded as `fail-open` in KV and logged as a warning.

## :mute: on drop (enforce)

No swarm tool or extension `ctx` method adds a Slack reaction, so the hook calls the Slack Web API with the bot token. It needs the `reactions:write` scope, which the Slack app already uses for its acceptance reactions.

1. `reactions.remove` for each acceptance reaction the engine may have put on the triggering message: `eyes`, `heavy_plus_sign`, `zap`, `speech_balloon`, or their `SLACK_REACTION_ACCEPTED`, `SLACK_REACTION_BUFFERED`, `SLACK_REACTION_NOW`, and `SLACK_REACTION_STEERED` overrides. Slack only removes the bot's own reaction, so a human's :eyes: stays.
2. `reactions.add` with `muteReaction` (default `mute`). `already_reacted` counts as success.

The block returns first and the Slack calls run after it. A slow or failing Slack call never delays the drop or turns it back into a task. Set `muteReaction` to `""` to drop silently.

## Config

| Key | Default | Notes |
|---|---|---|
| `mode` | `shadow` | `off`, `shadow`, or `enforce` |
| `timeoutMs` | `3000` | Jev call timeout, capped at 4000 (the dispatcher cancels a handler at 5 s) |
| `provider` | `auto` | `auto`, `typesafe`, or `openrouter`. See [Jev transport](#jev-transport) |
| `model` | `jev-latest` | Jev model on TypeSafe |
| `openrouterModel` | `typesafe/jev-1.13` | Jev model on OpenRouter |
| `minConfidence` | `0.55` | Minimum summed skip probability to skip |
| `contextMessages` | `6` | Thread messages sent to Jev, 0 to 20 |
| `leadAliases` | `["lead"]` | A literal `@alias` in a new message counts as a mention |
| `botSlackUserIds` | `[]` | Slack user ids labelled `bot` as the sender for Jev |
| `apiKey` | unset | Explicit TypeSafe key. Prefer the `TYPESAFE_API_KEY` secret below |
| `muteReaction` | `mute` | Reaction for a dropped message; `""` disables muting |
| `slackTimeoutMs` | `5000` | Timeout per Slack call |

## Required secrets

All are read from the API process environment at call time. Set them as global `swarm_config` secrets: the API process loads global rows into `process.env` at boot and on config reload.

- `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`: one is required for any evaluation. Under `auto`, TypeSafe wins when both are set. Without either, every message fails open.
- `SLACK_BOT_TOKEN`: the Slack app's bot token. A swarm with Slack connected already has it. Without it, `enforce` still drops the message but cannot add :mute:, and logs a `mute-error`.

No key is written to config, KV, logs, or a description.

## KV namespace `ext:slack-reply-gate`

- `d:<epochMs>:<channel>_<threadTs>`: one row per decision, with `action` (`pass`, `shadow-skip`, `skipped`, `fail-open`), `provider`, `reason`, `confidence`, `skipP`, `latencyMs`, `sender`, and a 300-character `preview`.
- `m:<epochMs>:<channel>_<threadTs>`: one row per mute attempt, with `action` (`muted`, `mute-error`), `removed`, `added`, and `errors`.
- `last`: the latest decision. Mute rows never overwrite it.
- Counters: `total`, `mention`, `files`, `reply`, `shadow-skip`, `skipped`, `error`, `muted`, `mute-error`, and `reason:<label>`.

## Known limits

- When Lead already has an active task in the thread, the buffer steers that task instead of creating one, so `pre.task.create` does not fire and the gate does not run.
- A blocked flush makes the thread buffer log a `TaskCreationBlockedError`. Nothing is lost: the next follow-up's `<thread_context>` carries the earlier messages.
- A flush of several messages mutes only the triggering (last) message. The others keep their acceptance reaction.
