---
date: 2026-09-16
researcher: Codex
git_commit: 58e5aaec2a822cfa296f1e26b2121fc3d60afbaa
branch: main
repository: agent-swarm
topic: "Swarm branding, Slack avatars, and lightweight gamification configuration"
tags: [research, branding, slack, configuration, avatars, gamification]
status: complete
autonomy: critical
last_updated: 2026-09-24
last_updated_by: Codex
---

# Research: Swarm branding and gamification configuration

## Research Question

Taras wants additional swarm configuration for branding and gamification. Specific requests include a Slack app default of `Your Swarm` and configurable agent avatars.

This report maps existing behavior and identifies simple extension points. Recommendations appear separately from current behavior. No application code changed.

## Summary

The swarm already has global branding settings and editable agent appearance. Slack does not use the saved agent appearance. It assigns fixed or generated emoji instead.

The selected scope supports both Slack emoji and image URLs per agent. Existing avatar JSON storage provides a possible persistence path without a migration.
Backend work comes first: validation, persistence, API access, and consistent Slack persona resolution. Onboarding and dashboard controls remain separate.
Agents retain defaults when no override exists. The current crown and generated worker emoji provide those defaults.

The Slack manifest is separate from runtime configuration. Changing its default app name is a small static edit. Runtime branding settings cannot rename an installed Slack app through the current code.

Six Slack lifecycle reactions already support configuration. These provide lightweight personalization today. Achievements, streaks, and persistent rewards would require new behavior and storage.

## Detailed Findings

### 1. Slack app identity comes from a static manifest

