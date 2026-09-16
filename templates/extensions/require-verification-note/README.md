# require-verification-note

Guards `store-progress` with `status: "completed"`. The call is refused until the `output` contains the configured marker (default `Verified:`). The agent sees the reason as a tool error and can retry with a corrected output.

Config:

```json
{ "marker": "Verified:" }
```

The guard covers agent MCP calls only. REST and dashboard completions are not tool calls and pass through.
