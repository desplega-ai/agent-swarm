# PR Review Status Sweep

This topology-preserving self-hosted port removes installation-specific identities, endpoints, and credentials while retaining the live workflow's nodes, edges, input mappings, guards, retries, cooldown, and triggers. Configure the declared template parameters and integrations before enabling it.

```json
{"name":"pr-review-status-sweep","description":"Cron-triggered deterministic sweep for {{REPO_URL}} open PRs. The steady-state path is swarm-script only: enumerate non-draft PRs, run global pr-review-status, enforce KV run/per-PR leases and idempotency markers, and stay silent on clean sweeps. The single Phase A agent-task node is gated on actionableCount > 0. Phase B is disabled: no auto-push, no merge, no thread resolution.","nodes":[{"id":"sweep","type":"swarm-script","label":"Deterministic PR review action-item sweep","config":{"scriptName":"pr-review-status-sweep","scope":"agent","args":{"repo":"{{REPO_URL}}","limit":50,"phaseBEnabled":false,"slackChannelId":null,"slackThreadTs":null}},"next":"has-action-items"},{"id":"has-action-items","type":"property-match","label":"Gate: only continue when actionItems > 0","config":{"mode":"all","conditions":[{"field":"sweep.result.actionableCount","op":"gt","value":0}]},"next":{"true":"handle-action-items"}},{"id":"handle-action-items","type":"agent-task","label":"Phase A handler for unprocessed review action items","config":{"template":"{{sweep.result.handlerPrompt}}","tags":["pr-review-status","phase-a","review-action-items"],"priority":60,"dir":"/workspace/repository","vcsRepo":"{{REPO_URL}}","model":"gpt-5.5"},"inputs":{"sweep":"sweep"}}],"onNodeFailure":"fail"}
```



