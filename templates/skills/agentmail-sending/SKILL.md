---
name: agentmail-sending
description: Canonical AgentMail send-message API reference for swarm agents. Pins the base URL, required field names, text-only rendering workaround, BCC policy, and ready-to-copy curl / swarm-script examples so agents do not rediscover the API surface at runtime.
user-invocable: false
---

# AgentMail Sending

## Canonical Base URL

Use this base URL exactly:

```text
https://api.agentmail.to/v0/
```

DO NOT use `api.agentmail.ai`. That host is a hallucination and will not send mail through AgentMail's current API.

## Canonical Send-Message Fields

For `POST /inboxes/{inbox}/messages/send`, the JSON body fields are exactly:

```text
to
bcc
subject
text
```

Use `text`, NOT `text_body`, `body`, or `content`.

Do NOT pass `html`. AgentMail has a known rendering bug: when `html` is passed with `text`, the HTML body can be empty and email clients may show a blank email. AgentMail renders `text` correctly on its own.

## Rule 0: One-Shots Stay One-Shots

For a one-off send, such as a kickoff email or a single notification, do not create a reusable swarm-script. Use raw `curl` from Bash, or inline `script_run` if you need swarm-visible execution.

Only use `script_upsert` when the send will be reused by a workflow that fires repeatedly.

## Default Example: Raw curl

Use this direct API call first. It does not assume any SDK is installed.

Endpoint:

```text
https://api.agentmail.to/v0/inboxes/{inbox}/messages/send
```

```bash
INBOX="<agentmail-inbox-id>"

curl -sS -X POST "https://api.agentmail.to/v0/inboxes/${INBOX}/messages/send" \
  -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{
  "to": ["recipient@example.com"],
  "bcc": ["oversight@example.com"],
  "subject": "Subject line",
  "text": "Plain-text email body."
}
JSON
```

Notes:

- `AGENTMAIL_API_KEY` must be configured in swarm config or exported into the shell before running curl.
- Keep `bcc` for external recipients so a human oversight inbox sees outbound email.
- Do not add `html`; `text` is the canonical content field.

## Reusable Workflow Example: script_upsert

Use this only when the send is part of a reusable workflow. The script resolves the API key from swarm config at runtime and calls the same raw HTTP endpoint with `fetch`.

```ts
await script_upsert({
  name: "send-agentmail-text-email",
  description: "Send a text-only AgentMail message from a reusable workflow.",
  intent: "Reusable workflow email send via AgentMail raw API",
  scope: "agent",
  source: `
import type { ScriptContext } from "swarm-sdk";

type Args = {
  inbox: string;
  to: string[];
  bcc: string[];
  subject: string;
  text: string;
};

export default async (args: Args, ctx: ScriptContext) => {
  const redactedKey = ctx.swarm.config.get('AGENTMAIL_API_KEY');
  if (!redactedKey) {
    throw new Error("AGENTMAIL_API_KEY is not configured in swarm config");
  }

  const apiKey = ctx.stdlib.Redacted.value(redactedKey);
  const response = await ctx.stdlib.fetch(
    \`https://api.agentmail.to/v0/inboxes/\${encodeURIComponent(args.inbox)}/messages/send\`,
    {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${apiKey}\`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: args.to,
        bcc: args.bcc,
        subject: args.subject,
        text: args.text,
      }),
    },
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(\`AgentMail send failed: \${response.status} \${responseText}\`);
  }

  return responseText ? JSON.parse(responseText) : { ok: true };
};
`,
});
```

Run it from a workflow with args shaped like:

```json
{
  "inbox": "<agentmail-inbox-id>",
  "to": ["recipient@example.com"],
  "bcc": ["oversight@example.com"],
  "subject": "Subject line",
  "text": "Plain-text email body."
}
```

## BCC Policy

All outbound emails to external recipients MUST include a human oversight email address in `bcc`. This gives the operator visibility into what the swarm sends.

Exception: internal emails between the swarm's own agent inboxes do not need BCC.

## Human Approval

Never send outreach or cold emails to external recipients without explicit human approval. Draft the email, present it for review, and send only after receiving approval.

## Checklist

Before every AgentMail send:

- Use `https://api.agentmail.to/v0/`.
- Use only `to`, `bcc`, `subject`, and `text` in the send-message JSON body.
- Use `text`, not `text_body`, `body`, or `content`.
- Do not pass `html`.
- BCC a human oversight address for external recipients.
- Get human approval for outreach or cold email.
- Use raw `curl` or inline `script_run` for one-offs; reserve `script_upsert` for reusable workflow sends.

## Common Errors

| Symptom | Cause / fix |
|---|---|
| 404 on `/v0/inboxes/.../send` | Check the base URL. Use `api.agentmail.to`, not `api.agentmail.ai`. |
| 422 `{"detail":"text Field required"}` | The request used `text_body` or `body` instead of `text`. |
| 401 | `AGENTMAIL_API_KEY` is not configured in swarm config. In scripts, use `swarm.config.get('AGENTMAIL_API_KEY')`. |
| HTML rendering bug | Do not pass `html` at all. AgentMail renders `text` correctly. |
