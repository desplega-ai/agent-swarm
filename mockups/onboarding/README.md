# Onboarding: first-run mockups

Three static directions for the full-page first-run setup in `apps/ui/`.
Brainstorm: `thoughts/taras/brainstorms/2026-09-17-ui-onboarding-experience.md`.
Shared spec (steps, interactions, copy rules): [`SPEC.md`](./SPEC.md).

Open [`../index.html`](../index.html) for the gallery, or an option directly.
No build, no server.

| Option | File | One-liner |
|---|---|---|
| **A. Rail + Stage** | [`option-a-rail-stage/index.html`](./option-a-rail-stage/index.html) | Left rail with all six steps and live status, stage shows one step. Overview always visible. |
| **B. Focused Flow** (chosen, round 2) | [`option-b-focused-flow/index.html`](./option-b-focused-flow/index.html) | One step at a time, 800px column, animated linear progress bar with a step overview, four provider cards with logos, split-view integrations, agents list, header Setup pill. Round 1 kept as `round-1.html`. |
| **C. Launchpad** | [`option-c-launchpad/index.html`](./option-c-launchpad/index.html) | The page is the checklist: six cards, one expands in place. Same object as the minimized card. |

Deep links on every option: `?step=1..6`, `?theme=light|dark`, `?state=minimized`. Option B also: `?step=3&provider=codex&codex=polling`, `?step=6&worker=1`, `?state=minimized&popover=1`, dev panel on `d`.

Common behavior: each step verifies with a fake live check (Test buttons flip to done after ~800 ms), Skip marks a step skipped, Minimize collapses to the home shell with the "Finish setting up your swarm" checklist card, Resume reopens at the current step.
