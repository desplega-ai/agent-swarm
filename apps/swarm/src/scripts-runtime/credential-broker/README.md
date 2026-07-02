# Script Credential Broker

The script credential broker is the scripts-runtime credential injection layer. It keeps raw secrets out of script source and script arguments by replacing `[REDACTED:<configKey>]` placeholders in outbound request headers or query parameters immediately before `fetch` leaves the script subprocess.

## Runtime Shape

- Bindings are stored in `swarm_config` under `SCRIPT_CREDENTIAL_BINDINGS`.
- A binding is `{ configKey, allowedHosts, headerTemplate?, queryTemplate?, scope, scopeId?, active? }`.
- `runScript()` reads the active bindings for the calling agent, resolves `configKey` values with the same `getResolvedConfig()` pattern used by MCP server env/header config resolution, and passes only resolved bindings to the subprocess.
- `eval-harness.ts` installs the fetch patch. Substitution happens only in headers/query parameters and only when the request hostname is in `allowedHosts`.
- The legacy `GITHUB_TOKEN -> api.github.com` behavior is represented as a default binding.

Example binding document:

```json
{
  "bindings": [
    {
      "configKey": "GITHUB_TOKEN",
      "allowedHosts": ["api.github.com"],
      "headerTemplate": "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
      "scope": "global",
      "active": true
    }
  ]
}
```

Scripts still opt in per request by sending a header value that contains the placeholder from `headerTemplate`. Query-string bindings work the same way: configure `queryTemplate` as `param=[REDACTED:CONFIG_KEY]`, then send a URL with that placeholder-bearing query value. The broker does not auto-add headers or query parameters in this draft.

## Management

Use the lead-only `credential-bindings` tool to list, upsert, and disable bindings. The tool writes the binding document to `swarm_config`; scripts consume the resulting config at spawn time. Credential use is intentionally not exposed as dynamic MCP tools.

## Deferred Extension Points

- Remove the script stdlib `Redacted.value()` escape hatch so scripts cannot unwrap secrets directly.
- Gate `get-config includeSecrets=true` to lead-only. Today that broader API can still reveal raw secrets outside the broker path.
- Add request-body or path substitution for APIs that require credentials outside headers/query strings. This must be host-allowlisted separately and should preserve the same placeholder discipline.
- The spec-to-tools idea is explicitly out of scope for this broker. Generated or dynamic MCP tools should not be added here; this module is for scripts-runtime fetch-layer injection only.
