---
name: dashboard-ui
description: Use when building or changing UI in apps/ui, the agent-swarm dashboard. Covers pages, components, forms, settings pages, onboarding-style multi-step flows, empty states, motion and animation, keyboard shortcuts, autosave fields, secret inputs, segmented controls, status icons, brand logos, and UI verification with agent-browser. Adds the rules that apps/ui/CLAUDE.md and apps/ui/DESIGN.md do not cover.
---

# Dashboard UI (`apps/ui`)

Read `apps/ui/CLAUDE.md` (primitives catalog, tokens, motion timings, DataGrid, PR evidence) and `apps/ui/DESIGN.md` (visual doctrine) first. This skill adds only what they lack. If a rule here conflicts with them, they win: fix this file.

Placement: a piece used by more than one flow lives in `components/ui/` (primitive) or `components/shared/` (composed). A hook used by more than one component lives in `hooks/`. Flow-only parts stay in the flow folder (for example `components/onboarding/`, `pages/setup/`).

Dependency direction: `components/ui/**` and `components/shared/**` never import from `components/onboarding/**` or `pages/**`. `hooks/**` never imports from `pages/**`: declare a local type instead (for example `ContinueBlockerSetter` in `hooks/use-autosave.ts`). Check: `grep -rn "components/onboarding\|@/pages/" apps/ui/src/components/shared`.

## Primitive catalog

Paths are under `apps/ui/src/`.

| Primitive | File | Use when |
|---|---|---|
| `SegmentedControl` | `components/ui/segmented-control.tsx` | 2 to 4 exclusive options in one row (steer mode, model level). Radio group with roving tabindex and arrow keys. An amber pill slides to the selection (`layoutId` + spring). Per-option `tooltip` and `disabled`. An unavailable (`disabled`) option is `aria-disabled`: the pointer and the arrow keys still reach it, focus shows its tooltip (the reason), and picking it does nothing. Screen readers get the tooltip as its `aria-describedby`. Sizes: `default` 36px, `sm` 28px. A click on the selected option fires again (use it as a retry). |
| `Kbd` | `components/ui/kbd.tsx` | A keycap for a shortcut. Inside a button: `aria-hidden` on the `Kbd`, the key on the button's `aria-keyshortcuts`. `tone="inverted"` on a primary button. Hide below `sm` (touch). |
| `SuggestionChips` | `components/shared/suggestion-chips.tsx` | Starter prompts under a composer (new session, `/setup` step 7). One click puts the prompt in the draft. |
| `BrandLogo` | `components/shared/brand-logo.tsx` | A monochrome brand mark. A CSS mask tints it with `currentColor`. Files: `public/{harness,provider,integration}-logos/`. Decorative: always render the brand name as text next to it. Multi-color logos stay `<img>`. |
| `ModelLabel`, `ModelLogo` | `components/shared/model-logo.tsx` | A model as people read it: the maker's mark (Anthropic, OpenAI, DeepSeek, Z.ai, ...) plus the pretty name ("Claude Opus 5.5", not `claude-opus-5-5`). `modelVendor` / `modelDisplayName` in `lib/model-vendor.ts` read the id, so a model routed through OpenRouter still shows its maker. Put the exact id in a tooltip. |
| `ThemePresetPicker` | `components/shared/theme-picker.tsx` | The theme preset grid (Settings > Appearance, `/setup` step 2). `compact` for a narrow column. Browser-local, through `useTheme()`. |
| `SecretInput` | `components/shared/secret-input.tsx` | A password input with an eye toggle. It owns `type` (the toggle), `value` (a string), `onChange` (takes the new value), and `className`. Every other `Input` prop passes through. `autoComplete` defaults to `"off"`. Pass `"new-password"` on every input that stores a credential. |
| `AutosaveSecretField` | `components/onboarding/autosave-secret-field.tsx` (`/setup` only) | A write-only secret that saves itself. Saved: masked dots + Replace. Never render a stored secret value: the API does not return it. It stores on a paste, or when focus leaves the whole field group (the eye toggle and "Keep saved value" are inside the group). `KEY_RULES` + `checkSecret` hold the per-provider prefix and length rules. Not the same as `SecretField` in `components/shared/copyable-fields.tsx` (a read-only secret with reveal and copy). |
| `StatusIcon`, `StatusLine` | `components/shared/status-icon.tsx` | `StatusIcon`: a small icon with its meaning in a tooltip. Tones: `busy` (spinner), `done` (amber check), `success` (green check), `saved`, `dirty`, `warning`, `error`, `none` (keeps the slot). Color rule: `done` is only for `/setup` progress, next to the amber stepper. Everywhere else a verified or healthy state uses `success`. With a `label`, the icon takes focus, so keyboard users can read the tooltip. One stable root: the tooltip stays mounted, so the live region never remounts. `StatusLine`: icon + a few words. `busy` shimmers, so use it only for real waits. |
| `SaveIndicator`, `WithIndicator` | `components/onboarding/save-indicator.tsx` (`/setup` only) | `SaveIndicator`: an autosave phase as a `StatusIcon`. `WithIndicator`: pins the icon inside an input's right edge. |
| `BorderBeam` | `components/shared/border-beam.tsx` | A liveness accent on a bordered `relative` container while it is ready to act. Keep it mounted and toggle its opacity. Hidden under reduced motion. |
| `InfoTip` | `components/ui/info-tip.tsx` | Optional explanation next to a label. One sentence. It is hover-only (`tabIndex={-1}`), so never put required information in it. A required warning is a short visible muted line under the field (`Saving replaces the whole object.`). A status explanation goes in the `StatusIcon` label, which takes focus. |
| `AnimatedReveal` | `components/shared/animated-reveal.tsx` | A block that appears after a click (an advanced section, a follow-up field). Never for data that a poll brings in. |

