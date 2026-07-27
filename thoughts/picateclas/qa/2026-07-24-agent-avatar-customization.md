# QA: Customizable agent avatar (icon + color)

Verified live against a scratch API server (`DATABASE_PATH=/tmp` fresh SQLite, migration 119 applied) and a `vite` dev server for `apps/ui` proxying to it — two agents registered (`Lead`, `Picateclas`), no seed data reused from any real deployment.

## Flow verified

1. **Deterministic fallback (unset avatar)** — agents list and detail page render the existing hash-derived icon/color; Lead renders the crown. `01`, `02`, `11`.
2. **Edit mode + Appearance picker** — clicking the avatar disc in edit mode opens a popover with the icon catalog grid (scrollable), 8 suggested swatches, native color input, free hex text input, and a "Reset to default" button. `03`, `04`.
3. **Icon pick** — clicking an icon (rocket) applies immediately via `PUT /api/agents/{id}/profile`; avatar re-renders with the new icon and the deterministic color underneath. `05`.
4. **Swatch pick** — clicking a suggested swatch applies the color immediately. `06`.
5. **Free hex input** — typing a valid `#RRGGBB` value applies immediately (invalid partial input is not submitted). `07`.
6. **Rendered custom avatar** — the detail-page header renders the custom icon + custom color via inline style. `08`.
7. **List reflects the same custom avatar** (slim serialization includes `avatar`, not just the full/detail response). `09`.
8. **Reset to default** — clicking "Reset to default" sends `avatar: null` and the avatar reverts to the deterministic derivation. `10`.

## Also verified (not screenshotted, via direct DB script)

- Fresh DB boot applies migration 119 cleanly.
- Existing (pre-119) DB upgrades cleanly on next boot; pre-existing agent rows get `avatar: null` (deterministic fallback), not a migration failure.
- `updateAgentProfile` avatar set → unrelated-field update (role) does not clobber avatar → explicit `avatar: null` resets it. Covered by an automated test in `src/tests/list-endpoint-slimming.test.ts`.
