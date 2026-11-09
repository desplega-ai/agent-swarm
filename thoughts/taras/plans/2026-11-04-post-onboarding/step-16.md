---
id: step-16
name: "UI spike: mockup variants (rounds 1-5, decided)"
track: C
depends_on: []
status: done
completed_at: 2026-11-04
completed_in: plan session (mockup rounds 1-5, decisions in root.md)
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-16: UI spike: mockup variants for sidebar, Connect hub, group header, Home

## Overview
Before any navigation or Home code changes, produce zero-dependency HTML mockups with 2 to 3 variants for each of the four new surfaces, open them for Taras, and record his picks in `root.md § Design decisions`. This is the same loop used for the Session Logs redesign (`mockups/session-logs/`) and onboarding (`mockups/onboarding/`). Steps 5, 6, 7, 8, 10 and 15 build the picked variants. After this step, `mockups/post-onboarding/index.html` lists every variant with a one-line rationale, and `root.md` names the winners.

Requested by Taras in the plan review (2026-11-04): "we need to do a UI spike with variants as we did in the past with other UI changes".

## Changes Required:

#### 1. Mockup set
**Files**: `mockups/post-onboarding/index.html` (new), `mockups/post-onboarding/sidebar-{a,b,c}.html`, `connect-hub-{a,b}.html`, `group-header-{a,b,c}.html`, `home-{a,b}.html` (new), `mockups/index.html` (add a link)
**Changes**: Plain HTML + CSS, dashboard tokens copied from `apps/ui/src/styles/globals.css` (the token file `apps/ui/DESIGN.md` points at), light and dark via `data-theme`. Realistic content: the competitor-research use case, three outputs, one pending approval, three checklist items. Variants to cover:
- **Sidebar**: (a) WORK / CONNECT / BUILD as decided in the brainstorm, BUILD collapsed; (b) WORK / BUILD only, Connect as a footer entry next to Settings; (c) WORK only expanded, BUILD and CONNECT as icon rows. Each with the icon-collapsed and phone-sheet states.
- **Connect hub**: (a) three tabs (Channels, Tools, AI providers) with Advanced as a link; (b) one long page with three sections and a sticky section nav. Both show one card per provider and the Script connections / MCP sub-sections.
- **Group header** (`/sessions?view=<key>`): (a) two panels side by side (schedule, outputs) with the chat box below, per the step-10 sketch; (b) one compact strip (next run · Run now · 3 outputs · chat icon) that expands on click; (c) a right rail with schedule and outputs beside the list, chat box at the bottom of the list. Each with the phone state.
- **Home**: (a) two columns on desktop (Needs you + In progress left, checklist + Favorites right, timeline below); (b) single column ordered Needs you, checklist, In progress, Favorites, timeline. Both with the all-done collapsed checklist and the admin-only `DashboardNudges` banner.

#### 2. Review loop
**Changes**: Open `mockups/post-onboarding/index.html` with `agent-browser` for screenshots (`AGENT_BROWSER_SESSION=po-step16`), then hand Taras the file path (T3 files viewer) or `file-review`. Iterate on his comments in place. Append the picks to `root.md` under a new `## Design decisions (step-16)` section: one line per surface, variant letter, and any tweaks. Steps 5, 6, 7, 8, 10 and 15 read that section.

#### 3. No product code
**Changes**: Nothing under `apps/ui/src` changes in this step. No React. The mockups are throwaway reference material.

### Success Criteria:

#### Automated Verification:
- [ ] `ls mockups/post-onboarding/*.html | wc -l` is at least 11 (index + 10 variants)
- [ ] `for f in mockups/post-onboarding/*.html; do bunx html-validate "$f"; done` (or `bunx htmlhint`) reports no errors
- [ ] `git diff --stat -- apps/ui/src` is empty for this step
- [ ] `rg -n "## Design decisions \(step-16\)" thoughts/taras/plans/2026-11-04-post-onboarding/root.md` finds the section with one line per surface (sidebar, connect hub, group header, home)

#### Automated QA:
- [ ] `AGENT_BROWSER_SESSION=po-step16`: open each variant file, screenshot at 1440 and 390 wide, light and dark (`/tmp/po-step16-<name>-<w>-<theme>.png`), and embed the screenshots in `mockups/post-onboarding/index.html` as a contact sheet so Taras can compare without clicking through.
- [ ] Every variant page loads with no console errors (agent-browser console capture).

#### Manual Verification:
- [ ] Taras picks one variant per surface (four decisions) and notes tweaks. Recorded in `root.md § Design decisions (step-16)`.

**Implementation Note**: This step is a vertical slice (reviewable artifacts, a recorded decision). Mockup building routes to Opus (taste). After completing this step, pause for Taras's picks; step-5, step-10 and step-15 must not be claimed before the decisions section exists. Commit as `[step-16] UI spike: mockup variants` after the picks are recorded.
