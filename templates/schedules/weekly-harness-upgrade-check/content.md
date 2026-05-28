# Weekly Harness Upgrade Check

A Tuesday morning schedule that monitors release notes for agent runtimes, model providers, and key CLIs used by the swarm. Posts a summary of relevant changes and recommended upgrade tests, and creates follow-up tasks only for actionable upgrades.

## What It Does

The lead agent checks release notes for:
- Agent harness runtimes (Claude Code, Codex, Gemini CLI, opencode)
- Model providers (Anthropic, OpenRouter, OpenAI)
- Key CLIs used in workflows (bun, gh, glab, docker, turso, qa-use, agent-fs)

For each relevant change, it includes:
- What changed and what the risk level is
- Whether the change requires action (upgrade test, config update, code change)
- Recommended upgrade sequence to minimize breakage

**Creates follow-up implementation tasks only for actionable upgrades** — not just "there's a new version."

## Configuration

```json
{
  "name": "Weekly harness upgrade check",
  "cron": "30 10 * * 2",
  "timezone": "{{TIMEZONE}}",
  "agentRole": "lead",
  "enabled": true,
  "slackChannelId": "{{SLACK_CHANNEL_ID}}",
  "task": "Check release notes for the agent harnesses, model providers, and key CLIs used by this swarm. Summarize relevant changes, risks, and recommended upgrade tests. Create follow-up implementation tasks only for actionable upgrades."
}
```

**Placeholders to configure:**
- `{{TIMEZONE}}` — Your local timezone.
- `{{SLACK_CHANNEL_ID}}` — The Slack channel for upgrade reports.

## Customization Notes

- **Specify your stack explicitly:** Add your actual runtimes and CLIs to the task prompt: `"Check release notes for: Claude Code, Bun, gh CLI, qa-use CLI, and turso CLI."` The agent will otherwise check a default list that may not match your stack.
- **Pair with dependabot triage:** This schedule covers runtime/harness upgrades (not library deps). The `weekly-dependabot-triage` schedule covers library deps. Keep them on different days (Tuesday vs Monday) to avoid cognitive overload.
- **Actionable-only filter:** The prompt says "create follow-up tasks only for actionable upgrades" — this prevents the schedule from spamming task creation on every minor version bump. Adjust if your stack is more sensitive (e.g., `"create tasks for any breaking changes, even minor ones"`).
- **Disable if not needed:** If your stack rarely updates or you have separate CI-based version monitoring, disable this and rely on CI alerts instead.

## When to Use

Enable this if your swarm uses multiple CLI tools and runtimes that release frequently. Model provider API changes in particular can silently break agent behavior if not caught early.

## Trade-offs

**Coverage vs noise:** The agent will check a broad set of release notes. On busy weeks (major Claude version, bun major release) the post can be long. Narrow the target list in the task prompt if the signal is too diluted.

**Lag:** Release notes are checked once a week. For security-critical updates, you may want a separate webhook-triggered alert rather than relying on this schedule.
