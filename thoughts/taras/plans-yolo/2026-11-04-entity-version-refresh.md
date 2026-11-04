---
date: 2026-11-04
topic: "Entity version refresh"
status: in-progress
---

# Entity version refresh

## Goal
Show new entity versions in open dashboard views, including pages, workflows, Comb files, and apps.

## Decisions
- Taras approved the implementation plan and commits after verified phases.
- Automatic reload defaults to off. The preference is local to the browser and deployment.
- Hold an update after interaction until the viewer chooses to apply it.
- Comb text and media keep their existing live path. HTML preview can interrupt interaction and needs a notice.
- App runtime state stays in the dashboard-global store. Borrowed definitions need the same refresh gate as the host definition.

## Todo
- [x] Audit version sources and add the shared preference and notice.
- [x] Implement page, workflow, app, and Comb HTML preview refresh gates.
- [ ] Complete the code review and fix its findings.
- [ ] Verify protected pages, external workflow and app updates, and Comb HTML with a real backend.
- [ ] Run the implementation plan checks and commit each verified phase.

## Verification
- `cd apps/ui && bunx tsc -b`
- `cd apps/ui && bun run lint`
- `cd apps/ui && bun run check:tokens`
- `bun test apps/ui/src/api/hooks/use-workflows.test.tsx apps/ui/src/hooks/use-versioned-app-references.test.tsx apps/ui/src/hooks/use-versioned-value.test.tsx apps/ui/src/hooks/use-sessions-view.test.tsx`
- `bun run e2e:ui`
- Browser: external page HTML writes showed a notice and manual apply. Automatic reload applied an external update.
- The full UI suite passed before the last changes: 113 passed and 28 skipped.
- Review found workflow cache normalization and cross-workflow draft issues. Both fixes need verification in the final review.
