# Runtime providers

## Push delivery

`RUNTIME_POOLS_ENABLED=true` enables worker nudges through `/api/realtime`.
Workers authenticate with the operator key and `X-Agent-ID`.
Runtime tokens can supply the identity when runtime-token authentication is available.
Only the matching agent can subscribe or unsubscribe to namespace `worker:<agentId>`, channel `nudge`.
Clients cannot publish, join rooms, or modify state in this reserved namespace.

The server sends this envelope, without task content or configuration values:

```json
{"v":1,"kind":"work","taskId":"optional-task-id","at":"2026-10-11T12:00:00.000Z"}
```

Kinds are `work`, `cancel`, `steer`, and `config`.
Clients acknowledge each transport frame with `{"ack": <seq>}`.
The database is the source of truth. Push delivers a nudge.
Workers fetch current state through the existing poll, cancellation, steering, and configuration endpoints.
Nudges are ephemeral. Workers must fetch current state after reconnecting.

All write hooks publish through `getDbClient().afterCommit()`.
Rollback suppresses their nudges.

| Write | Kind | Recipient |
| --- | --- | --- |
| `task.created` event, including resume follow-ups | `work` | Pending assignee or offered recipient, read from the committed task |
| `acceptTask` | `work` | Assignee |
| `assignUnassignedTaskPending` | `work` | Assignee |
| `postMessage` | `work` | Each unique mentioned agent, including inherited reply mentions |
| `cancelTask` | `cancel` | Assignee |
| `createSteeringMessage` | `steer` | Task assignee |
| Configuration upsert or delete | `config` | Agent scope: that agent. Global or repo scope: every subscribed worker agent |

The transport tracks subscriptions separately for each socket.
One socket closing does not remove another runtime's subscription for the same agent.
The process bus publishes `worker.socket.connected` when a socket first subscribes to its worker channel.
It publishes `worker.socket.disconnected` when a socket closes with that subscription.
Both events carry `{agentId, runtimeId?}`. The upgrade reads `runtimeId` from `X-Runtime-Instance-ID`.
An unsubscribe removes the socket from configuration broadcasts.
The feature flag disables subscriptions, nudges, and socket events.
