/**
 * AgentMail event prompt template definitions.
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Email events
// ============================================================================

registerTemplate({
  eventType: "agentmail.email.followup",
  header: "[AgentMail] Follow-up email in thread",
  defaultBody: `From: {{from}}
Subject: {{subject}}
Inbox: {{inbox_id}}
Thread: {{thread_id}}

{{preview}}`,
  variables: [
    { name: "from", description: "Sender address(es)" },
    { name: "subject", description: "Email subject" },
    { name: "inbox_id", description: "AgentMail inbox ID" },
    { name: "thread_id", description: "AgentMail thread ID" },
    { name: "preview", description: "Email body preview (truncated to 500 chars)" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "agentmail.email.mapped_lead",
  header: "[AgentMail] New email received",
  defaultBody: `From: {{from}}
Subject: {{subject}}
Inbox: {{inbox_id}}
Thread: {{thread_id}}
Message: {{message_id}}

{{preview}}`,
  variables: [
    { name: "from", description: "Sender address(es)" },
    { name: "subject", description: "Email subject" },
    { name: "inbox_id", description: "AgentMail inbox ID" },
    { name: "thread_id", description: "AgentMail thread ID" },
    { name: "message_id", description: "AgentMail message ID" },
    { name: "preview", description: "Email body preview (truncated to 500 chars)" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "agentmail.email.mapped_worker",
  header: "[AgentMail] New email received",
  defaultBody: `From: {{from}}
Subject: {{subject}}
Inbox: {{inbox_id}}
Thread: {{thread_id}}

{{preview}}`,
  variables: [
    { name: "from", description: "Sender address(es)" },
    { name: "subject", description: "Email subject" },
    { name: "inbox_id", description: "AgentMail inbox ID" },
    { name: "thread_id", description: "AgentMail thread ID" },
    { name: "preview", description: "Email body preview (truncated to 500 chars)" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "agentmail.email.unmapped",
  header: "[AgentMail] New email received (unmapped inbox)",
  defaultBody: `From: {{from}}
Subject: {{subject}}
Inbox: {{inbox_id}}
Thread: {{thread_id}}
Message: {{message_id}}

{{preview}}`,
  variables: [
    { name: "from", description: "Sender address(es)" },
    { name: "subject", description: "Email subject" },
    { name: "inbox_id", description: "AgentMail inbox ID" },
    { name: "thread_id", description: "AgentMail thread ID" },
    { name: "message_id", description: "AgentMail message ID" },
    { name: "preview", description: "Email body preview (truncated to 500 chars)" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "agentmail.email.no_agent",
  header: "[AgentMail] New email received (no agent available)",
  defaultBody: `From: {{from}}
Subject: {{subject}}
Inbox: {{inbox_id}}
Thread: {{thread_id}}

{{preview}}`,
  variables: [
    { name: "from", description: "Sender address(es)" },
    { name: "subject", description: "Email subject" },
    { name: "inbox_id", description: "AgentMail inbox ID" },
    { name: "thread_id", description: "AgentMail thread ID" },
    { name: "preview", description: "Email body preview (truncated to 500 chars)" },
  ],
  category: "event",
});
