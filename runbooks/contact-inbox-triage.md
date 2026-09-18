# Contact inbox triage read path

AgentMail's listing indexes omit unauthenticated inbound mail. A sent-message
thread walk only recovers threads with prior outbound mail and cannot discover
cold contact inquiries. Discovery therefore uses verified webhook deliveries.

## Capture and coverage

`POST /api/agentmail/webhook` verifies the Svix signature, then persists inbound
`message.received`, `message.received.unauthenticated`, `message.received.blocked`,
and `message.received.spam` payloads in `kv_entries` before returning 200.
Storage or missing-ID failures return 503 so the provider can retry. Invalid
signatures return 401 and are never stored. Capture happens before local inbox
and sender filters; those filters still control task routing. Blocked/spam
payloads are archived but do not acquire task-routing behavior.

The namespace is `agentmail-inbound`. Keys are SHA-256 of
`JSON.stringify([inbox_id, message_id])`, so provider IDs containing angle
brackets or `@` remain compatible with the public KV API. Values contain
`version: 1`, `capturedAt`, and a minimized `payload`: routing IDs, event type, sender/reply-to,
subject (300 characters), text and HTML (16,000 characters each), timestamp,
unauthenticated label, and attachment filename/type/size. All retained content
strings pass through the shared secret scrubber before truncation. Arbitrary
headers, recipients, preview, attachment IDs, and unknown fields are omitted.
The scrubber covers known credentials and token shapes, not arbitrary sensitive
prose; retained content is still sensitive and uses the existing authenticated
KV/DB access boundary.

Entries expire 30 days after capture, including unprocessed mail. Atomic
first-write insertion preserves both content and expiry across live retries.
A replay after expiry starts a new 30-day window; unexpired triage dedupe markers
still prevent reprocessing. KV reads hide and delete expired entries, discovery
excludes them, and each inbound capture sweeps expired archive rows. In an idle
deployment physical deletion waits for a KV read or the next inbound capture;
this is logical expiry, not a backup-erasure guarantee. Different inboxes remain separate even with the same message ID.
Attachment metadata is preserved; this does not download attachment bytes.

This read path is complete **for inbound events successfully delivered to this
handler and acknowledged after deployment and still within retention**, including cold unauthenticated
mail. It cannot establish historical completeness, recover never-delivered
webhooks, or prove that subscriptions are correct. Keep received and
unauthenticated subscriptions enabled; blocked/spam require those subscriptions
if coverage of those categories is wanted. No subscription or allow/block list
is changed by this patch. Provider replay or a set of known message IDs is
needed to backfill earlier mail.

## Triage and rollout

1. Deploy the engine change before promoting the script.
2. Promote `scripts/contact-inbox-triage.ts` to the existing global
   `contact-inbox-triage` row. This is a Lead action. Reuse the existing schedule.
3. Run with `dryRun: true` and inspect `errors`, `controls`, and `stats`. An empty
   archive is not evidence of an empty inbox. Verify a real signed delivery
   appears in the archive before treating the integration as operational.

The candidate reads archive keys through `db_query` and bodies through
`kv_getOrNull`. It calls no AgentMail listing, search, thread, or message endpoint.
The existing DNS/Exa/GitHub enrichment and conservative classification remain.
`from_` payloads are supported. An unauthenticated event remains untrusted even
if its labels are absent; raw Authentication-Results headers never grant ENGAGE.

Pending messages are processed in bounded pages. `contact-triage-messages`
stores each message's resulting brief before it is excluded from future runs.
This deliberately replaces the old per-thread dedupe, so subsequent inbound
messages in one thread are reviewed. The old `contact-triage` namespace remains
untouched. A downstream notification failure can recover the saved briefs.
There is no email send operation. `lookbackHours` remains accepted for schedule
compatibility but does not override the archive’s 30-day retention window. Saved triage briefs
and dedupe markers expire 30 days after processing and are lazily deleted by
KV reads. Discovery ignores expired markers; a replay after both archive and
marker expiry can be triaged again.
This change does not rewrite pre-existing non-expiring archive rows: if a prior
revision was deployed, delete that namespace before rollout or explicitly
migrate its rows to this minimized format and retention policy.

`archiveDrained` describes the pending archive observed during this run, not
provider inbox completeness. `coverageComplete` stays false and
`historicalCoverage` is `unknown`. Empty reads leave `countsVoid: true` and
`controls.countsValid: false`. Errors do not commit processing markers. Dry runs
write no markers. Concurrent scheduled executions may duplicate briefs, so keep
using the single existing schedule; archive capture itself is concurrency safe.

## Audit baseline, 2026-09-18

Global script row `b0093f34-a3ec-4d72-966c-b7e8879156ae`, hash
`3915667f5116c897664d55e78472940a8d0212450d426bcd52d64fb388b0da5d`, used:

- `GET /v0/inboxes` (`listInboxes`, limit 25).
- `GET /v0/inboxes/{inbox_id}/threads` (`listThreads`, paginated).
- `GET /v0/inboxes/{inbox_id}/threads/{thread_id}` (`getThread`).
- `GET /v0/inboxes/{inbox_id}/messages/{message_id}` (`getMessage`).

At engine baseline `f118528b153b2ee2a706c7f23845d9b5f13c263b`,
`src/http/webhooks.ts` acknowledged before routing. `src/agentmail/handlers.ts`
stored task references (`agentmailInboxId`, `agentmailMessageId`,
`agentmailThreadId`) and a 500-character body preview, emitted a workflow event,
and did not maintain a complete durable message archive or write
`inbox_messages`. That old table's last measured row was
2026-03-11T17:35:59.852Z.

The registered Desplega webhook is
`https://api.desplega.agent-swarm.dev/api/agentmail/webhook` (received and
unauthenticated). The Aurica webhook is
`https://aurica.swarms.agent-swarm.cloud/api/agentmail/webhook` (also blocked/spam).
Both use this route shape; this repository revision ignores blocked/spam for
task routing. Aurica's exact deployed revision and effective filters have not
been independently verified. Subscription names alone do not prove its
persistence behavior. Each deployment has its own archive; this patch does not
aggregate Aurica's deliveries into Desplega's database.
