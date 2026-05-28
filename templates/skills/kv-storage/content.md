# KV Storage

The agent-swarm provides a key-value store for small durable state that needs to persist across tasks, sessions, and container restarts. It's backed by the swarm API and accessible via the `kv-get`, `kv-set`, `kv-delete`, `kv-incr`, and `kv-list` MCP tools.

## When to Use KV Storage

- Deduplication records (e.g., "have I already processed this Slack message?")
- Idempotency keys (e.g., "did I already send this email today?")
- Cross-session state for scheduled tasks (e.g., "last processed PR number")
- Routing/mapping tables (e.g., "which agent handles phone number X?")
- Small counters and accumulators

Do NOT use KV for:
- Secrets or credentials (use swarm config with `isSecret=true`)
- Large artifacts (use agent-fs)
- Logs or audit trails (use agent-fs or `store-progress`)

## Core Operations

```bash
# Set a key
kv-set key="my:key:path" value='{"lastRunAt":"2026-05-28","count":5}' ttl=86400

# Get a key
kv-get key="my:key:path"

# Delete a key
kv-delete key="my:key:path"

# Increment a counter (atomic)
kv-incr key="my:counter" by=1

# List keys with a prefix
kv-list prefix="my:"
```

## Key Naming Conventions

Use namespaced keys tied to the task, schedule, workflow, or external object. Good patterns:

```
# Deduplication
integrations:slack:dedupe:<message-ts>
integrations:kapso:dedupe:<wamid>

# Routing/mapping
integrations:kapso:numbers:<phone-number-id>

# Schedule state
schedules:<schedule-id>:last-run-at
schedules:<schedule-id>:last-sha

# Workflow state
workflows:<workflow-id>:run:<run-id>:step-state

# Agent-specific
agent:<agent-id>:cache:<topic>
```

## TTLs for Temporary State

Set TTLs on deduplication records and temporary state to avoid unbounded key accumulation. Common TTL values:

- Deduplication windows: `86400` (24h) or `3600` (1h)
- Session state: `86400` (24h)
- Short-lived flags: `300–3600` (5 min–1h)

Omit TTL for persistent mappings (routing tables, last-known-good state).

## Value Format

Store compact JSON objects, not large blobs. Include:
- Timestamps for idempotency records
- Source identifiers to track provenance
- Version or hash for cache invalidation

```json
{
  "processedAt": "2026-05-28T10:00:00Z",
  "taskId": "173ca713-...",
  "source": "slack:C0AR967K0KZ:1748430000.000000"
}
```

## Atomicity

`kv-incr` is atomic — safe for counters shared across concurrent tasks. `kv-set` is last-write-wins. For state that multiple tasks might write concurrently, use `kv-incr` with a sequence number or include a task ID in the value to detect conflicts.

## Example: Deduplication

```javascript
// Before processing a message
const dedupKey = `integrations:slack:dedupe:${message.ts}`;
const existing = await kvGet(dedupKey);
if (existing) {
  // Already processed — skip
  return;
}

// Process the message
await processMessage(message);

// Mark as processed with 24h TTL
await kvSet(dedupKey, JSON.stringify({ processedAt: new Date().toISOString() }), { ttl: 86400 });
```

## Trade-offs

**KV vs agent-fs:** KV is fast and API-native (no file I/O), but values are opaque blobs — no search, no versioning, no human browsing. Use KV for machine-consumed state; use agent-fs for human-reviewable artifacts and documents.

**KV vs swarm config:** swarm config is for operator-configured values (API keys, account IDs, flags). KV is for dynamic runtime state that tasks write and read themselves.
