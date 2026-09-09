# Realtime rooms and channels

Rooms provide shared runtime state for pages, agents, scripts, and workflows.
The page body remains a versioned program. Room changes never create page versions.

## Public contract

Read the [pages skill](../templates/skills/pages/content.md#multiplayer-rooms-and-live-channels) for executable browser and script examples.
The [REST reference](https://docs.agent-swarm.dev/docs/api-reference/rooms) describes room operations.

- `swarmSdk.room(name, {schemaVersion})` opens a page room. Names match `[a-zA-Z0-9_-]{1,64}`.
- `state`, `change(fn)`, `apply(operations)`, `on`, `presence`, `reset`, `close`, and `ydoc` expose the room API.
- `change` supports synchronous JSON edits. Numbers use scalar conflict resolution.
- Moving keyed array items deletes and reinserts those items. A concurrent edit to a moved item can be lost.
- `apply` sends `set`, `delete`, `insert`, `increment`, or `text` intents to the live server document.
- `room-get`, `room-change`, `room-reset`, and `room-decode` expose MCP operations.
- Scripts use `ctx.swarm.room.get/change/reset/decode`. The script sandbox never loads Yjs.
- `swarmSdk.channel(name)` supplies transient `publish`, `on('message')`, and `close` operations.

## Identity and authorization

User-token page launches sign `uid` and `name` into the page session.
The API resolves the signed user again during proxy authentication. Inactive users cannot use these sessions.
Operator launches and password unlocks create guest sessions. They do not inherit the page author's agent ID.
Guest proxy calls retain deployment-level API access. Review a page before granting external people a password.
Public pages admit anonymous room peers through the dedicated socket path. They do not receive a general API cookie.

Page sockets require a matching `Origin` and host. Authenticated sockets close when the signed page session expires.
Every page request resolves to `task:page:<pageId>`, regardless of a supplied namespace.
Bearer agents can explicitly join a page room. Other agent namespaces retain the existing own-agent or lead authorization.
User mutations require the configured `kv.write.any` grant when RBAC is enabled.
Generic KV set, increment, and delete operations reject the `_room/` key prefix.

## Storage and lifecycle

The API holds live Yjs documents with garbage collection enabled.
It writes one JSON envelope to `_room/<name>` within the caller's KV namespace:

```json
{"format":"swarm-room-v1","schemaVersion":1,"generation":"uuid","snapshot":"base64"}
```

No materialized JSON copy or update log exists. The stateless decoder returns `schemaVersion`, `generation`, and `state`.
The page details inspector decodes saved snapshots without changing rooms.

A normal flush occurs within one second. A crash can lose updates since the last successful flush.
Browser peers retain their current replica across a connection interruption and resync when they reconnect.
This is best-effort durability. Use ordinary database records for a system of record.

Each complete encoded envelope has a 2 MiB limit, approximately 1.5 MiB before base64 encoding.
Each namespace permits 100 rooms. The process permits 1,000 active rooms.
The API rejects oversized candidates before changing its live document.
The periodic sweep flushes and evicts rooms idle for five minutes without subscribers or presence.
Page deletion removes snapshots and invalidates live rooms. Flushes verify the owner and generation inside their transaction.
Shutdown drains pending snapshots before closing the database.

A schema mismatch preserves readable state and rejects writes.
An explicit reset creates a fresh document and generation. The server rejects updates from previous generations.
Presence uses Yjs awareness state, never the persisted document. The browser throttles presence to one update per 50 milliseconds.

## Transport

`/@swarm/realtime` upgrades the existing HTTP listener. `/@swarm/api/*` cannot proxy upgrades.
`/@swarm/realtime.js` serves the generated browser module from the same origin.
One socket multiplexes page rooms and channels. Public channels cannot select internal bus topics.

Frames use JSON. Clients assign an integer `id` to requests and acknowledge each server `seq` with `{ack: seq}`.
Requests include `op`, `name`, optional `namespace`, and the operation payload.
Room operations are `join`, `leave`, `update`, `change`, `reset`, and `presence`.
Channel operations are `subscribe`, `unsubscribe`, and `publish`.
The browser SDK handles these frames, acknowledgements, and reconnection.

The transport bounds outstanding frames and bytes. It does not use Bun's unreliable `bufferedAmount` value.
Limits are 128 unacknowledged frames, 8 MiB outstanding bytes, 3 MiB incoming frames, and 128 queued incoming messages.
Channel data is limited to 64 KiB. Presence data is limited to 8 KiB.
Room POST routes reject request bodies larger than 3 MiB while reading the request stream.

The shared process bus supplies synchronous publish and subscribe operations.
`workflowEventBus` retains its `emit/on/off` contract through `workflow:<event>` topics.
Rooms emit coalesced `room.changed` events with namespace and room filters.
Wait nodes must subscribe before an external change occurs. Room correctness uses CRDT resync, not event replay.

Run a single API replica. Sticky sessions do not provide shared state between replicas.
Room transport and snapshots do not scrub document content. Never store secrets in a room.
Logs and error messages still pass through the secret scrubber.

## Development and verification

Regenerate the browser module after changing the browser SDK or shared document operations:

```bash
bun run build:realtime-browser
bun run check:realtime-browser
bun run tsc:check
bun run test:root -- src/tests/realtime-rooms.test.ts src/tests/realtime-transport.test.ts
bun run e2e
bun run e2e:ui
```

The browser artifact is committed and embedded in compiled API builds.
CI verifies its typecheck and freshness. The module needs no CDN or runtime bundler.
