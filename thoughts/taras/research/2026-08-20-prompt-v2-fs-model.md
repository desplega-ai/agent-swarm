---
date: 2026-08-20
researcher: Claude (research subagent)
git_commit: 4942e49e1c5c6b35d4beaed814712307f2b2a4f7
branch: main
repository: agent-swarm
topic: "Current filesystem model for agents: /workspace conventions vs agent-fs, what a v2 system prompt must still teach"
tags: [research, agent-fs, workspace, filesystem, prompt-templates, session-templates, docker-entrypoint, fs-provider]
status: complete
---

# Filesystem model for agents: /workspace vs agent-fs (for prompt v2)

## Question

What is the current, supported filesystem model for agents in the swarm, and which parts
of the old `/workspace/...` conventions are still load-bearing (code-enforced) versus
prompt-convention only? Goal: give the v2 system prompt rewrite a concrete, evidence-based
answer to "what must we still teach."

## Summary

agent-fs is a real, merged, first-class feature (PR #850, `0e4ee9f6`, plus a dozen
follow-up fixes through `24a3ff6a`), but it is **optional and off by default in the primary
production deployment path** (Helm chart, `agentFs.enabled: false`). It is bundled and
always-on in the docker-compose local/example stacks (no `profiles:` gate). The system
prompt already reflects this: the `system.agent.agent_fs` template block only renders
`if (process.env.AGENT_FS_API_URL)` (`src/prompts/base-prompt.ts:358`), and its own text
tells the agent to stop using `/workspace/shared/thoughts/` for thoughts/docs "when
agent-fs is available" while explicitly keeping local disk for "repos, artifacts, scripts,
and any non-thought data" (`src/prompts/session-templates.ts:395-397`).

Meanwhile a large amount of `/workspace/...` plumbing is genuinely code-enforced,
independent of agent-fs: identity file sync (SOUL.md/IDENTITY.md/TOOLS.md/HEARTBEAT.md/
start-up.sh), the PostToolUse memory-indexing hook, repo clone paths, directory creation at
container boot, and the local-fs fallback for task attachments. None of that goes away if
agent-fs is enabled — agent-fs only replaces the *documents/thoughts* half of the picture,
and only for the subset of deployments that turn it on.

## (a) What is code-enforced today

