---
date: 2026-05-11T23:50:20+02:00
author: taras
topic: "Agent model control and latest-used model surfacing"
tags: [brainstorm, agents, harnesses, models, credentials, ui]
status: in-progress
exploration_type: idea
last_updated: 2026-05-11
last_updated_by: taras
---

# Agent model control and latest-used model surfacing — Brainstorm

## Context

We want to explore a way to control and change the models used by agents, and surface the latest used model in the agents list. One proposed UI hook is the existing `credStatus` field, which may be usable for compact status metadata in the list.

Initial direction from `../agent-swarm-internal`: follow its mental model where a harness is the agent CLI runtime, such as `claude-code`, `codex`, `pi`, or `opencode`. Each agent first picks a harness, then a model. The model picker is harness-aware because different harnesses expose different model lists, model ID formats, and credential gates.

Known internal reference model:

- Direct-provider harnesses, such as `claude-code` and `codex`, talk straight to Anthropic/OpenAI APIs. They use curated, hand-maintained model lists with bare IDs because the CLI `--model` flag rejects `<provider>/<id>` prefixes.
- Multiplexed harnesses, such as `pi` and `opencode`, route via any of OpenRouter, Anthropic, or OpenAI. They use a `models.dev` snapshot filtered by providers the user can reach. Their model IDs use `<provider>/<id>` format.
- Harness unlock logic is based on required-env OR-groups:
  - `claude-code`: Anthropic key or Claude OAuth.
  - `codex`: OpenAI key or Codex OAuth.
  - `pi` / `opencode`: OpenRouter, Anthropic, or OpenAI.
- AI Wallet top-up synthesizes `OPENROUTER_API_KEY`, which unlocks `pi` and `opencode` only. Direct-provider harnesses are wallet-blind.
- BYO credentials and Wallet are additive; user-saved key overrides wallet for the matching harness.
- UI harness ID maps to runtime env through `HARNESS_PROVIDER_VALUE`; only `claude-code` rewrites to bare `claude`.
- For `pi` plus OpenRouter auth, model gets re-prefixed as `openrouter/<model>` because PI expects qualified IDs when using OpenRouter.

Relevant internal file pointers to compare during research:

- `apps/web/lib/onboarding/harnessModels.ts`: source of truth for harness list, model groups, fallback chains, grouping, default selection, enabled harnesses, `HARNESS_PROVIDER_VALUE`.
- `apps/web/lib/onboarding/modelsdev-cache.json`: `models.dev` snapshot for `pi` and `opencode`.
- `apps/web/scripts/refresh-modelsdev.ts`: refresh script for the snapshot.
- `apps/web/components/onboarding/v4/harness-selector.tsx`: chip-style harness popover.
- `apps/web/components/onboarding/v4/model-picker.tsx`: searchable, harness-aware model popover.
- `apps/web/components/onboarding/v4/roster-accordion.tsx`, `right-rail.tsx`, `describe-team.tsx`: per-agent hosting surfaces.
- `apps/web/components/onboarding/ai-providers-modal.tsx`: BYO key entry.
- `packages/backend/convex/schema/onboarding.ts`: persisted harness and model fields.
- `packages/backend/convex/onboarding/lib/buildDeployConfig.ts`: translates progress into `MODEL_OVERRIDE` and harness env; applies `openrouter/` prefix for `pi` plus OpenRouter.
- Current repo runtime mirrors mentioned by internal code:
  - `agent-swarm/src/providers/claude-managed-models.ts`
  - `agent-swarm/src/providers/codex-models.ts`
  - `agent-swarm/src/providers/pi-mono-adapter.ts`
  - `agent-swarm/src/providers/opencode-adapter.ts`

## Exploration

### Q: What kind of exploration is this?

Idea to develop.

**Insights:** The target is not just a picker. It spans persisted agent configuration, provider-specific model ID rules, credential-gated availability, runtime dispatch, and a compact UI signal for "what did this agent most recently use?"

## Synthesis

### Key Decisions
- To be filled after exploration.

### Open Questions
- To be filled after exploration.

### Constraints Identified
- To be filled after exploration.

### Core Requirements
- To be filled after exploration.

## Next Steps

- To be decided after synthesis.
