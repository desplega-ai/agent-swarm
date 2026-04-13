---
date: 2026-03-11T12:00:00Z
topic: "Archil Shared Disk Write Access Strategies"
author: "Claude (research for Taras)"
status: complete
tags: [research, archil, shared-disk, multi-agent, ownership, concurrency, fly-io]
---

# Archil Shared Disk Write Access Strategies

## Problem Statement

We run 3 workers + 1 lead on Fly.io, each in its own Docker container. All mount the same Archil shared disk at `/workspace/shared` using `--shared` flag. Archil's delegation model grants **exclusive write ownership** to one client at a time per file/directory (recursive). The per-agent directories (`thoughts/$AGENT_ID/`) are fine because each agent checks out its own subtree. The problem is with **truly shared write targets**:

| Shared Write Target | Who Writes | Current Status |
|---|---|---|
| `/workspace/shared/thoughts/shared/plans/` | Any agent | **Broken** - first mkdir winner owns it, others get EPERM |
| `/workspace/shared/thoughts/shared/research/` | Any agent | **Broken** - same issue |
| `/workspace/shared/memory/` | Any agent (via Write/Edit tool) | **Broken** - same issue |
| `/workspace/shared/downloads/slack/` | Any agent (via slack-download-file) | **Broken** - same issue |

## Archil's Delegation Model

### From Official Docs + SDK

> "Archil uses a delegation model for writes. Before you can write to a file, you 'check out' a delegation on it -- this tells the server you intend to modify it and gives you exclusive access. When you're done, you 'check in' to release it so other clients can write."

```ts
await client.checkout(inodeId);    // Acquire exclusive write delegation
await client.writeData(inodeId, 0, Buffer.from('new contents'));
await client.sync();               // Ensure write is durable on server
await client.checkin(inodeId);     // Release delegation
```

Key properties:
1. **Exclusive delegation**: Only ONE client can own a file/dir at a time
2. **Recursive ownership**: Owning a directory = owning ALL children. No parent of an owned dir can be owned by another client (ancestry constraint)
3. **`archil checkout /path`**: Requests exclusive access. Fails if another client already owns it
4. **`archil checkin /path`**: Releases the delegation so others can write
5. **`archil checkout --force /path`**: Revokes another client's ownership. **Dangerous**: may lose un-fsynced writes from the evicted client
6. **`mkdir` on unowned dir**: Auto-grants ownership to the creator
7. **On `archil unmount`**: All ownership claims are released automatically

Example from docs:
```
/(cannot be owned)
  group/(cannot be owned)  <-- because child is owned
    models/(owned by client A)
      model1.txt
      model2.txt
    data/(ownership available)
      data.txt
```

## Current Architecture

### Archil Disk Topology

```
Swarm: {appName}
+-- {appName}-api              (--shared mount on API container at /mnt/data)
+-- {appName}-shared           (--shared mount on ALL containers at /workspace/shared)
+-- {appName}-personal-{id1}   (exclusive mount on agent1 at /workspace/personal)
+-- {appName}-personal-{id2}   (exclusive mount on agent2 at /workspace/personal)
+-- {appName}-personal-{id3}   (exclusive mount on agent3 at /workspace/personal)
+-- {appName}-personal-{lead}  (exclusive mount on lead at /workspace/personal)
```

### Current Entrypoint Behavior

From `docker-entrypoint.sh`:

```bash
# These dirs are created at boot - first agent to boot wins ownership
mkdir -p /workspace/shared/thoughts/shared/plans \
         /workspace/shared/thoughts/shared/research \
         /workspace/shared/memory 2>/dev/null || true

# Later, per-agent checkout (this works fine)
archil checkout "/workspace/shared/thoughts/$AGENT_ID"
mkdir -p "$AGENT_THOUGHTS_DIR/plans" "$AGENT_THOUGHTS_DIR/research"
```

The `mkdir -p` with `|| true` silently swallows EPERM from agents that lose the race. Only the first-booting agent can actually write to `thoughts/shared/` and `memory/`.

### Write Patterns in the Codebase

