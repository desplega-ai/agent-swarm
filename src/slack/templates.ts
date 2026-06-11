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

registerTemplate({
  eventType: "slack.auto_reply.data_classifier",
  header: "",
  defaultBody: `AUTO-REPLY CLASSIFIER TASK
Channel: {{channel_id}}
Original message: "{{message_text}}"

STEP 1 — CLASSIFY (strict gate):
Is this CLEARLY a data question answerable from BigQuery (e.g. counts, revenue, ARR, churn, customers, pipelines, payments)?

If NOT clearly a data question — general chat, process question, opinion, off-topic, ambiguous — call store-progress status:completed output:"Classified as non-data — no reply sent." and STOP. Do not post anything.

STEP 2 — EXECUTE (only if YES):
Use the bq-query skill to answer the question. Run a focused SQL query. {{bq_dataset_scope}} Keep the query narrow.

STEP 3 — COMPOSE A SHORT REPLY:
2-4 sentences max, or a bullet list of ≤5 items. Include numbers/dates from the query result. No preamble. Start the reply with EXACTLY this line (preserve formatting):
{{disclaimer}}

STEP 4 — POST:
Call slack-reply with your taskId to send the reply in-thread.`,
  variables: [
    { name: "channel_id", description: "Slack channel ID (e.g. C03FFSNF5U4)" },
    { name: "message_text", description: "The original Slack message text" },
    { name: "disclaimer", description: "Beta disclaimer string to prepend to every reply" },
    {
      name: "bq_dataset_scope",
      description:
        "BigQuery project/dataset scope instruction. When not configured, defaults to a refusal instruction.",
    },
  ],
  category: "system",
});