| Path / mechanism | Reader / writer | file:line |
|---|---|---|
| `/workspace/SOUL.md`, `/workspace/IDENTITY.md`, `/workspace/TOOLS.md`, `/workspace/HEARTBEAT.md` | Written from DB at session start | `src/commands/runner.ts:5234-5286` (writes); constants also in `src/hooks/hook.ts:32-36`, `src/commands/profile-sync.ts:40-44` |
| Same identity files, self-edit sync back to DB | PostToolUse hook (`Write`/`Edit` on those exact paths) | `src/hooks/hook.ts:1205-1216` calls `syncIdentityFilesToServer` |
| `/workspace/start-up.sh` (agent-managed section) | Written once if absent at session start; edits synced back | write: `src/commands/runner.ts:5257-5266`; self-edit sync: `src/hooks/hook.ts:1244-1246` (`startsWith("/workspace/start-up")` → `syncSetupScriptToServer`) |
| `/workspace/personal/memory/*` and `/workspace/shared/memory/{agentId}/*` | PostToolUse hook auto-indexes any `Write`/`Edit` under these prefixes into `/api/memory/index` | `src/hooks/hook.ts:1253-1290` (exact prefix check at 1256-1257) |
| `/workspace/personal/memory` directory | Created + chowned at container boot (unconditional) | `docker-entrypoint.sh:349-352` |
| `/workspace/personal/todos.md` | Created with template content if missing at boot | `docker-entrypoint.sh:775-780` (`PERSONAL_DIR="/workspace/personal"`) |
| `/workspace/shared/{thoughts,memory,downloads,misc}/{agentId}/` | Per-agent subdirectories created at boot (`AGENT_ID` required) | `docker-entrypoint.sh:795` ("Setting up per-agent directories for $AGENT_ID...") |
| `/workspace/personal/repos/<repo>` | VCS repo clone target path, built from task's `vcsRepo` | `src/commands/runner.ts:5501` and `:5950` |
| `/workspace/logs/*.jsonl` | Session log sink; scrubbed via `scrubSecrets` at egress | referenced in `src/utils/secret-scrubber.ts:8`, `src/providers/codex-adapter.ts:662,1743`, `src/commands/context-preamble.ts:261` |
| Task file attachments (`store-progress` attachments, UI download) | Server-side `FileStorageProvider`: `AgentFsProvider` if `AGENT_FS_API_URL` + (`API_AGENT_FS_API_KEY` or `AGENT_FS_API_KEY`) are set, else `LocalFsProvider` (disk under `./data/fs` or `AGENT_FS_LOCAL_DIR`) | selection: `src/fs/registry.ts:15-21`; local fallback: `src/fs/local-fs-provider.ts:18-28` |
| `/api/fs/*` HTTP routes (capabilities, agent-credentials, members/invite, task file CRUD incl. binary upload/download/signed-url) | `src/http/fs.ts` (596 lines) | route defs `src/http/fs.ts:44-165`; dispatcher `handleFs` `src/http/fs.ts:172+` |
| agent-fs per-agent credential provisioning | Worker calls `POST /api/fs/agent-credentials` once per session; API server owns the bootstrap key and stores an agent-scoped secret — key never leaves the server | caller: `src/commands/runner.ts:755-792` (`ensureAgentFsCredentials`); server: `src/be/seed/agent-fs-provision.ts` (510 lines), route in `src/http/fs.ts:71-83` |
| agent-fs shared org/drive bootstrap (org `swarm`, drive `shared`) | Boot-time seeder, synchronous before HTTP server binds, 10s timeout so an unreachable agent-fs can't hang boot | `src/be/seed/agent-fs-provision.ts:44,60-75` |
| `agent-fs` CLI + skill install in the worker image | Pinned via `npx skills` + npm global install; version pin `ARG AGENT_FS_VERSION=0.13.0` drives both | `Dockerfile.worker:207-221` (skill), `:294-310` (global npm dep) |
| Scripts-runtime `fsMode` | `"none"` = per-run tmpdir sandbox (v1, no `/workspace` access); `"workspace-rw"` hard-rejected with `stderr: "workspace-rw not supported in scripts-runtime v1"` | `src/scripts-runtime/loader.ts:68-77`; type `src/be/scripts/typecheck.ts:35` |
| Agent-fs env propagation into a running worker | `AGENT_FS_SHARED_ORG_ID` is one of the few live-reloadable env keys; runner copies it from `fetchResolvedEnv` back into `process.env` so `getBasePrompt()` sees it | `src/commands/runner.ts:3278-3282`, `RELOADABLE_ENV_KEYS` set at `src/commands/runner.ts:842` |
| `system.agent.agent_fs` prompt block gating | Only rendered `if (process.env.AGENT_FS_API_URL)` | `src/prompts/base-prompt.ts:358-361` |
| `system.agent.filesystem` prompt block | Always rendered (not gated) — teaches `/workspace/personal`, `/workspace/shared/{thoughts,memory,downloads,misc}/{agentId}/`, `/workspace/personal/todos.md`, memory dirs | `src/prompts/session-templates.ts:245-323` |

## (b) What is prompt-convention only

These are documented in `system.agent.filesystem` / `system.agent.agent_fs` /
`templates/skills/*` but have **no code that reads or enforces the specific sub-path** —
the directory exists (created generically at boot) but nothing on the server side branches
on it beyond the memory-index prefix match already listed in (a):

- `/workspace/shared/thoughts/{agentId}/{plans,research,brainstorms}/` — convention only.
  `docker-entrypoint.sh:795`'s per-agent setup creates the `thoughts` category directory
  generically (see comment "category (thoughts, memory, downloads, misc)" near
  `docker-entrypoint.sh:790`), but no server code reads `thoughts/` content; discovery is
  `ls`/`memory-search` by the agent itself, per `session-templates.ts:269-272`.
- `/workspace/shared/downloads/{agentId}/`, `/workspace/shared/misc/{agentId}/` — same:
  directories created generically, no server-side reader.
- `/workspace/TOOLS.md` *content* conventions ("repos, ports, SSH hosts...",
  `session-templates.ts:280-282`) — the *file* is code-synced (see table a), but what goes
  inside it is prompt guidance only.
- agent-fs path conventions (`thoughts/{type}/YYYY-MM-DD-topic.md`,
  `misc/{agentId}/name.ext`, `docs/name.md`) taught in
  `session-templates.ts:337-393` and mirrored in `templates/skills/artifacts/content.md` —
  these are agent-fs CLI-side conventions the swarm server never inspects (per the
  2026-06-25 research doc: "swarm server never opens a socket to agent-fs" for
  non-attachment writes).
- The "Discovering other agents' work" `ls`/`memory-search` guidance
  (`session-templates.ts:269-272`) is a workflow convention, not enforced.

## (c) agent-fs status: merged, but optional-by-deployment

