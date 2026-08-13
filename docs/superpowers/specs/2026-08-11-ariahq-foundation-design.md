# AriaHQ Foundation Design

## Product boundary

AriaHQ is the shared operating system and Aria is its primary conversational agent. DevFlow is an AriaHQ engine, alongside future operational engines such as POC, Prep, Deal, and Execution. Engines share one Agent Swarm control plane and one organizational knowledge boundary; they do not require separate swarm deployments.

The same Aria identity can appear on internal and client Slack surfaces, but authority is determined by the surface and tenant context:

- Internal surfaces may use organization-scoped knowledge and authorized engine actions.
- Client surfaces may create tenant-bound DevFlow intake records and receive client-safe projections only.
- A recognized client surface is consumed before generic swarm routing, so it cannot inherit internal conversation context or tools.

## Engine lifecycle

Natural-language requirements create a draft task. The task must return a strict `EngineContract` containing stages, transitions, evidence requirements, approvals, required authorities, completion criteria, and open questions.

Drafts do not grant authority. A draft becomes publishable only after it parses, satisfies contract invariants, and has no unresolved questions. Publishing creates:

1. an immutable, incremented engine version;
2. a compiled Agent Swarm workflow;
3. an idempotent link between the two.

Agent stages compile to `agent-task` nodes. Approval stages compile to `human-in-the-loop` nodes. External writes require an approval stage that covers the declared authority. Factory remains the implementation authority for DevFlow, and execution requires the immutable intent produced by the approved Gate 2 path.

## Organizational Brain

The Organizational Brain is distinct from Agent Swarm experience memory. Every knowledge record retains organization, audience, optional client key, source kind, source reference, source revision, source URL, verification state, effective time, expiry, checksum, and metadata.

Retrieval always requires an organization. Client retrieval additionally requires an exact client key. Expired insights are excluded; verified canonical facts rank above source evidence and derived insights. Conflicts remain visible and force explicit conflict language. If no authorized evidence exists, Aria abstains without dispatching an answer task.

Production sources use one of two adapters. OpenAPI-backed systems use the seeded `ariahq-knowledge-sync` script, an agent-scoped generated connection, and a durable recurring schedule. Push systems use a per-source webhook secret whose digest, rather than the raw secret, is stored. Both adapters journal each run, advance cursors only with the committed records, and ingest idempotently by source revision. This supports Google Drive, call-recording, CRM, and historical Slack sources without embedding provider-specific credentials or SDKs in AriaHQ.

Creating an OpenAPI source validates that the connection is generated, available to the selected run-as agent, and backed by the seeded sync script. Source configuration supplies the provider operation, records path, cursor mappings, optional detail operation, and normalized knowledge-field mappings. Connector failures are recorded without advancing the cursor. Credentials remain in the existing Agent Swarm connection boundary.

## Client Slack intake

A configured Slack surface binds one workspace/channel to an organization, audience, optional client key, capture policy, and internal owner. A new surface is inactive until Slack verifies the workspace, channel, and bot membership; unverified surfaces never route messages. Client messages can be mention-only or automatic intake. One database transaction creates the DevFlow work item, tenant-scoped source evidence, client intake projection, and audit event. Slack delivery retries reuse the original intake.

Security-sensitive language produces a redacted acknowledgement and a protected, high-priority case. The external sender never becomes the internal work-item owner.

On verified internal surfaces, an `@Aria` question is accepted only when the Slack user is linked to a canonical user who belongs to the surface organization. Aria retrieves only organization-internal evidence, abstains when that evidence is insufficient, and otherwise dispatches a source-backed answer task whose result is posted to the originating thread. Internal questions and client intake therefore share the Aria persona while retaining different authority envelopes.

## Operator surfaces

The dashboard presents AriaHQ as the parent product with DevFlow nested as an engine:

- Overview: engine portfolio and activation state.
- Engine Studio: create, inspect, reconcile, and publish governed engine drafts.
- Ask Aria: submit evidence-bound questions and inspect citations/conflicts.
- Sources & Surfaces: inspect connector readiness, schedules, latest sync state, Slack verification, and retry verification.
- DevFlow and DevFlow Inbox: existing implementation lifecycle and client intake work.

## Foundation completion boundary

The repository now contains the complete local production paths for engine authoring, evidence-bound answers, scheduled and webhook source ingestion, tenant-safe client intake, verified internal Slack questions, API contracts, and operator monitoring. These paths are locally testable without weakening tenant, identity, evidence, or approval gates.

Live production activation remains an external deployment step and must not be represented as complete until Rebar supplies and configures the Slack app credentials, provider-specific Google Drive/CRM/call-recording connections, historical backfill scope, an execution-harness provider, and the production target. Completion then requires running the real connector schedules and validating Slack-to-DevFlow plus Ask-Aria thread delivery with at least two tenant fixtures to prove isolation.
