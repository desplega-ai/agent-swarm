# require-ticket-ref

Blocks new tasks that do not name a ticket. Applies to the origins listed in `config.origins` (default `rest`, `mcp`, `slack`), so schedules, workflows, webhooks, and follow-ups keep working.

Config:

```json
{ "pattern": "\\bDES-\\d+\\b", "origins": ["rest", "mcp", "slack"] }
```

Effect: REST returns `422` with the reason, `send-task` returns an error result, and Slack replies with the reason in the thread. The extension state keeps a `blocked:<origin>` counter.