| Path | Writers | Trigger | Code Location |
|------|---------|---------|---------------|
| `thoughts/$AGENT_ID/{plans,research}/` | Single agent (owner) | /desplega:research, /desplega:create-plan | `base-prompt.ts:96,116` |
| `thoughts/shared/{plans,research}/` | Any agent | /desplega:create-plan | `base-prompt.ts:219` |
| `memory/` | Any agent | Write/Edit hook auto-indexes | `hook.ts:863-864`, `base-prompt.ts:245` |
| `downloads/slack/` | Any agent | Slack file downloads | `slack-download-file.ts:14` |

**Already working via database (not affected):**
- `inject-learning`: Lead injects learnings into worker memory via API (database), NOT filesystem
- `store-progress`: Creates memory entries in the database, not filesystem
- `memory-search`: Queries the indexed database, not raw files

---

## Strategy Evaluation

### Strategy A: Per-Agent Subdirectories Everywhere

**Concept**: Restructure so nothing is truly shared for writes. Every agent writes only to its own area under the shared disk. "Shared" becomes read-only visibility via the shared mount.

```
/workspace/shared/
  thoughts/
    agent-1/{plans,research}/    # agent-1 owns (checkout at boot)
    agent-2/{plans,research}/    # agent-2 owns
    lead/{plans,research}/       # lead owns
  memory/
    agent-1/                     # agent-1 owns
    agent-2/                     # agent-2 owns
    lead/                        # lead owns
  downloads/
    agent-1/slack/               # agent-1 owns
    agent-2/slack/               # agent-2 owns
```

Agents read from any directory but only write to their own. The `thoughts/shared/` directory is eliminated.

**Changes required:**
1. `docker-entrypoint.sh`: Expand checkout to cover `memory/$AGENT_ID` and `downloads/$AGENT_ID`; remove `thoughts/shared` mkdir
2. `base-prompt.ts`: Direct all writes to `thoughts/{yourId}/`, `memory/{yourId}/`
3. `hook.ts` / `pi-mono-extension.ts`: Path detection already uses `startsWith("/workspace/shared/memory/")` so works unchanged
4. `slack-download-file.ts`: Change default save path to include `$AGENT_ID`

| Criterion | Rating | Notes |
|---|---|---|
| **Complexity** | Low | Mostly prompt + entrypoint changes |
| **Reliability** | Excellent | Zero race conditions - each agent owns its subtree exclusively |
| **Performance** | Excellent | No locking overhead, no checkout/checkin round-trips |
| **Agent workflow** | Medium | Agents scan multiple dirs for "shared" content. Reading is fine. |
| **Entrypoint changes** | Small | Expand checkout block, remove `thoughts/shared` mkdir |
| **Crash recovery** | Excellent | No shared state to corrupt |

**Risk**: Discovery is slightly harder (agents must scan N directories instead of one `shared/` dir).

**Verdict: RECOMMENDED -- Strong candidate**

---

### Strategy B: Rotating Ownership (Cooperative Checkout/Checkin)

**Concept**: Workers dynamically checkout/checkin shared directories when they need to write.

```bash
archil checkout /workspace/shared/memory
echo "content" > /workspace/shared/memory/my-file.md
sync
archil checkin /workspace/shared/memory
```

| Criterion | Rating | Notes |
|---|---|---|
| **Complexity** | High | Locking protocol, retry logic, deadlock prevention |
| **Reliability** | Poor | Race conditions, crash orphaning (held until unmount), starvation |
| **Performance** | Poor | Checkout round-trip + sync + checkin per write; contention cascades |
| **Agent workflow** | None (paths stay same) | |
| **Crash recovery** | Poor | Crashed agent holds ownership until container restarts |

**Key risks:**
- Agent checks out dir, enters a long thinking phase = others blocked for minutes
- Archil checkout is recursive on directories, so locking `memory/` locks ALL memory files
- Crash between checkout and checkin = dir locked until FUSE unmount

**Verdict: NOT RECOMMENDED -- Too fragile for agent workloads**

---

### Strategy C: Single Writer Pattern (Lead/API as Sole Shared Writer)

**Concept**: Designate the API server (or lead) as the sole writer to shared directories. Workers submit writes via MCP API tool.

```
Workers -> MCP tool (write-shared-file) -> API server -> writes to shared disk
```

| Criterion | Rating | Notes |
|---|---|---|
| **Complexity** | Medium | New API endpoint + MCP tool |
| **Reliability** | Good | Single writer = no conflicts |
| **Performance** | Acceptable | Extra network hop, but writes are infrequent |
| **Agent workflow** | High impact | Workers can't use `Write` tool for shared paths |
| **Crash recovery** | Good | API restarts release ownership |

