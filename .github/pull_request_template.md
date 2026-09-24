<!--
Write for a human reviewer. Follow the `comms` skill in Precise mode (ASD-STE100):
https://github.com/danyuchn/asd-ste100-skill
- One idea per sentence, 25 words or fewer. Active voice.
- No filler, no marketing words, no summary of the diff line by line.
- Keep a hedge only when the uncertainty is real.

Every section is required, except:
- Sections marked "fix" are required only when the title is "fix: ..." or "fix(scope): ...". Delete them otherwise.
- Sections marked "optional" may be deleted.
The "PR Body" check enforces this. Local check:
  bun scripts/check-pr-body.ts --title "<title>" --body-file <file>
-->

## Intent

<!-- Why this change exists, in the words of the person who asked for it. Link the source: issue (Fixes #<number>), Linear (DES-<number>), Slack thread, or swarm task. Quote the original ask when it is short. Do not rewrite the ask to match what you built.
For a bug: what is wrong, what should happen instead, and who it affects. Stay high level. -->

## Repro <!-- fix -->

<!-- Numbered steps that show the bug on main. "See #<number>" is fine when the issue already has them. -->

## Setup <!-- fix -->

<!-- Where the bug happens: agent-swarm version or commit, deployment type (local, Docker Compose, Helm, cloud), agent roster (lead and workers), harness providers. "See #<number>" is fine when the issue already has it. -->

## Decisions & trade-offs

<!-- Choices you made that the request did not specify, and what each one costs. Things you left out on purpose.
Side effects: migrations, new env vars or config keys, breaking changes, deploy or rollback steps.
Write "None" only when the request fixed every choice and there are no side effects. -->

## Proof of work

<!-- Evidence that the change works, not claims.
UI change: screenshots, plus a recording for interaction or flow changes (agent-fs signed URLs).
Other change: the commands you ran and their results. Put long logs in a <details> block. Name each pre-existing failure and show that it also fails on main. -->

## Urgency <!-- pick one -->

<!-- Check exactly one. Agents: copy the urgency from the request. If the request gives none, check "nice to have". -->

- [ ] asap
- [ ] this week
- [ ] nice to have
