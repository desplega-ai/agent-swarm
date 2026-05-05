---
date: 2026-05-05
category: patterns
topic: "Hand-rolled validators need subset docs at every authoring surface"
project: "agent-swarm"
author: "taras"
tags: [workflows, validation, json-schema, authoring, silent-failure]
promoted_to: null
---

# Hand-rolled validators need subset docs at every authoring surface

## Insight

When a project ships a **hand-rolled** schema validator that supports only a subset of a well-known spec (e.g. `src/workflows/json-schema-validator.ts` implementing only `type` / `required` / `properties` / `enum` / `const` from JSON Schema), the unsupported keywords don't error — they're silently ignored. That creates a silent drift between user/agent intent and runtime behavior: a `triggerSchema` with `oneOf`, `$ref`, `pattern`, `format`, `additionalProperties`, or array `items` will compile, persist, and validate "successfully" while doing none of the work the author expected.

The mitigation isn't documenting the subset *once* in the validator file — nobody reading a tool description, a runbook example, or a UI editor placeholder will dig into the validator implementation. Instead, document the supported subset **at every authoring surface**:

- Every MCP tool that accepts the schema (`description` field — agents read this to decide what's valid).
- Every runbook section that mentions the schema (humans copy from these).
- Every UI helper text near the editor (FE users author here directly).
- Every API doc snippet for the relevant routes (external integrators copy from these).

Treat "what does the validator actually support" as a piece of contract that has to ship redundantly with every authoring path, not as an implementation detail.

## Context

Discovered while planning `triggerSchema` end-to-end coverage in agent-swarm (research: `thoughts/taras/research/2026-05-05-workflow-triggerschema-coverage.md`). The validator at `src/workflows/json-schema-validator.ts` is intentionally minimal but the file-level comment is the only place the subset is called out; meanwhile the field is exposed via HTTP, MCP, and (soon) the FE. Without redundant documentation, agents authoring a `triggerSchema` via `mcp:create-workflow` will reasonably reach for `format: "uri"` or `oneOf: [...]` and get silent acceptance + zero validation.

This pattern likely applies any time a project trades a full-spec dependency for a handwritten subset: regex engines, query-language parsers, expression evaluators, template engines.

## Related

- Plan: `thoughts/taras/plans/2026-05-05-workflow-triggerschema-coverage.md` (Phases 1, 2, 6 each restate the subset)
- Validator: `src/workflows/json-schema-validator.ts:1-10`
- Research: `thoughts/taras/research/2026-05-05-workflow-triggerschema-coverage.md` § 3 (Runtime validation) and follow-up #1