**Key risks:**
- Agents are trained to use `Write` tool -- hard to redirect 100% of the time
- Read-after-write consistency through FUSE may show stale data

**Verdict: VIABLE but breaks natural file-write UX**

---

### Strategy D: Separate Archil Disks Per Agent

**Concept**: Give each agent its own Archil disk. Remove or keep shared disk read-only.

| Criterion | Rating | Notes |
|---|---|---|
| **Complexity** | High | Lose cross-agent filesystem reads |
| **Reliability** | Excellent | No shared write conflicts |
| **Performance** | Good | No contention |
| **Agent workflow** | Very High impact | Can't `cat` other agents' files at all |

**Verdict: NOT RECOMMENDED -- Kills the key benefit of shared filesystem (cross-agent reads)**

---

### Strategy E: Hybrid (Shared Disk for Reads + API for Shared Writes)

**Concept**: Keep shared disk for reads. Route shared-area writes through the API server.

```
Per-agent writes:  Agent -> FUSE -> /workspace/shared/thoughts/$AGENT_ID/ (agent owns)
Shared writes:     Agent -> MCP tool -> API -> /workspace/shared/thoughts/shared/
Reads:             Agent -> FUSE -> /workspace/shared/* (all readable)
```

| Criterion | Rating | Notes |
|---|---|---|
| **Complexity** | Medium | API endpoint + MCP tool + hook logic |
| **Reliability** | Good | Single writer for shared dirs |
| **Performance** | Good | Only shared writes have extra hop |
| **Agent workflow** | Medium-High | Two write patterns to learn |

**Verdict: VIABLE but adds complexity without clear advantage over Strategy A**

---

### Strategy F: Force Checkout with Coordination

**Concept**: Use `archil checkout --force` to revoke ownership + distributed lock layer.

| Criterion | Rating | Notes |
|---|---|---|
| **Complexity** | Very High | Distributed locking + force checkout |
| **Reliability** | Poor | `--force` risks data loss from un-fsynced writes |
| **Performance** | Poor | Lock + force checkout + sync + checkin + unlock per write |
| **Crash recovery** | Very Poor | Orphaned lock + potential data loss |

**Verdict: NOT RECOMMENDED -- Overcomplicated and data-loss prone**

---

### Strategy G: mkdir-Based Per-Write Directories

**Concept**: Exploit `mkdir` auto-ownership. Each write creates a unique subdirectory.

```
/workspace/shared/memory/
  1741690200-agent1-auth-fix/content.md    # agent-1 created & owns
  1741690500-agent2-db-pattern/content.md  # agent-2 created & owns
```

| Criterion | Rating | Notes |
|---|---|---|
| **Complexity** | Medium | Write wrapper + read aggregation |
| **Reliability** | Good | Unique names avoid races |
| **Performance** | Good | mkdir is fast |
| **Agent workflow** | High impact | Can't `cat memory/auth-fix.md` -- need directory scanning |
| **Cleanup** | Needed | Thousands of single-file directories accumulate |

**Verdict: CREATIVE but impractical -- Directory proliferation, read patterns break**

---

### Strategy H: Symlink Farm (Per-Agent Writes + Shared View)

**Concept**: Each agent writes to its own area. Background process maintains symlinks in a `shared/` view.

**Key problem**: Who owns the `shared/plans/` directory to create the symlinks? Same ownership problem, circular.

Also unclear if Archil's FUSE layer handles symlinks correctly across clients.

**Verdict: NOT RECOMMENDED -- Circular ownership problem**

---

### Strategy I: Per-Agent Writes + Database Discovery (Enhanced Strategy A)

**Concept**: Strategy A plus a database-backed discovery layer. Each agent writes to its own directories. Shared artifacts are registered via API for cross-agent discovery.

```
Agent writes:      /workspace/shared/thoughts/agent-1/plans/deploy-plan.md
Agent registers:   POST /api/shared-artifacts { path, type: "plan", tags: ["deploy"] }

Other agent finds: GET /api/shared-artifacts?type=plan -> [{ path: "thoughts/agent-1/plans/..." }]
Other agent reads: cat /workspace/shared/thoughts/agent-1/plans/deploy-plan.md
```

