# AgentMail Sending Rules

These rules are MANDATORY for all agents sending email via AgentMail. Violating them will result in blank emails reaching real people.

## Rule 1: TEXT ONLY — Never Pass `html` Parameter

**AgentMail can drop visible email content when both `text` and `html` parameters are passed:** Some clients prefer the HTML version, so a blank or malformed HTML body can make recipients see an empty email even when plain text was provided.

**What to do:**
- ONLY pass the `text` parameter
- NEVER pass the `html` parameter
- This applies to BOTH `send_message` and `reply_to_message`

**Why this matters:** This bug caused real outbound prospect emails to arrive blank, burning contacts permanently. It is not a cosmetic issue — it's a data loss / reputation issue.

## Rule 2: Apply Your Team's Outbound Visibility Policy

All outbound emails to external recipients must follow your deployment's visibility policy. If your team requires a BCC reviewer or audit inbox, include that configured address. Do not hardcode another organization's reviewer address into this template.

**How:**
```
send_message({
  inboxId: "lead@agent-swarm.dev",
  to: ["recipient@example.com"],
  bcc: ["configured-reviewer@example.com"],
  subject: "...",
  text: "..."
})
```

**Exception:** Internal emails between agent inboxes or messages already addressed to the configured reviewer list do not need an extra BCC.

## Rule 3: Always Include Signature

Use the `email-signature` skill to append the proper plain text signature to every outgoing email. See that skill for the template.

## Rule 4: Human Approval Before Sending to Prospects

Never send outreach/cold emails to external prospects without explicit human approval. Draft the emails, present them for review, and only send after receiving "approved" or equivalent confirmation.

## Summary Checklist

Before every `send_message` or `reply_to_message` call:
- [ ] Only `text` param, NO `html` param
- [ ] Apply the configured BCC/audit policy if the recipient is external
- [ ] Plain text signature appended
- [ ] Human-approved if it's outreach/cold email
