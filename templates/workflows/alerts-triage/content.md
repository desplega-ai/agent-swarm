# Alerts Triage

The Slack handler emits `slack.message`; this workflow keeps the event-driven path and deduplicates work after the channel filter.

```json
{
  "name":"Alerts triage",
  "description":"Triage messages from the configured alert channel.",
  "triggers":[{"type":"event","eventName":"slack.message"}],
  "triggerSchema":{"type":"object","required":["channel","text","ts"],"properties":{"channel":{"type":"string"},"text":{"type":"string"},"ts":{"type":"string"}}},
  "nodes":[
    {"id":"eligible-alert","type":"property-match","label":"Only accept the configured alert channel","config":{"mode":"all","conditions":[{"field":"trigger.channel","op":"eq","value":"{{ALERTS_CHANNEL_ID}}"}]},"next":{"true":"triage"}},
    {"id":"triage","type":"agent-task","label":"Verify and triage the alert","config":{"template":"Triage this Slack alert: {{trigger.text}}. Verify current state, deduplicate against active incidents, classify severity and owner, and post only an actionable summary through the configured admin delivery channel. Do not create work for non-actionable noise.","tags":["alerts","triage"],"priority":70}}
  ],
  "onNodeFailure":"continue"
}
```
