# Vendored OpenAPI specs

This directory is reviewed source, not a runtime download cache. `manifest.json` defines the
blessed catalog entries and their allowlisted `METHOD /path` operations. Each JSON file contains
only that operation subset, its real parameters/request bodies/responses, and the transitive
closure of locally referenced schemas needed by generated script clients.

Run `bun run refresh:vendored-openapi` to retrieve directly trim-compatible pinned upstream
documents, re-trim them, print which files changed, and update manifest checksums. It stages every
change before writing so a failed fetch cannot leave a partial refresh. Machine sources are pinned
by both their upstream version and raw-document SHA-256. `operator-review` entries are canonicalized
and checksummed locally but are never fetched. For those entries, `specSourceUrl` is an
operator-reference URL documenting provenance; it is not asserted to be a directly fetchable
OpenAPI document. Run `bun run check:vendored-openapi` offline in CI; it rejects non-canonical
trims, unknown operations, unsafe filenames, inconsistent provenance metadata, and hash drift.

Provenance: GitHub and Slack are pinned to upstream Git commits. Jira is pinned to the raw SHA-256
of Atlassian's Cloud v3 document because its published URL is mutable. Gmail is an
operator-reviewed OpenAPI façade based on Google's v1 Discovery model. Linear publishes a GraphQL
endpoint rather than an OpenAPI document, so `linear.json` is an operator-reviewed façade for the
documented `POST /graphql` issue query/mutation shapes. Both façades must remain narrow and be
reviewed when their reference APIs change.
