---
date: 2026-09-08
topic: "Preserve authored page styles in the shared renderer"
status: done
---

# Preserve authored page styles

## Goal

Bake the audited styling correction into the shared HTML renderer. Existing and future pages must retain authored headings, margins, lists, and centering after Tailwind loads.

## Decisions

- Disable injected Tailwind Preflight and retain utilities. This reproduces the improvement Taras selected.
- Preserve basic layout normalization before authored CSS. Keep box sizing, border defaults, responsive media, and inherited control fonts.
- Keep this change focused on rendering. Custom report layouts and palettes remain separate work.
- Verify actual computed styles after a Tailwind utility renders. A string assertion alone cannot detect the original defect.

## Todo

- [x] Correct shared injection and its documentation.
- [x] Add browser regression coverage for authored styles and utilities.
- [x] Run targeted API tests, browser tests, lint, typechecks, and schema freshness generation.
- [x] Inspect both captured production examples with the updated injector.
- [x] Complete independent Standards and Spec reviews.
- [x] Commit the verified implementation.

## Verification

- `bun run test:root -- src/tests/pages-public-html.test.ts`
- `bun run e2e:ui -- --no-build specs/pages.spec.ts`
- `bun run e2e:ui:tsc`
- `bun run lint`
- `bun run tsc:check`
- `bun run docs:openapi`
- `git diff --check`

## Manual E2E

- `bun run e2e:ui -- --headed specs/pages.spec.ts`
- Start the temporary API through the existing test harness on a free port.
- Create public copies of the two captured HTML bodies through that API.
- `agent-browser open http://127.0.0.1:<api-port>/p/<page-id>`
- `agent-browser snapshot`
- `agent-browser screenshot /private/tmp/pages-preserved.png`
- Check heading size, weight, section spacing, centering, and a Tailwind utility after the CDN completes.

## Results

- The browser regression fails against the original renderer on heading size, weight, margins, lists, links, and centering.
- Both page browser tests pass against the corrected renderer with retries disabled.
- The existing authentication check used a configured share origin. It returned 404 against the original renderer too. The test now targets its worker API.
- All five page HTML API tests pass.
- Root lint and typecheck pass. Both UI E2E typechecks pass.
- OpenAPI generation produces no artifact changes. The diff passes whitespace checks.
- The corrected local API renders the tracker title at 22px bold, the schedule title at 52px bold, and the bundled report title at 48px bold.
- The browser checks used real Tailwind CDN output. CDN availability remains a dependency of this rendering path and its regression test.

## Review

- Standards: resolved one Important finding. The regression test now uses a unique slug and deletes its page in `finally`.
- Spec: no findings. The change implements the requested shared correction.