[`slack-manifest.json:2`](https://github.com/desplega-ai/agent-swarm/blob/58e5aaec2a822cfa296f1e26b2121fc3d60afbaa/slack-manifest.json#L2) defines the app name as `agent-swarm`.
The same file defines the bot display name as `Agent Swarm` at line 14.
Description and background color appear at lines 4-6.

Onboarding directs operators to import this file through its GitHub URL (`src/commands/onboard/steps/integration-slack.tsx:8`).
The file has no connection to `SWARM_ORG_NAME` or other runtime settings.

**Simple option:** Change the app display name default to `Your Swarm`.
Treat the bot display name as a separate field with Slack-specific naming constraints.
The existing `/agent-swarm-*` command names are independent fields.

An operator must update an existing app through Slack to change its installed identity.
Slack documents manifest updates and their propagation to installed workspaces in its [app lifecycle guide](https://docs.slack.dev/app-management/distribution/).
The [manifest reference](https://docs.slack.dev/reference/app-manifest/) defines app and bot naming fields separately.

### 2. Slack agent personas ignore dashboard avatars

[`getAgentEmoji()`](https://github.com/desplega-ai/agent-swarm/blob/58e5aaec2a822cfa296f1e26b2121fc3d60afbaa/src/slack/responses.ts#L437) accepts the complete agent object.
It returns `:crown:` for leads. For workers, it hashes the agent name into eight fixed emoji choices.
It has no configuration read or cache.

`getAgentDisplayName()` uses the registered agent name, plus a development prefix (`src/slack/responses.ts:47`).
The runner already supports names through `AGENT_NAME` (`src/commands/runner.ts:5010`).

Several posting paths apply these shared identity helpers:

| Surface | Source |
|---|---|
| Task progress and results | `src/slack/responses.ts:94`, `:163`, `:225`, `:345` |
| Explicit Slack tools | `src/tools/slack-post.ts:104`, `slack-reply.ts:131`, `slack-start-thread.ts:71` |
| Classic task tree | `src/slack/watcher.ts:486` |
| V2 task tree and streaming results | `src/slack/render-v2.ts:535`, `:1101` |

System alerts can post without an agent persona. Examples include `src/queue-stall-alarm.ts:134` and `src/oauth/keepalive.ts:79`.
Those messages retain the app identity.

The manifest already requests `chat:write.customize` (`slack-manifest.json:71`).
Slack supports customized usernames, emoji, and image URLs through its [message API](https://api.slack.com/messaging/sending).
Its [streaming API](https://docs.slack.dev/reference/methods/chat.startStream/) also supports these fields. An emoji overrides an image URL when both fields exist.

### 3. Agent appearance already has persistence and an editor

[`AgentAvatarSchema`](https://github.com/desplega-ai/agent-swarm/blob/58e5aaec2a822cfa296f1e26b2121fc3d60afbaa/src/types.ts#L1039) currently accepts a Lucide icon and optional color.
The database stores this object as JSON text (`src/be/migrations/119_agent_avatar.sql:1`).
The profile API validates and saves it (`src/http/agents.ts:430`, `:820`).
The agent page already includes an appearance picker (`apps/ui/src/pages/agents/[id]/page.tsx:239`).

Lucide icons are dashboard glyphs. They are not Slack emoji shortcodes.
The dashboard resolver reads the icon and color independently (`apps/ui/src/lib/agent-icon.ts:975`, `agent-color.ts:155`).

**Selected direction:** Support a Slack emoji or image URL override per agent through the backend.
Use a shared persona resolver to select the configured avatar, including for leads.
Keep the crown and generated worker emoji as defaults when no override exists.

An undeclared JSON property is insufficient. Current schema parsing strips unknown properties before persistence and after retrieval.
Existing profile updates must preserve Slack settings when an operator changes the dashboard icon or color.
Check this compatibility during implementation even though new dashboard controls are outside the initial scope.

Image support requires changing posting sites that currently pass only `icon_emoji`.
Image URLs also need validation and appropriate Slack access.
Each outgoing persona should contain the selected emoji or image URL, not both.
The implementation plan must define validation and the API representation for these alternatives.

### 4. Global configuration already supports new branding fields

[`Branding & URLs`](https://github.com/desplega-ai/agent-swarm/blob/58e5aaec2a822cfa296f1e26b2121fc3d60afbaa/apps/ui/src/lib/configuration-catalog.ts#L908) includes organization name, logo URL, brand color, dashboard URL, and cloud promotion controls.
The server exposes identity through `/status` (`src/http/status.ts:278`).
The sidebar consumes those values (`apps/ui/src/components/layout/app-sidebar.tsx:395`).
The dashboard polls status every 30 seconds (`apps/ui/src/api/hooks/use-status.ts:17`).

The configuration API accepts arbitrary keys and stores string values (`src/http/config.ts:228`, `:384`).
Structured values need explicit JSON serialization. The API does not preserve arbitrary objects as objects.
Known keys can receive validation through `src/be/swarm-config-guard.ts:356`.

Configuration supports global, agent, and repository scopes.
Resolved configuration uses repository values before agent values, then global values (`src/be/db.ts:6351`).
Only global values enter the API process environment (`src/be/db.ts:6153`).
Therefore, an agent-scoped config row does not automatically change Slack behavior.

Global writes and deletions schedule configuration reloads through both HTTP and MCP.
Reload restores deleted keys to their original deployment values and restarts integration clients (`src/http/core.ts:65`).
Branding reads use the resulting environment dynamically.
This means even presentation settings currently use the broader integration reload mechanism.

**Simple option:** Add global scalar settings to the existing catalog, with validation where needed.
For dashboard-visible settings, expose the value through status and connect the relevant component.
New keys alone do not change behavior. Each key needs a consumer.

### 5. Slack reactions already provide configurable feedback

The following settings already exist in `src/slack/reaction-shortcode.ts:9` and the dashboard catalog at line 575:

| Setting | Event |
|---|---|
| `SLACK_REACTION_ACCEPTED` | Accepted work |
| `SLACK_REACTION_BUFFERED` | Buffered message |
| `SLACK_REACTION_NOW` | Immediate action |
| `SLACK_REACTION_STEERED` | Agent steering |
| `SLACK_REACTION_COMPLETED` | Completed work |
| `SLACK_REACTION_FAILED` | Failed work |

These settings accept workspace emoji names. Validation already exists (`src/be/swarm-config-guard.ts:289`).
The shortcode normalization provides a useful pattern for agent avatar input.

**Deferred UI option:** Make these existing controls easier to discover beside branding and agent appearance.
A custom completion emoji already provides a small celebration without new scoring behavior.

### 6. Existing activity metrics are not a game system

The stats API exposes agent and task counts (`src/http/stats.ts:24`, `:239`).
The dashboard computes activity over 24 hours (`apps/ui/src/api/hooks/use-agent-activity.ts:7`, `:61`).
Its activity score controls canvas node size at line 110. It does not implement a leaderboard.

The research found no achievement, streak, reward, or leaderboard model.
Attribution code explicitly keeps metrics separate instead of defining composite scores (`src/be/db.ts:4935`).

**Possible later option:** Show activity cards using existing completed-task counts or status totals.
This is a presentation feature, not an existing configuration toggle.
Persistent achievements would need separate requirements for attribution, retries, time periods, and stored progress.

## Suggested Scope

Taras selected backend configuration first during review on 2026-09-24. Onboarding work is proceeding separately.
Effort labels describe relative scope, not delivery estimates.

| Priority | Option | Relative scope | Main extension point |
|---|---|---|---|
| 1 | Default Slack app name to `Your Swarm` | Very small | Static manifest |
| 2 | Configure Slack emoji and image URLs per agent | Medium | Schema, persistence, API, shared persona resolver, posting paths |
| 3 | Preserve default avatars and existing profile behavior | Included with avatar support | Resolver fallback and profile update compatibility |
| Deferred | Group branding and reaction controls clearly | Small | Configuration catalog and settings UI |
| Optional later | Configure fallback lead emoji or worker emoji palette | Small to medium | Global config and persona resolver |
| Deferred | Generate a manifest from selected branding | Medium | Separate onboarding work |
| Optional later | Show activity cards using existing metrics | Medium | Dashboard queries and presentation |

Start with priorities 1-3. Support both avatar formats rather than limiting the first version to emoji.
Use `Your Swarm` as the manifest default now. Editable naming can follow through the separate onboarding work.
This review does not define XP, streaks, or achievement rules. Those remain separate feature decisions.

## Code References and Verification

All repository references describe commit `58e5aaec2a822cfa296f1e26b2121fc3d60afbaa`.
At research time, local `main` matched `origin/main`, and the worktree was clean before this document.

Existing tests cover configuration reload, identity status, reaction settings, avatar resolution, and Slack persona posting:

- `src/tests/reload-config.test.ts`
- `src/tests/status.test.ts`
- `src/tests/slack-reaction-config.test.ts`
- `src/tests/agent-avatar-resolution.test.ts`
- `src/tests/list-endpoint-slimming.test.ts`
- `src/tests/slack-render-v2.test.ts`
- `src/tests/slack-watcher.test.ts`
- `src/tests/slack-inline-output.test.ts`

This was source research, not implementation validation. No application test suite or live Slack installation test ran.
A focused schema check confirmed that current avatar parsing strips an undeclared Slack emoji property.

## Review Decisions

Taras provided these directions in four review comments, processed on 2026-09-24:

- Support both Slack emoji and image URLs for agent avatars.
- Provide default avatars when no override exists. Retain current defaults as the initial proposal.
- Use `Your Swarm` now. Editable manifest naming makes sense later.
- Prioritize backend configuration. Keep onboarding changes separate because onboarding work is already proceeding in parallel.

## Remaining Design Details

- Define the API representation and validation for emoji versus image URLs.
- Check that existing profile updates preserve Slack settings without requiring new dashboard controls.
- Define any persistent gamification behavior separately before adding its storage or rules.

The source findings remain tied to the original research commit. This review updates scope without refreshing the codebase findings.

## Appendix

No relevant design document exists under `thoughts/*/design-docs/` for these surfaces.
Related historical documents include:

- `thoughts/taras/research/2026-05-07-cloud-personalization-research.md`
- `thoughts/taras/brainstorms/2026-05-07-cloud-deployment-personalization.md`
- `thoughts/otto/research/2026-07-27-agent-avatar-lucide-discovery.md`
- `thoughts/picateclas/qa/2026-07-24-agent-avatar-customization.md`

Current operator guidance: `docs-site/content/docs/(documentation)/guides/personalization.mdx`.
Future configuration additions also require updates to `docs-site/content/docs/(documentation)/ui/configuration.mdx`.
