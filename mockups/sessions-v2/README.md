# Sessions v2: power-user mockups

Three static directions for the new sessions view in `apps/ui/`.
Brainstorm: `thoughts/taras/brainstorms/2026-10-20-sessions-ui-power-users.md`.
Shared spec: [`SPEC.md`](./SPEC.md). Shared data: [`demo-data.js`](./demo-data.js).

No build, no server. Open an option directly.

| Option | File | One-liner |
|---|---|---|
| **A. Mail triage** | [`option-a-mail-triage/index.html`](./option-a-mail-triage/index.html) | Three panes: group tree, dense conversation list, session detail with tabs. |
| **B. Editor workspace** | [`option-b-editor-workspace/index.html`](./option-b-editor-workspace/index.html) | One explorer tree with forks as branches, editor-style session tabs and a split. |
| **C. Channels + threads** (dropped) | [`option-c-channels-threads/index.html`](./option-c-channels-threads/index.html) | Groups as channels, a group feed of conversation cards, the session in a side panel. |
| **A+B merged** (round 10, current) | [`option-ab-merged/index.html`](./option-ab-merged/index.html) | A's sidebar and list, B's session tabs, split, and status bar. No forks, no source chips. |
| **A+B merged, phone** (round 10) | [`option-ab-merged/mobile.html`](./option-ab-merged/mobile.html) | Three interactive phone frames: list screen, then session detail with back navigation, sheets, swipe, and long-press. |

Deep links on every option: `?theme=dark`, `?open=<sessionId>`, `?split=<sessionId>`, `?legacy=1`, `?chips=slack`.

Round 9 UX/UI review findings (the apps/ui checklist): [`UX-REVIEW-R9.md`](./UX-REVIEW-R9.md).

Round 2 drops `?chips=` and adds `?expand=slack`. See the Round 2 section of SPEC.md.
