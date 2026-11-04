---
id: step-17
name: "Connect › AI providers: System One, Embeddings, Transcription tabs"
track: C
depends_on: [step-7]
status: claimed
assignee: po-orch-step-17
claimed_at: 2026-11-04T16:59:57Z
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-17: Connect › AI providers: System One, Embeddings, Transcription tabs

> Design reference (approved 2026-11-04): `mockups/post-onboarding/r5-ai-providers.html` (states 4-6). Decisions: `root.md § Design decisions (step-16)`, "Round 5 decisions".

## Overview
The three remaining AI providers tabs make every AI credential the swarm uses live in one place. **System One** lists the typed decision and extraction hosts (Jev via TypeSafe, Jev via OpenRouter, Clef via Cloudflare, laya, OpenAI), which capability each serves, whether its credential is set, and two default selectors: decide (existing `SYSTEM_ONE_DEFAULT_PROVIDER`) and extract (new `SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER`). **Embeddings** shows the memory embeddings provider, model, dimensions and status, with a "Change provider" side panel. **Transcription** shows the transcription provider, model and status, with the same panel. All three reuse step-7's side panel. After this step, an admin sets the extract default to another host from the System One tab and the next extraction uses it.

## Changes Required:

#### 1. New config key `SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER`
**Files**: `src/workflows/executors/system-one-providers.ts:285-342`, the extraction executor that reads the default (`src/workflows/executors/system-one-extraction.ts`), `src/be/swarm-config-guard.ts:179-188, 467`, `apps/ui/src/lib/configuration-catalog.ts` (next to `SYSTEM_ONE_DEFAULT_PROVIDER`, `:1621`), `docs-site/content/docs/(documentation)/ui/configuration.mdx`
**Changes**: Mirror the decide default: `SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER_CONFIG_KEY`, a resolver that reads the global `swarm_config` row, then env, then falls back to `SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER` (`cloudflare`). Validator `enumValidator("SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER", [...SYSTEM_ONE_EXTRACT_PROVIDER_IDS])`. Catalog entry in the Workflows group with a plain description. A call or node that names its extract provider keeps it.

