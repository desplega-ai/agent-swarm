/**
 * Slack event prompt template definitions.
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Assistant messages (Slack UI messages, not agent prompts)
// ============================================================================

registerTemplate({
  eventType: "slack.assistant.greeting",
  header: "",
  defaultBody: "Hi! I'm your Agent Swarm assistant. How can I help?",
  variables: [],
  category: "system",
});

registerTemplate({
  eventType: "slack.assistant.suggested_prompts",
  header: "",
  defaultBody: `Try these:
- Check status: What's the current status of all agents?
- Assign a task: Can you help me with...
- List recent tasks: Show me the most recent tasks`,
  variables: [],
  category: "system",
});

registerTemplate({
  eventType: "slack.assistant.offline",
  header: "",
  defaultBody:
    "No agents are available right now. Your request has been queued and will be processed when agents come back online.",
  variables: [],
  category: "system",
});

registerTemplate({
  eventType: "slack.message.thread_context",
  header: "",
  defaultBody: `<thread_context>
{{thread_messages}}
</thread_context>`,
  variables: [
    {
      name: "thread_messages",
      description: "Formatted thread messages (user: text pairs)",
    },
  ],
  category: "system",
});
