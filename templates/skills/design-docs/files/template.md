---
system: [system-slug]
status: living
created: [YYYY-MM-DD]
last_amended: [YYYY-MM-DD]
owners: [username|shared]
---

# [System Name] — Design

## Purpose

[One paragraph: what this system is for and for whom.]

## Glossary

| Term | Meaning | Avoid |
|------|---------|-------|
| [term] | [one-line definition, no implementation detail] | [misused aliases, if any] |

## Invariants

- **I1.** [Testable statement — a reviewer can answer "does this diff hold it?" yes/no]
- **I2.** [...]

## Boundaries & Non-goals

- [What this system explicitly does NOT do]
- **Rejected:** [scope that was considered and rejected] — [reason]

## Interfaces / Seams

- [Other system] → [how it touches this one, names and responsibilities only]

## Decision log

### [YYYY-MM-DD] [Decision title]
[One paragraph: context → decision → consequence. Only hard-to-reverse, surprising, or trade-off decisions.]

## Amendment log

- [YYYY-MM-DD] Created. ([plan/session ref])