**Merged and iterated, not experimental.** `git log --oneline --all | grep -i agent-fs`
shows the foundational PR merged as `0e4ee9f6 First-class agent-fs support foundation
(#850)`, preceded by a 6-phase build-out (`b059c045` provider interface,
`6141e8d0` provisioning seeder, `b0b9fc20` co-deployment docs) and followed by ~15 fix/chore
commits through `24a3ff6a fix(chart): bump agent-fs image pin to 0.13.0` (most recent).
The 2026-06-25 research doc (`thoughts/taras/research/2026-06-25-agent-fs-first-class.md`,
issue #813) identified gaps — server-side `/api/fs/*` client, binary upload, deterministic
provisioning, docker-compose recipe — that are **all now present** in the current tree
(`src/http/fs.ts`, `src/fs/registry.ts`, `src/be/seed/agent-fs-provision.ts`,
`docker-compose.local.yml:46-*`). So the gaps identified pre-#850 are closed.

**Not always-on.** Two independent gates:

1. **Prompt gate**: `system.agent.agent_fs` only renders when `AGENT_FS_API_URL` is set
   (`src/prompts/base-prompt.ts:358`). Confirmed live in
   `thoughts/taras/research/2026-08-20-prompt-variants/00-INDEX.md` variant matrix — the
   `agent_fs` env var is present only in the "everything on" variants (03, 04, 05-08,
   11-12); it's the one row toggled between minimal and full variants alongside Slack.
2. **Deployment gate**: `charts/agent-swarm/values.yaml:224-225` — `agentFs.enabled: false`
   by default in the Helm chart, the primary production/K8s path. Comment at
   `values.yaml:218-223`: "When disabled (default) agents fall back to local-only
   filesystem operations on their personal PVC. The upstream session prompt auto-detects
   this and adapts." By contrast, `docker-compose.local.yml` and `docker-compose.example.yml`
   define an `agent-fs` + `minio`/`minio-init` service block with **no `profiles:` gate**
   (only `codex-worker` is profile-gated, `docker-compose.local.yml:219`), and both compose
   files set `AGENT_FS_API_URL=http://agent-fs:7433` unconditionally on the api/lead/worker
   services (`docker-compose.local.yml:100,144,190,240`). So local/example compose bundles
   agent-fs by default; Helm (prod) does not.
3. `DEPLOYMENT.md` and `runbooks/local-development.md` have **zero mentions** of agent-fs —
   operators following those docs alone would not learn it exists or how to enable it. It's
   documented only in `runbooks/docker-images.md` (image-size context) and
   `runbooks/skills.md` (skill delivery mechanism), not as a feature/setup guide.

**Net**: agent-fs is real, finished infrastructure, correctly gated, but silently
absent unless an operator opts in on Helm, or is implicitly present because they used the
bundled docker-compose stack. A v2 prompt cannot assume it exists.

## (d) Recommended canonical story for the v2 system prompt

1. Keep `/workspace/personal/`, `/workspace/personal/todos.md`, `/workspace/TOOLS.md`,
   `/workspace/start-up.sh`, `/workspace/HEARTBEAT.md` — all code-synced, always true.
2. Keep the two memory dirs (`/workspace/personal/memory/`,
   `/workspace/shared/memory/{agentId}/`) — the PostToolUse indexing hook only watches these
   exact prefixes; this is non-negotiable regardless of agent-fs.
3. Keep repo-clone location (`/workspace/personal/repos/<repo>`) — code sets this path,
   agent-fs has no VCS clone story.
4. Drop `/workspace/shared/thoughts/{agentId}/{plans,research,brainstorms}/` from the
   always-taught block; move it into the `system.agent.agent_fs`-gated block as the
   explicit fallback-when-agent-fs-is-absent, matching the existing "Do NOT use the local
   filesystem... when agent-fs is available" line (`session-templates.ts:395-397`).
5. Keep `/workspace/shared/{downloads,misc}/{agentId}/` in the base block — agent-fs
   text itself still routes large/binary artifacts to local disk (`artifacts` skill,
   "agent-fs write is text-only and mangles binaries").
6. Keep the `AGENT_FS_API_URL` gate on the whole agent-fs section — do not make it
   unconditional; production Helm deployments genuinely may not have it.
7. Move the agent-fs CLI path-convention detail (thoughts/{type}/…, misc/{agentId}/…,
   docs/name.md, comment commands) out of the system prompt into the already-installed
   `agent-fs` skill (`agent-fs docs` is already the pointed-to reference,
   `session-templates.ts:334-335`) — the skill and the prompt currently duplicate this.
8. Reconcile `templates/skills/artifacts/content.md` with the prompt: it independently
   re-documents `/workspace/shared/{downloads,misc}/` and the agent-fs decision table;
   consolidate to one source (prefer the skill, since it's already the fuller reference)
   and have the prompt block just point to it.
9. No change needed for scripts-runtime: `fsMode: "workspace-rw"` is already rejected in v1
   (`src/scripts-runtime/loader.ts:68-77`) — nothing to teach there beyond "scripts get no
   filesystem."
10. Add one line operators can act on: "agent-fs is off by default on Helm; enable via
    `agentFs.enabled: true`" — currently undocumented outside `values.yaml` comments.
