# Agent avatar Lucide picker QA

## Round 3 (curation fix) — re-run 2026-07-27

Re-ran with `qa-use` (headless, tunneled) against a fresh scratch API +
Vite UI — **with all live integrations explicitly disabled**
(`SLACK_DISABLE=true GITHUB_DISABLE=true JIRA_DISABLE=true LINEAR_DISABLE=true`
and the real Slack/Linear/GitHub secrets unset from the process env first; an
earlier attempt without this booted the full server and briefly opened a live
Slack Socket Mode connection into the production Capchase workspace before
being killed — see shared memory
`local-server-boot-connects-live-slack-integration-2026-07-27`). Registered a
throwaway agent via `POST /api/agents`, connected the dashboard to the
scratch API, and drove the actual `AgentAppearancePicker` popover on that
agent's detail page.

All five original screenshots were refreshed (counts changed with the
curated catalog) and two new ones were added proving the d-z fix:

- [Default shortlist](screenshots/2026-07-27-agent-avatar-lucide-picker/01-default-shortlist.png): an empty query shows the familiar 64 choices (now an explicit list, `wrench` replacing the old accidental `a-arrow-down` 64th slot).
- [Normalized search](screenshots/2026-07-27-agent-avatar-lucide-picker/02-normalized-search.png): `tree deciduous` finds `tree-deciduous` and reports 1 of 1.
- [Result cap](screenshots/2026-07-27-agent-avatar-lucide-picker/03-result-cap.png): broad `a` query now reports **100 of 206** (was 100 of 307 pre-curation — the curated catalog is smaller and cleaner, not alphabetically dominated by `a`-prefixed UI-chrome icons).
- [Persistence](screenshots/2026-07-27-agent-avatar-lucide-picker/04-selection-persisted.png): selecting `tree-deciduous` survives a page reload (visible as the tree icon replacing the default bot icon in the header).
- [Zero result](screenshots/2026-07-27-agent-avatar-lucide-picker/05-zero-results.png): an unmatched query reports 0 of 0.
- **NEW** — [d-z search: `wrench`](screenshots/2026-07-27-agent-avatar-lucide-picker/06-dz-search-wrench.png): reports 1 of 1 and renders a real wrench glyph. Pre-round-3, every d-z query returned "Showing 0 of 0" because the catalog was an a/b/c alphabetical head-slice.
- **NEW** — [d-z search: `gamepad`](screenshots/2026-07-27-agent-avatar-lucide-picker/07-dz-search-gamepad.png): matches `gamepad-2` (labeled "gamepad 2" via the new a11y `aria-label`) via the space/hyphen-insensitive normalizer.