| Criterion | Rating | Notes |
|---|---|---|
| **Complexity** | Medium | Strategy A + a simple API endpoint |
| **Reliability** | Excellent | No shared write conflicts. Database is the coordination point. |
| **Performance** | Excellent | Direct writes, API discovery is fast |
| **Agent workflow** | Low impact | Write normally to own dirs. Discovery via memory-search (exists) or new tool. |
| **Entrypoint changes** | Small | Same as Strategy A |
| **Crash recovery** | Excellent | Database survives container restarts |

**Key insight**: Memory discovery already exists via `memory-search` MCP tool (queries indexed DB). Plans/research discovery is simple with `ls /workspace/shared/thoughts/*/plans/`.

**Verdict: RECOMMENDED -- Best of all worlds**

---

### Strategy J: Direct R2 Writes (Bypass Archil for Shared Writes)

**Concept**: For shared writes, bypass Archil FUSE entirely and write directly to backing R2 bucket.

| Criterion | Rating | Notes |
|---|---|---|
| **Complexity** | Medium | R2 write logic, bucket prefix mapping |
| **Reliability** | Medium | Eventual consistency -- written file may not be visible via FUSE immediately |
| **Performance** | High | Direct R2 writes, no delegation contention |
| **Agent workflow** | Medium | Reads may be stale |

**Verdict: NOT RECOMMENDED -- Consistency issues make this unreliable for collaborative workflows**

---

## Comparative Summary

| Strategy | Complexity | Reliability | Performance | UX Impact | Verdict |
|---|---|---|---|---|---|
| **A: Per-agent subdirs** | Low | Excellent | Excellent | Medium | **RECOMMENDED** |
| **B: Rotating ownership** | High | Poor | Poor | None | Not recommended |
| **C: Single writer** | Medium | Good | Acceptable | High | Viable |
| **D: Separate disks** | High | Excellent | Good | Very High | Not recommended |
| **E: Hybrid API writes** | Medium | Good | Good | Medium-High | Viable |
| **F: Force checkout** | Very High | Poor | Poor | High | Not recommended |
| **G: mkdir per-write** | Medium | Good | Good | High | Impractical |
| **H: Symlink farm** | High | Medium | Good | Low | Not recommended |
| **I: Per-agent + DB discovery** | Medium | Excellent | Excellent | Low | **RECOMMENDED** |
| **J: Direct R2** | Medium | Medium | High | Medium | Not recommended |

---

## Recommendation: Strategy A+I Hybrid

### Primary recommendation: Per-Agent Writes + Database Discovery

Combine Strategies A and I. This is the cleanest solution because:

1. **Zero race conditions**: Each agent exclusively owns its subtree. Archil works as designed.
2. **Minimal changes**: Entrypoint already does per-agent checkout for thoughts. Expand to memory + downloads.
3. **Reads still work**: All agents can `cat` any file on the shared disk. No API needed for reads.
4. **Discovery already exists for memory**: `memory-search` MCP tool queries the indexed database. All memory writes get auto-indexed by the PostToolUse hook regardless of path.
5. **Plans/research discovery is trivial**: `ls /workspace/shared/thoughts/*/plans/` or lightweight tool.

### What about `thoughts/shared/`?

Eliminate it. A plan written by agent-1 "for the swarm" is still agent-1's plan -- just readable by everyone via the shared mount. The concept of a "shared scratchpad" is unnecessary when every agent's directory is readable by all.

### Implementation Plan

#### Phase 1: Entrypoint changes (low risk, immediate)

```bash
# In docker-entrypoint.sh, REMOVE:
mkdir -p /workspace/shared/thoughts/shared/plans \
         /workspace/shared/thoughts/shared/research \
         /workspace/shared/memory 2>/dev/null || true

# REPLACE the per-agent checkout block with:
if [ -n "$AGENT_ID" ] && [ -n "$ARCHIL_MOUNT_TOKEN" ]; then
    AGENT_SHARED="/workspace/shared"
    for dir in "thoughts/$AGENT_ID" "memory/$AGENT_ID" "downloads/$AGENT_ID"; do
        sudo --preserve-env=ARCHIL_MOUNT_TOKEN archil checkout "$AGENT_SHARED/$dir" 2>/dev/null || true
        mkdir -p "$AGENT_SHARED/$dir"
    done
    mkdir -p "$AGENT_SHARED/thoughts/$AGENT_ID/plans"
    mkdir -p "$AGENT_SHARED/thoughts/$AGENT_ID/research"
fi
```

