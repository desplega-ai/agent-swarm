# Spike: /agentfs/* streaming pass-through proxy

Worktree: `/Users/taras/worktrees/agent-swarm/2026-10-26-afo-spike`, branch `spike/afo-proxy`, never committed. Bun 1.4.3. Times in BCN (CET).

## Files here
- `proxy.patch`: `git diff` of `src/` (handler, wiring, test, preload, footprint count). Regenerated openapi.json and docs-site files are NOT in it (436 diff lines). Re-run `bun run docs:openapi`.
- `agentfs-proxy.ts`: the handler (144 lines). `agentfs-proxy-tests.spike.ts`: 13 tests, keep it (renamed from `agentfs-proxy.test.ts` so the repo test run skips it; `proxy.patch` adds it as `src/tests/agentfs-proxy.test.ts`).
- `timings.json`: last run.

## What was built
- `src/http/agentfs-proxy.ts`: five `route()` defs (get/post/put/delete/patch), path `/agentfs/{path}`, `exact:false`, `auth:{apiKey:false}`, tag `Comb`, `rbac:{ungated}` on the four non-GETs, 2xx `unstructured`. `handleAgentFsProxy` returns false unless `AGENT_FS_PROXY=true` and `AGENT_FS_API_URL` is set, so unset means today's behavior.
- Wiring: `import "./agentfs-proxy"` in `all-routes.ts`; `() => handleAgentFsProxy(req, res)` before `handleComb` in `index.ts`; `AGENT_FS_PROXY` added to the cleared keys in `src/tests/preload.ts`. No `core.ts` change.
- Behavior: strips `/agentfs`, keeps path and query bytes (so `%2F` survives), rejects literal and encoded `..` with 400. Forwards only `authorization, content-type, content-length, accept, if-match, if-none-match, range, x-agent-fs-message, x-agent-fs-message-encoding` (no Cookie, no X-Agent-ID). `fetch(..., redirect:"manual")`. Request body via `Readable.toWeb(req)` with `duplex:"half"`. Response via `Readable.fromWeb(body).pipe(res)`. Drops upstream `access-control-*`, hop-by-hop and `set-cookie`; drops `content-encoding` and `content-length` together when upstream was encoded. Appends `X-Agent-FS-Version, X-Agent-FS-Content-Hash, Content-Disposition` to the swarm's `Access-Control-Expose-Headers` when that header is an explicit list. Aborts upstream when the client closes. Upstream failure gives 502 JSON.

## Results (real agent-fs 0.18.5 from source, local-disk storage, embeddings off, real `src/http.ts`)
| Check | Result |
|---|---|
| ops POST (write then cat) through proxy, no swarm bearer | 200, 8 ms for both |
| register via proxy (public agent-fs route) | 200 |
| no credentials / bad key | agent-fs's own 401 `UNAUTHORIZED` |
| CORS preflight from `http://localhost:5274` | 204, ACAO = origin, Allow-Headers echoes `x-agent-fs-message` |
| real GET with Origin | single ACAO (the origin), not agent-fs's `*` |
| X-Agent-FS-Version/Content-Hash, ETag | reach client; Expose-Headers lists them |
| 50 MB PUT via proxy (If-None-Match:*, X-Agent-FS-Message) | 780 ms (≈64 MB/s), bytes verified |
| 200 MB raw GET | headers/first byte 125 ms (direct to agent-fs: 78 ms), total 241 ms |
| API RSS during 200 MB GET | 739 -> 744 MB, growth 5 MB (earlier runs 16 to 20 MB) |
| client stalled 3 s after first chunk | API RSS growth 1 MB, so backpressure works |
| SSE events, 21 s silent | stayed open, first frame 10 ms, 4 `: ping` frames |
| 9 open/close SSE cycles (cap is 8/user) | all 200, so client close frees the upstream slot |
| flag unset | handler declines, falls to 404 |
| swarm Cookie / X-Agent-ID | not seen by upstream |

Gates: `bun run tsc:check` and `tsc:check:tsc` clean, `bun run lint` and `lint:slop` clean, `check:rbac-coverage` passes with no new allowlist entries, `check:openapi-response-coverage` passes (461 routes), `docs:openapi` generates 461 operations, footprint test passes after 456 -> 461.

Caveat: loopback only. The first-byte gap (125 vs 78 ms) is mostly agent-fs buffering raw GETs (files.ts reads the full body before responding), so a 200 MB file reaches the client only after agent-fs has read it all. Behind Traefik/Cloudflare/HTTP2 this is untested.

## What the plan must do
1. Commit the handler and the test. The test finds agent-fs at `../agent-fs` relative to the swarm checkout, or `AGENT_FS_SRC`, and skips otherwise. Default `bun test` in the worktree skipped 11 tests because `../agent-fs` was absent there. CI has no agent-fs checkout: either keep the 4 isolation tests only in CI and run the real-agent-fs ones locally, or add a CI step that runs the pinned agent-fs image.
2. Bump `docs-index-footprint.test.js` 456 -> 461 (3 lines) and commit regenerated `openapi.json`, `docs-site/.../comb.mdx`, `index.mdx`, `typescript.mdx`, `public/openapi.d.ts`.
3. Gate: the spike used `AGENT_FS_PROXY=true`. If kept, add it to the Settings catalog, the config guard if constrained, and both docs pages (environment-variables, ui/configuration). Mark it `restartRequired` only if read at boot (it is read per request, so no).
4. `getCombConfig()` (src/comb/config.ts) still needs the proxy-mode `apiUrl` of `${PUBLIC_MCP_BASE_URL}/agentfs`. Not done in this spike.
5. Expose-Headers: the spike appends X-Agent-FS-* in the proxy. Comb does not read them today, so this is optional hardening. Keep it, it costs 5 lines.
6. Logging: `safeRequestUrlForLog` redacts query values but prints the raw path. A share token in `/agentfs/share/<token>` would be logged, so scrub or truncate path segments after `/share/` and `/site/`, or skip the access log for those paths. Not done here.
7. Share/site pages are still broken behind a prefix (research finding, not retested here): root-absolute `/share/<token>/raw` and `/site/<token>/` URLs. Needs Taras's decision.
8. `HEAD` is not routed (matchRoute is method-exact). Not needed by Comb.
9. A client that disconnects mid-upload: `Readable.toWeb(req)` errors the upstream fetch, which becomes a 502 attempt on a closed socket. Harmless in the test but not specifically tested.
