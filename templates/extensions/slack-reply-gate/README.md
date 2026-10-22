# slack-reply-gate

Lead is woken by every human message in a Slack thread the swarm takes part in, including "lol", an emoji, or two people chatting with each other. This extension asks a SystemOne decision model, Jev ([TypeSafe](https://typesafe.ai)) or Clef (Cloudflare Workers AI), whether Lead should answer a new thread message, and drops the wake-up when it should not.

Install config:

```json
{ "mode": "shadow" }
```

Start in `shadow`, read the decisions in KV for a few days, then switch to `enforce`.

## Modes

| `mode` | Effect |
|---|---|
| `off` | Never evaluates. |
| `shadow` (default) | Asks the model and records the verdict. Never blocks. |
| `enforce` | Asks the model, records the verdict, and blocks the Lead task when the answer is no. The message gets :mute: instead: no Lead task, no reply, no outcome card. |

## What it gates

Hook: `pre.task.create`, for tasks with origin `slack` whose description carries the thread buffer's header `[Thread follow-up — N message(s) buffered]`. Those are the non-mention thread replies that `src/slack/thread-buffer.ts` batches into a Lead task. A direct @mention of the bot creates a task without that header and is never gated.

The header counts only at the start of the description or right after the closing `</thread_context>`. Thread context quotes old messages verbatim, and an older Lead reply can quote the header itself, so a header inside the context is ignored. Only the text after the real header is treated as new.

## Decision

1. A follow-up with downloaded files (status `draft`) passes without a decision call.
2. **@mention pass-through.** A new message that @mentions Lead passes without a decision call. A mention is the bot mention the engine rewrites to `<@U…> (that's you)`, a resolved `<@U…|lead>`, or a literal `@lead` (any name in `leadAliases`). Only the new messages are scanned, never the thread context, so an old mention earlier in the thread does not pass later banter.
3. Otherwise one decision call (one `choice` question, see [Provider](#provider)) with the new message(s), the sender kind, and the last `contextMessages` thread messages. Labels: `direct_ask`, `followup_to_lead`, `instruction_to_lead`, `reaction_only`, `banter_between_others`, `not_addressed_to_lead`, `other`.
4. The answer is no only when the top label is `reaction_only`, `banter_between_others`, or `not_addressed_to_lead`, and the summed probability of those three labels is at least `minConfidence`. A split between two skip labels is still a skip. An unsure verdict replies.

Several buffered messages are judged together. One mention in any of them passes the batch.

## Provider

The decision is made on the API server by the `system-one-decide` tool (`ctx.swarm.systemOne_decide`), the same path a `system-one-decision` workflow node takes. The server reads the provider's credential, sends the request, and validates the answer, so every SystemOne host works and no key enters the hook.

| `provider` | Model | Credential |
|---|---|---|
| `typesafe` | Jev, `model` (default `jev-latest`) | `TYPESAFE_API_KEY` |
| `openrouter` | Jev, `openrouterModel` (default `typesafe/jev-1.13`) | `OPENROUTER_API_KEY` |
| `cloudflare` | Clef, `cloudflareModel` (default `clef`, or `clef-flash`) | `CLOUDFLARE_API_TOKEN` (or `CLOUDFLARE_API_KEY`) and `CLOUDFLARE_ACCOUNT_ID` |
| `laya`, `openai` | The host's default model | See the workflows guide |
| `auto` (default) | The first of typesafe, openrouter, cloudflare whose credential is set. A provider the server refuses for a deployment setting (openrouter when `OPENROUTER_BASE_URL` points at a gateway) is skipped for the next one | |

With no credential for `auto`, every message fails open and the KV row names the secrets. Each decision row records the `provider` that answered. `minConfidence` was tuned on Jev; check Clef's verdicts in `shadow` before you enforce on it.

## Fail open

Every error lets the task through: a missing key, a provider error relayed by the server, a network error, a timeout, a malformed answer, or an unknown label. The handler never throws, so an outage cannot auto-disable the extension. Each failure is recorded as `fail-open` in KV and logged as a warning.

## :mute: on drop (enforce)

No swarm tool or extension `ctx` method adds a Slack reaction, so the hook calls the Slack Web API with the bot token. It needs the `reactions:write` scope, which the Slack app already uses for its acceptance reactions.

1. `reactions.remove` for each acceptance reaction the engine may have put on the triggering message: `eyes`, `heavy_plus_sign`, `zap`, `speech_balloon`, or their `SLACK_REACTION_ACCEPTED`, `SLACK_REACTION_BUFFERED`, `SLACK_REACTION_NOW`, and `SLACK_REACTION_STEERED` overrides. Slack only removes the bot's own reaction, so a human's :eyes: stays.
2. `reactions.add` with `muteReaction` (default `mute`). `already_reacted` counts as success. Skipped when `muteReaction` is `""`.

The block returns first and the Slack calls run after it. A slow or failing Slack call never delays the drop or turns it back into a task. Set `muteReaction` to `""` for a true no-op: step 1 still clears the bot's acceptance reaction(s), and nothing is added.

## Config

| Key | Default | Notes |
|---|---|---|
| `mode` | `shadow` | `off`, `shadow`, or `enforce` |
| `timeoutMs` | `3000` | Decision call timeout, capped at 4000 (the dispatcher cancels a handler at 5 s) |
| `provider` | `auto` | `auto`, `typesafe`, `openrouter`, `cloudflare`, `laya`, or `openai`. See [Provider](#provider) |
| `model` | `jev-latest` | Jev model on TypeSafe |
| `openrouterModel` | `typesafe/jev-1.13` | Jev model on OpenRouter |
| `cloudflareModel` | `clef` | Clef model on Cloudflare Workers AI |
| `minConfidence` | `0.55` | Minimum summed skip probability to skip |
| `contextMessages` | `6` | Thread messages sent to the model, 0 to 20 |
| `leadAliases` | `["lead"]` | A literal `@alias` in a new message counts as a mention |
| `botSlackUserIds` | `[]` | Slack user ids labelled `bot` as the sender for the model |
| `muteReaction` | `mute` | Reaction for a dropped message; `""` only removes the acceptance reaction(s) |
| `slackTimeoutMs` | `5000` | Timeout per Slack call |

## Required secrets

Set them as global `swarm_config` values. The server reads the provider credential from the global row when it makes the decision. `auto` and the Slack token read the API process environment, which loads global rows at boot and on config reload.

- One provider credential from the [Provider](#provider) table is required for any evaluation. Without one, every message fails open. The `apiKey` config field of earlier versions is gone: the hook never holds a key, so store it as the global `TYPESAFE_API_KEY` secret.
- `SLACK_BOT_TOKEN`: the Slack app's bot token. A swarm with Slack connected already has it. Without it, `enforce` still drops the message but cannot touch its reactions, and logs a `mute-error`.

No key is written to config, KV, logs, or a description.

## KV namespace `ext:slack-reply-gate`

- `d:<epochMs>:<channel>_<threadTs>`: one row per decision, with `action` (`pass`, `shadow-skip`, `skipped`, `fail-open`), `provider`, `reason`, `confidence`, `skipP`, `latencyMs`, `sender`, and a 300-character `preview`.
- `m:<epochMs>:<channel>_<threadTs>`: one row per mute attempt, with `action` (`muted`, `unreacted` when `muteReaction` is `""`, `mute-error`), `removed`, `added`, and `errors`.
- `last`: the latest decision. Mute rows never overwrite it.
- Counters: `total`, `mention`, `files`, `reply`, `shadow-skip`, `skipped`, `error`, `muted`, `unreacted`, `mute-error`, and `reason:<label>`.

## Known limits

- When Lead already has an active task in the thread, the buffer steers that task instead of creating one, so `pre.task.create` does not fire and the gate does not run.
- A blocked flush makes the thread buffer log a `TaskCreationBlockedError`. Nothing is lost: the next follow-up's `<thread_context>` carries the earlier messages.
- A flush of several messages mutes only the triggering (last) message. The others keep their acceptance reaction.