#### Phase 2: Prompt updates

Update `base-prompt.ts` to:
- Remove references to `/workspace/shared/thoughts/shared/`
- Direct agents to write plans/research to `/workspace/shared/thoughts/{yourId}/`
- Direct memory writes to `/workspace/shared/memory/{yourId}/`
- Add: "To see all agents' plans: `ls /workspace/shared/thoughts/*/plans/`"

#### Phase 3: Hook/extension updates

Update `hook.ts` and `pi-mono-extension.ts`:
- Memory auto-index path detection already uses `startsWith("/workspace/shared/memory/")` which will match `/workspace/shared/memory/$AGENT_ID/foo.md` -- no change needed
- The `isShared` scope detection uses same prefix -- also fine

#### Phase 4: Tool updates

- `slack-download-file.ts`: Default save to `/workspace/shared/downloads/${process.env.AGENT_ID}/slack/`
- Optional: Add `list-shared-artifacts` MCP tool for structured discovery

### Migration

- No data migration needed for new deployments
- Existing `thoughts/shared/` files remain read-only (no agent owns them after deploy)
- One-time migration script could move `thoughts/shared/*` to `thoughts/lead/*` if desired

---

## Open Questions

1. **Archil checkout on non-existent paths**: Can we `archil checkout /workspace/shared/memory/$AGENT_ID` before the directory exists? The current entrypoint does checkout then mkdir, suggesting checkout might create the path or work on non-existent paths. Needs validation.

2. **Multiple checkouts per client**: Can a single FUSE client checkout multiple non-overlapping subtrees simultaneously? (e.g., `thoughts/$AGENT_ID` AND `memory/$AGENT_ID`). The ancestry constraint docs suggest yes, since they don't share a parent that would conflict.

3. **Read propagation delay**: When agent-1 writes to its checked-out dir, how quickly does agent-2 see the new file via the shared FUSE mount? Near-instant (metadata server coordination) or delayed (cache invalidation)?

4. **AGENT_ID stability across deploys**: If AGENT_ID changes between deploys, old directories become orphaned. Need cleanup mechanism for long-lived shared disks.

5. **API server's shared mount**: The API server also mounts shared disk with `--shared`. If Strategy E fallback is ever needed, it would need its own checkout. Currently it only needs read access for serving files.

## Code References

| File | Relevant Lines | What |
|------|---------------|------|
| `agent-swarm/docker-entrypoint.sh` | 38-48 | Archil mount logic |
| `agent-swarm/docker-entrypoint.sh` | 55-58 | mkdir for shared dirs (the broken part) |
| `agent-swarm/docker-entrypoint.sh` | 477-486 | Per-agent checkout + mkdir |
| `agent-swarm/src/prompts/base-prompt.ts` | 96, 116 | Research/plan output paths |
| `agent-swarm/src/prompts/base-prompt.ts` | 215-220 | Workspace directory structure in prompt |
| `agent-swarm/src/prompts/base-prompt.ts` | 244-249 | Memory directory paths in prompt |
| `agent-swarm/src/hooks/hook.ts` | 863-864 | Memory file auto-indexing detection |
| `agent-swarm/src/hooks/hook.ts` | 870 | Shared vs personal scope detection |
| `agent-swarm/src/providers/pi-mono-extension.ts` | 473-474 | Memory write detection (pi-mono) |
| `agent-swarm/src/tools/slack-download-file.ts` | 14, 31 | Default download path |
| `agent-swarm/src/tools/inject-learning.ts` | 21 | DB-only writes (not affected) |
| `agent-swarm/src/tools/store-progress.ts` | 177-230 | DB-only writes (not affected) |
| `agent-swarm-internal/scripts/deploy-swarm.ts` | 39-63 | ensureArchilDisk function |
| `agent-swarm-internal/scripts/deploy-swarm.ts` | 297-324 | Agent machine config with Archil env vars |
| `agent-swarm-internal/scripts/deploy-swarm.ts` | 421-476 | Disk creation (shared + personal) |
