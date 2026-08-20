---
date: 2026-08-20T18:43:22Z
topic: "Slack channel lifecycle primitives"
status: done
---

# Slack channel lifecycle primitives

## Goal

Add lead-gated MCP capabilities to create, invite users to, and archive Slack channels through public Slack APIs, with normalized channel names, explicit platform-error handling, complete registration, scopes, documentation, and focused tests.

## Decisions

- Keep lifecycle API calls in one `src/slack/channel-lifecycle.ts` module and tool registrars in three focused files, matching existing Slack boundaries and avoiding new abstractions (assumed).
- Use `channels:manage` and `groups:write`; Slack's current bot-token method references list both as valid scopes for the requested public/private operations (verified).
- Add one RBAC verb per mutating capability so permissions remain explicit and independently auditable (assumed).
- Ship capability only; do not connect these tools to task lifecycle policy or the deprecated assistant API migration (requested).

## Todo

- [x] Implement normalized lifecycle helpers and Slack-specific error handling.
- [x] Add lead-gated MCP tools, RBAC verbs, server/config/runtime registrations.
- [x] Update Slack manifest and deployment scopes.
- [x] Add helper, authorization, registration, annotation, and error-path tests.
- [x] Run focused and repository verification gates.
- [x] Review the diff and fix material findings.

## Verification

- `rm -f test-*.sqlite test-*.sqlite-wal test-*.sqlite-shm`
- `bun install --frozen-lockfile`
- `bun run lint:fix`
- `bun run tsc:check`
- `bun run test:root -- src/tests/slack-channel-lifecycle.test.ts`
- `bun run test:root -- src/tests/rbac-charact-slack.test.ts`
- `bun run test:root -- src/tests/tool-annotations.test.ts`
- `bun run test:root -- src/tests/rbac-engine.test.ts`
- `bun run scripts/check-sdk-tool-registration.ts`
- `bun run test:root -- src/tests/sdk-allowlist.test.ts`
- `bun run check:script-types`
- `bun test src/tests/script-connections.test.ts` (standing waiver only for the known single failure at line 1210)
