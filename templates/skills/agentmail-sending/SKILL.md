---
name: agentmail-sending
description: CRITICAL rules for sending emails via AgentMail API. Covers the HTML bug workaround, BCC policy, and best practices. ALL agents MUST follow these rules when using send_message or reply_to_message.
user-invocable: false
---

# AgentMail Sending Rules

These rules are MANDATORY for all agents sending email via AgentMail. Violating them will result in blank emails reaching real people.

## Rule 1: TEXT ONLY — Never Pass `html` Parameter

**AgentMail has a critical bug (as of 2026-03-25):** When both `text` and `html` parameters are passed to `send_message` or `reply_to_message`, the HTML body content is silently dropped. The resulting email has an empty `<div dir="ltr"></div>`. Email clients (Gmail, etc.) prefer the HTML version over plain text, so recipients see a completely blank email.

**What to do:**
- ONLY pass the `text` parameter
- NEVER pass the `html` parameter
- This applies to BOTH `send_message` and `reply_to_message`

**Why this matters:** This bug causes outbound emails to arrive completely blank, burning contacts permanently. It is not a cosmetic issue — it is a data loss / reputation issue.

## Rule 2: BCC a Human Oversight Address on Outbound Emails

All outbound emails to external recipients MUST include a human oversight email address as BCC. This gives your team visibility into what the swarm is sending on your behalf.

**Configure a BCC oversight address for your swarm** (e.g. a founder address, ops inbox, or shared team address):

```
send_message({
  inboxId: "<your-agentmail-inbox-id>",
  to: ["recipient@example.com"],
  bcc: ["oversight@yourcompany.com"],
  subject: "...",
  text: "..."
})
```

**Exception:** Internal emails between your swarm's own agent inboxes do NOT need BCC.

## Rule 3: Human Approval Before Sending to External Recipients

Never send outreach or cold emails to external recipients without explicit human approval. Draft the emails, present them for review, and only send after receiving "approved" or equivalent confirmation.

## Summary Checklist

Before every `send_message` or `reply_to_message` call:
- [ ] Only `text` param, NO `html` param
- [ ] BCC your oversight address if recipient is external
- [ ] Human-approved if it is outreach/cold email
