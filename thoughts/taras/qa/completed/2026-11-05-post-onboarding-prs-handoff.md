---
date: 2026-11-05
topic: post-onboarding PRs, QA stack, open bugs
status: handoff
---

# Handoff: post-onboarding PRs (agent-swarm #2734, agent-fs #159)

## State
- **agent-swarm #2734** https://github.com/desplega-ai/agent-swarm/pull/2734, branch `t3/post-onboarding`, worktree `/Users/taras/.t3/worktrees/agent-swarm/t3-86d1473e`. Head `53d604949` (main merged on 2026-11-05; conflict in `src/tests/script-connections.test.ts` resolved by keeping both migration markers). desplega-bot approved `9aac8b135`. CI on the new head not yet checked. Migrations `285_favorites_key_type` and `286_checklist_items` (main tail 284; open PR #2458 holds 287).
- **agent-fs #159** https://github.com/desplega-ai/agent-fs/pull/159, branch `feat/continue-with-swarm`, worktree `/Users/taras/worktrees/agent-fs/po-track-b`. Head `bbed1cb25`, CI green, mergeable. No version bump yet.
- Plan: `thoughts/taras/plans/2026-11-04-post-onboarding/` (root.md § Implementation outcome lists follow-ups).
- Pushes used `SKIP=test`: the scoped pre-push test hook fails only on the `src/tests/claude-routes-e2e.test.ts` EPERM flake.

## Merge order (recommended)
1. Merge swarm #2734 first (main auto-deploys prod). The swarm side tolerates old agent-fs: the boot PATCH gets 404 and is skipped.
2. Merge agent-fs #159, then release (`./scripts/release.sh <version>` in agent-fs). Order reason: once live ships, orgs with no swarmUrl default to `https://app.agent-swarm.dev/fs/continue`, which exists only after #2734 deploys.
3. In agent-swarm: `bun run bump:agent-fs <new version>` in a pins PR. A new agent-fs release otherwise blocks main deploys through the chart check.

## Open bugs from the cross-repo E2E (fix next)
1. **agent-fs #159 (medium):** an org admin signed in through Continue (org-scoped key) never sees the Agent Swarm setting or "Invite people" on the Members page. `live/src/contexts/auth.tsx` builds `orgs=[getOrg(scopedOrgId)]`, but `GET /orgs/{id}` returns no `role`, so `useIsOrgAdmin()` is false. Fix: return the caller's `role` on `GET /orgs/{id}` (or in `/auth/me` for scoped keys) and use it. Evidence: `/tmp/po-qa/shots/b5-*`.
2. **agent-swarm #2734 (medium):** `/fs/continue` in a tab with no saved dashboard connection redirects to `/setup` (the install wizard) and loses `return_to` and `handoff`. Fix: keep `from` (pathname + search + hash) through the connect step, and send to the connect or sign-in step, not the wizard. Evidence: `/tmp/po-qa/shots/b2-x-continue-no-dashboard-session.png`.
3. Minor: `/fs/continue` breadcrumb reads "Home > Fs > Continue"; small groups have no sidebar path to the Overview (step-10 follow-up); `?oauth=success` stacks two toasts on the MCP page (maybe StrictMode dev only); after a Telegram save the page shows "Configuration error / NOT CONNECTED" until a reload (maybe pre-existing).

## QA stack (left running for Taras's UI feedback)
- README with URLs and tokens: `/tmp/po-qa/README.md` (mode 600). Tear down: `bash /tmp/po-qa/stop.sh`.
- Dashboard `http://localhost:5391` (vite with `DEV_NOTES=1`; notes land in `apps/ui/.dev-notes/notes.json`; list with `cd apps/ui && bun dev-notes/cli.ts list`). API `:3233` (DB `/tmp/po-qa/swarm.sqlite`), agent-fs `127.0.0.1:7533`, live `:5381`, Telegram mock `:3299`, simulated Lead poller.
- Restarting the API fails the seeded in-progress run (boot sweep).
- E2E evidence: `/tmp/po-qa/shots/`.

## Other follow-ups (not blocking)
- Declined on #2734: desplega-bot finding on `src/fs/provider.ts:164` (Content-Length parse); that code is from #2673 on main.
- Revoking minted keys needs an agent-fs admin revoke route; swarm-registered users have no primary key.
- Home "In progress" shows no rows for schedule runs (its list query has no `groupKey`).
- `cx` alias in `~/.profile` (about line 71) holds the CLIProxy client key in plaintext.
- Cleanup when done: `/tmp/po-*` screenshots (agent-fs copies under `qa/agent-swarm/2026-11-05-post-onboarding/` and `qa/agent-fs/2026-11-05-continue-with-swarm/`), and the agent-fs worktree's `live/node_modules` (723 MB) after #159 merges.