#### 2. System One tab
**File**: `apps/ui/src/pages/connect-pages/ai-system-one-tab.tsx` (new)
**Changes**: One line of copy: "Fast typed decisions and extraction in workflows and gates." Rows per host from a UI mirror of `SYSTEM_ONE_HOSTS` (id, label, capabilities, credential keys, default model): status from `useEnvPresence` / `useConfigs` for the credential keys (e.g. `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, `OPENAI_API_KEY`). Two selectors (decide, extract) write the global config keys through `useUpsertConfigsBatch`. "Set up" opens step-7's side panel with the host's fields. A unit test guards the mirror against `SYSTEM_ONE_HOSTS` drift (compare ids and capabilities through a generated JSON or a shared constant under `src/workflows` that the UI may import if it is pure data; otherwise a test in `src/tests` that reads both).

#### 3. Embeddings tab
**Files**: `apps/ui/src/pages/connect-pages/ai-embeddings-tab.tsx` (new), the `memory-embeddings` special flow in `apps/ui/src/components/integrations/special-flows.tsx`, `apps/ui/src/pages/setup/steps/step-memory.tsx` (`PRESETS`)
**Changes**: Current provider, model, dimensions, status and the re-embed note. "Change provider" opens the side panel with the presets (OpenAI, OpenRouter, Vercel, Azure / Microsoft Foundry, Custom) and reuses the existing save path of the special flow. `/integrations/memory` (the old detail page) links here.

#### 4. Transcription tab
**Files**: `apps/ui/src/pages/connect-pages/ai-transcription-tab.tsx` (new), the `transcription` special flow, `transcription-status.ts`
**Changes**: Current provider (ElevenLabs, OpenAI, Groq), model, status; "Change provider" side panel reusing the special flow's save path. `/integrations/transcription` links here.

#### 5. Tests
**Files**: `src/tests/workflow-system-one-decision-providers.test.ts` and `src/tests/workflow-system-one-extraction.test.ts` (extend), `src/tests/swarm-config-schema.test.ts` (extend, validator), `apps/ui/src/pages/connect-pages/ai-*-tab.test.tsx` (new), `scripts/e2e/scenarios/` System One scenario (extend the existing one that covers `system-one-extract`)
**Changes**: Extract default resolution order (row, env, fallback); validator rejects unknown ids; a node that names a provider ignores the default; UI selectors write the right keys; embeddings and transcription tabs render current state and open the panel.

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- $(rg -l "SYSTEM_ONE_DEFAULT_PROVIDER|system-one-extract" src/tests | tr '\n' ' ')`
- [x] `bun run e2e --strict`
- [x] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- ai-system-one ai-embeddings ai-transcription`
- [x] `bun run check:local && bun run tsc:check:tsc`

#### Automated QA:
- [x] `PUT /api/config` with `SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER=<another extract host>` (if only `cloudflare` serves extract today, assert the validator rejects `openai` with a 400 and accepts `cloudflare`); an extraction node with no provider uses the configured host (black-box scenario with the mocked edge).
- [x] `AGENT_BROWSER_SESSION=po-step17`: screenshots of the three tabs next to `mockups/post-onboarding/shots/r5-ai-providers-1440-light.png`; change the decide default in the UI and confirm `GET /api/config?scope=global` shows it.
- [x] Open "Change provider" on Embeddings: the panel lists the presets; cancel leaves config untouched.

#### Manual Verification:
- [ ] Taras reads the System One copy line once.

**Implementation Note**: This step is a vertical slice, QA-able on its own. Backend key to Codex `gpt-6.1-sol` (medium), tabs to Opus. After completing this step, pause for manual confirmation. Commit as `[step-17] Connect › AI providers: System One, Embeddings, Transcription` after verification passes. Frontend PR: screenshots in `## Before / after`.

## Implementation notes

Commit `0238acbb1` on `po/step-17`.

- **Backend (Codex `gpt-6.1-sol`, medium).** `resolveSystemOneExtractDefaultProvider` (row, env, `cloudflare`). The extraction schema's `provider` is now optional and resolves at run time and in readiness, as the decision node does. Save-time model and limit checks use the `cloudflare` constant, because it is the only extract host. Validator `SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER_OPTIONS = ["cloudflare"]`. Its tests live in `workflow-system-one-extraction.test.ts`, not in the decision-providers or schema test files.
- **Verification.** apps/ui has no `test` script. The tab tests ran as `bun test ai-system-one ai-embeddings ai-transcription` (12 pass), and together with the step-7 tests (46 pass). The first `bun run e2e --strict` run failed `invites` and `slack-mention`. Both passed alone, and the full strict rerun passed 100/100. These two flows are unrelated to this step, so the first failure was a flake under load.
- **Mirror.** `apps/ui/src/lib/system-one-hosts.ts` is pure data. `src/tests/system-one-hosts-ui-mirror.test.ts` compares its ids, key names, fallbacks, config keys and models with `SYSTEM_ONE_HOSTS`, and its default keys with the server constants.
- **Credential state.** OpenRouter is read from env presence (the server reads its env pool). Every other host is read from its global config row, because the executor reads only the row. A host with some keys set shows "Incomplete" and names the missing key.
- **Panels.** The System One hosts are `AiProvider` entries in `SYSTEM_ONE_SETUP` (`?add=system-one-<host>`). They are not in the Add menu. OpenRouter's row opens the LLMs `openrouter` panel. `AiProvider` gained `type: "System One"`, an optional `footer`, and the `cloud` logo. Embeddings (`?add=embeddings`) mounts `MemoryEmbeddingsSection`, the same form and test-and-save probe as `/setup`. Transcription (`?add=transcription`) writes through `useUpsertConfigsBatch`. Auto-detect deletes the `TRANSCRIPTION_PROVIDER` row.
- **Data the API lacks (hidden, no tags).** The embeddings "last test" time and latency, and "Memory works", need a stored probe result: the tab shows On or Off from `signals.embeddings.configured`. The "Add credential" dropdown on System One is left out, because the row buttons cover it. "Advanced: edit the stored values" is an "All settings" link to the old detail pages.
- **Links.** The back link on `/integrations/memory` and `/integrations/transcription` goes to `/integrations/ai?tab=embeddings|transcription`.
- **Test helper.** `connect-pages/ai-tabs-test-dom.tsx` takes the `bun:test` hooks as an argument, because the file is in the app `tsc -b` program, which has no `bun:test` types.