## Autosave (no Save buttons)

Reference: `hooks/use-autosave.ts` and `components/onboarding/use-setup-save.ts`.

- Text fields store about 800 ms after typing stops (`ready: true`).
- Secrets never store while typing: `ready: false`, `readyOnCommit: checkSecret(...).valid`. They store on paste (`usePasteCommit`) or when focus leaves the field group (check `relatedTarget` against the group container), and only after the per-provider prefix and length rule passes.
- The value is validated and captured when the save is queued. A later invalid draft never reaches the server.
- One save chain per field: saves run in order, a replaced save is dropped, and a stored value is not sent again.
- Unmount with a scheduled save flushes it through the same chain. A StrictMode remount never saves twice.
- `save` throws on failure. The field shows the error, and the next commit retries. `useSetupSave` toasts once per distinct error.
- Do not call `/api/config/reload`. Every global config upsert schedules a reload on the server, and a second reload restarts integrations twice. Invalidate the queries that read the rows after the save.
- `useAutosaveScope` + `AutosaveScopeContext` hold the step's Continue while any field saves. Other waits in the same step hold it with `useContinueHold(reason)` (for example "Loading agent settings…" while the step 4 dial rows load). One step has one blocker slot, so never call `setContinueBlocker` from a second place in a step that has a scope.
- Never store on view. A default stores only on an explicit action (a pick, Continue). A follow-up write belongs to the action that causes it, in the same request: the step 3 harness switch (R2) moves an agent's dial level to the new harness in its own `updateAgentRuntime` call, so no later step has to remember the switch.
- Do not autosave forms with cross-field validation or one combined apply (for example `components/shared/agent-runtime-settings.tsx`). Keep an explicit Save there.

## Motion recipes

Timings and curves: DESIGN.md § Motion. Recipes:

- Directional step change: `pages/setup/components/step-transition.tsx`. `AnimatePresence mode="popLayout"` with `custom={direction}`: 260 ms in, 140 ms out, 28px offset. Reduced motion: fade only (`useReducedMotion`). `popLayout` lays out the new step at once: no blank gap, no height jump.
- Selection indicators: one `motion.span` with a `layoutId` from `useId()` (one per instance) and the spring `{ stiffness: 520, damping: 42, mass: 0.9 }`. Put the border radius in `style`, not in a class, so Motion corrects it under scale.
- Animate `transform` and `opacity` only.
- Never animate a change that a poll brings in. Keep decorations mounted and toggle their opacity. A remount on each poll replays the entrance.
- An element that comes and goes next to fixed buttons: `AnimatePresence mode="popLayout"`, so the neighbors never move (spinner in `pages/setup/components/setup-footer.tsx`).

## Layout

