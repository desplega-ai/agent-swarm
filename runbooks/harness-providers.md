# Harness providers runbook

Operational rules for editing or adding harness providers (claude, pi, codex, devin, future).

**Canonical conceptual reference:** [docs-site/.../guides/harness-providers.mdx](../docs-site/content/docs/(documentation)/guides/harness-providers.mdx). That guide is the source of truth for how the `ProviderAdapter` interface, the runner's poll→spawn→events→finish flow, system-prompt composition, entrypoint credential restoration, and OAuth flows fit together. Read it before non-trivial work.

## Same-PR doc-update rule

Any **observable** change must update the docs-site guide in the **same PR** as the code change. Observable means:

- `ProviderAdapter` interface changes
- Factory dispatch logic
- Adapter event-translation, log format, or abort semantics
- Runner's poll→spawn→events→finish flow
- System-prompt composition (`src/prompts/`)
- `docker-entrypoint.sh` credential restoration
- OAuth flows

Internal refactors that don't change observable behavior don't need a doc update.

## Adding a new provider

1. Read the docs-site guide's "Reference implementations" section to see how `claude`, `pi`, `codex`, and `devin` are wired.
2. Implement the `ProviderAdapter` in `src/providers/<name>/`.
3. Wire factory dispatch in `src/commands/runner.ts`.
4. Branch in `docker-entrypoint.sh` for credential restoration if the provider needs auth files.
5. Update the docs-site guide:
   - Add to "Reference implementations" table.
   - Add to "Files to touch" checklist.
6. Add the new provider to `README.md`'s multi-provider bullet.
7. Verify the docs build per [docs-site/CLAUDE.md](../docs-site/CLAUDE.md).

## Trigger paths

This runbook applies when modifying:

- `src/providers/*`
- `src/commands/runner.ts` (provider dispatch)
- `src/prompts/*` (system-prompt composition)
- `docker-entrypoint.sh` (provider branches)
- Or adding a new provider end-to-end
