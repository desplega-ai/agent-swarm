# notify-on-complete

Posts one Slack message per finished task to a channel of your choice. Uses `ctx.swarm.slack_post`, so the message is sent by the swarm bot on behalf of the `ext:notify-on-complete` identity.

Config:

```json
{ "channelId": "C0123456789", "includeFailed": true, "maxOutputChars": 400 }
```

Post hooks run after the task change is committed and cannot block or modify anything. A Slack failure counts as a handler failure; five in a row auto-disable the extension.