- Full-height flows: `flex h-dvh flex-col overflow-hidden`. Header and footer are `shrink-0`. Only `main` scrolls: `min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]` (`pages/setup/page.tsx`).
- Header, body, and footer share one column constant (`SETUP_COLUMN` in `pages/setup/components/setup-layout.ts`), so their edges line up. Step content fills the column: do not narrow it with `max-w-3xl` (step 7 passes `fullWidth` to `ComposerDock`).
- The step title and description stay at the top. The step content centers vertically in the height left under them (Taras, 2026-09-25). The column is `min-h-full`, so taller content grows it and the page scrolls. Centered content moves when its height changes, so a view that switches content (list + pane) fills the height instead.
- Split views (list + pane) fill the free height from `sm` up: `sm:h-0 sm:min-h-[28rem] sm:flex-auto` plus `sm:grid-rows-[minmax(0,1fr)]` (`pages/setup/steps/step-integrations.tsx`). `h-0` + `flex-auto` grows the view from zero; `flex-1` in a `min-h` column starts from the content height and overflows. Panes scroll inside, so a pane switch does not move the page.
- Copy buttons keep one width: swap only the icon (Copy to Check) and put "Copied" in `aria-label` (`CopyIconButton` in `pages/setup/steps/ai/fields.tsx`, `hooks/use-copy-to-clipboard.ts`).
- Status slots keep their size when empty (`StatusIcon tone="none"`).

## Interaction

- Keyboard shortcuts: one window `keydown` listener. Skip the event when it is `defaultPrevented`, composing, or a repeat. Skip it with any modifier key, with focus in a typing target (an input, a textarea, a select, `contenteditable`, or a `combobox`, `listbox`, `menu`, or `option` role), with an open dialog, menu, or listbox, on Enter over a focused control, and on Escape while a tooltip is open. Reference: `useSetupShortcuts` in `pages/setup/components/setup-footer.tsx`. Show the key as a `Kbd` on its button.
- A blocked primary action: `aria-disabled`, a no-op click, and a tooltip that says why (`aria-disabled:opacity-50`). Never put the tooltip on a `disabled` `<button>`: it gets no pointer events, so the tooltip never opens. Use `disabled` only when no reason is needed (a request in flight).
- A tooltip whose text comes and goes: keep the `Tooltip` mounted and control `open` (`Hint` in `setup-footer.tsx`). The trigger then never remounts and never drops focus.
- Internal links out of a multi-step flow open in a new tab (`target="_blank" rel="noopener noreferrer"`), so the flow keeps its state.
- A new tab is a new page load: its module state is empty, so a landing redirect sends it back to the flow. Build every link out of `/setup` with `setupExitHref(path)` (`components/onboarding/onboarding-redirect.tsx`). It adds `?fromSetup=1`, and `OnboardingRedirect` skips the redirect for a URL with that marker. Any other landing redirect needs a marker of its own.
- Mutation against a polled query: call `queryClient.cancelQueries({ queryKey })` in `onMutate` and `setQueryData` in `onSuccess` (`useOnboardingAction` in `api/hooks/use-onboarding.ts`). Otherwise a GET that started before the write overwrites the new data.
- Module-level state that outlives a route is keyed per connection (`config.apiUrl`), because the dashboard can switch swarms (`setupVisited` in `components/onboarding/onboarding-redirect.tsx`). Never write it during render: write it in an effect, and read the marker directly in the render that must skip.

## Copy

- Short and verb-first: "Connect Slack", "Replace", "Keep saved value".
- Icons and tooltips over sentences. One sentence per tooltip.
- Honest states: "Saving…", "Saved", or the server error. Never show success before the server confirms it.
- No em dashes in UI copy, code comments, or docs. Use a period, a comma, a colon, or parentheses.

## Verification

```bash
cd apps/ui
bunx tsc -b            # CI runs -b, not --noEmit
bun run lint
bun run check:tokens
```

Browser: one `agent-browser` session per task, closed at the end. Load `agent-browser skills get core` once per session. The API runs on 3013 and the UI on 5274 (LOCAL_TESTING.md § Dashboard UI).

```bash
S=ui-<topic>
agent-browser --session "$S" open http://localhost:5274/<route>
agent-browser --session "$S" set viewport 1280 800
agent-browser --session "$S" screenshot /tmp/<topic>-1280.png
agent-browser --session "$S" set viewport 390 844
agent-browser --session "$S" screenshot /tmp/<topic>-390.png
agent-browser --session "$S" set media dark reduced-motion   # walk the flow again
agent-browser --session "$S" close
```

Record flows (navigation, forms, modals, animation) and upload the evidence with the recipe in LOCAL_TESTING.md § When you need to verify a UI change.

Checklist:

- [ ] `bunx tsc -b`, `bun run lint`, `bun run check:tokens` pass.
- [ ] Screenshots at 1280x800 and 390x844, light and dark.
- [ ] A recording for each changed flow.
- [ ] Reduced motion: movement drops, fades stay, nothing blanks.
- [ ] Keyboard: Tab order, visible focus ring, shortcuts do not fire inside inputs or overlays.
- [ ] No em dashes in the changed files (`grep -n "$(printf '\342\200\224')" <files>`).
