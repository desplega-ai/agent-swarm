# AgentMail Sending Rules

These rules are MANDATORY for all agents sending email via AgentMail. Violating them will result in blank emails reaching real people.

## Rule 1: TEXT ONLY — Never Pass `html` Parameter

**AgentMail has a critical bug (as of 2026-03-25):** When both `text` and `html` parameters are passed to `send_message` or `reply_to_message`, the HTML body content is silently dropped. The resulting email has an empty `<div dir="ltr"></div>`. Email clients (Gmail, etc.) prefer the HTML version over plain text, so recipients see a completely blank email.

**What to do:**
- ONLY pass the `text` parameter
- NEVER pass the `html` parameter
- This applies to BOTH `send_message` and `reply_to_message`

**Why this matters:** This bug caused real outbound prospect emails to arrive blank, burning contacts permanently. It is not a cosmetic issue — it's a data loss / reputation issue.

## Rule 2: Always BCC t@desplega.ai on Outbound Emails

All outbound emails to external recipients (anyone outside @agent-swarm.dev) MUST include `t@desplega.ai` as BCC. This gives the human founder visibility into what emails the swarm is sending.

**How:**
```
send_message({
  inboxId: "lead@agent-swarm.dev",
  to: ["recipient@example.com"],
  bcc: ["t@desplega.ai"],
  subject: "...",
  text: "..."
})
```

**Exception:** Internal emails between agent inboxes (@agent-swarm.dev) or to t@desplega.ai / e@desplega.ai directly do NOT need BCC.

## Rule 3: Always Include Signature

Use the `email-signature` skill to append the proper plain text signature to every outgoing email. See that skill for the template.

## Rule 4: Human Approval Before Sending to Prospects

Never send outreach/cold emails to external prospects without explicit human approval. Draft the emails, present them for review, and only send after receiving "approved" or equivalent confirmation.

## Summary Checklist

Before every `send_message` or `reply_to_message` call:
- [ ] Only `text` param, NO `html` param
- [ ] BCC `t@desplega.ai` if recipient is external
- [ ] Plain text signature appended
- [ ] Human-approved if it's outreach/cold email

