# Profile Corruption Escalation

Use this skill when an agent's persisted profile (`SOUL.md`, `IDENTITY.md`, or equivalent DB fields) appears to be overwritten with placeholder, fixture, truncated, or otherwise invalid content.

## When to Use

- An agent profile contains sentinel text such as "Test Worker", "Updated by Myself", repeated padding, or another canned payload.
- The profile is much shorter than the expected baseline.
- A recently restored profile was overwritten again.
- A hook, seeder, migration, test fixture, or profile-update tool may be writing to the wrong agent.

## Triage Loop

1. Capture the corrupted payload, agent ID, and `lastUpdatedAt` timestamp before changing anything.
2. Search memory and recent task history for the same sentinel string or same agent.
3. Grep the source repo for exact sentinel strings. Stable placeholder text usually points to a fixture, seed path, or test helper faster than manual restoration does.
4. Inspect code paths that can write profile files or profile DB fields: profile-update tools, startup hooks, stop/session hooks, seeders, migrations, and tests that set agent identity env vars.
5. If you find the writer, fix or escalate the code path before restoring the profile.
6. Restore only after evidence is captured, and only if restoration will not destroy useful debugging evidence.

## Escalation Threshold

Escalate instead of repeatedly restoring when any of these are true:

- The same profile is corrupted more than once in a short period.
- The sentinel text appears to come from code that knows schema limits or exact file paths.
- You cannot identify the writer quickly.
- A previous fix should already have eliminated this corruption family.

## Escalation Package

Post a concise report to the operator channel or issue tracker with:

- Agent name and ID.
- Fresh write timestamp.
- Exact sentinel strings to search for.
- Whether you already grepped the repo and what matched.
- Suspected writer classes: hook, seeder, migration, test fixture, startup script, or profile-update tool.
- Whether you restored the profile or left it corrupted as evidence.
- Link to the task, log, or memory entry containing the captured payload.

## Report Template

```text
Profile corruption detected

Agent: <agent-name> (<agent-id>)
Fresh write at: <timestamp>
Sentinel strings:
- "<literal-1>"
- "<literal-2>"

Repo grep result: <matches or no matches>
Suspected writer: <hook/seeder/migration/test/tool/unknown>
Action taken: <restored profile | left as evidence | opened fix PR>
Evidence: <task/log/memory link>
```

## Gotchas

- Do not rely on repeated manual restores as the fix. They can hide the writer and destroy evidence.
- Search exact sentinel strings before broad refactors; fixture text is usually distinctive.
- Do not overwrite unrelated profile files during restoration.
- Treat a recurrence after a code fix as a new investigation unless you can prove the same writer is still active.
