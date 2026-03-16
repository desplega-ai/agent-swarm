---
date: 2026-03-11
researcher: claude
topic: Archil FUSE disk production setup — how it works and lessons learned
status: complete
---

# Archil FUSE Disk Production Setup

How the Archil shared/personal disk system works in production after the per-agent write isolation implementation (v1.41.0–v1.41.6). This document serves as a reference for future backend refactoring.

## Architecture Overview

Each swarm deployment has:
- **1 API disk** — exclusive mount at `/mnt/data`, holds SQLite database
- **1 shared disk** — `--shared` mount at `/workspace/shared` on all machines, per-agent write isolation via Archil delegations
- **N personal disks** — one per agent, exclusive mount at `/workspace/personal`, agent-private storage

## Boot Sequence (Two-Phase)

### Phase 1: API boots first (`api-entrypoint.sh`)

1. Mounts API disk exclusively with `--force`: `archil mount --force $ARCHIL_API_DISK_NAME /mnt/data`
   - No `--shared` flag — exclusive gives reliable SQLite I/O
   - `--force` reclaims stale delegations from previous machine incarnations
   - v1.41.6 fix: was `--shared` before, caused FUSE hangs
   - v1.41.7 fix: added `--force` for stale delegation recovery

2. Mounts shared disk with `--shared`, pre-creates top-level dirs:
   ```bash
   archil mount --shared $ARCHIL_SHARED_DISK_NAME /workspace/shared
   for category in thoughts memory downloads misc; do
     mkdir -p "/workspace/shared/$category"
     chmod 777 "/workspace/shared/$category"
   done
   ```

3. **Critical**: Unmounts and remounts to release parent-level delegations:
   ```bash
   archil unmount /workspace/shared
   archil mount --shared $ARCHIL_SHARED_DISK_NAME /workspace/shared
   ```
   Without this, the API would hold delegations on `thoughts/`, `memory/`, etc., blocking workers from creating subdirs.

### Phase 2: Workers boot (`docker-entrypoint.sh`)

1. Mount shared disk with `--shared`:
   ```bash
   sudo archil mount --shared $ARCHIL_SHARED_DISK_NAME /workspace/shared
   ```

2. Mount personal disk with `--force` (reclaims stale delegations from destroyed machines):
   ```bash
   sudo archil mount --force $ARCHIL_PERSONAL_DISK_NAME /workspace/personal
   sudo chown worker:worker /workspace/personal
   ```

3. Create per-agent directories using `sudo` (FUSE root is owned by root):
   ```bash
   for category in thoughts memory downloads misc; do
     sudo mkdir -p /workspace/shared/$category/$AGENT_ID
     sudo chown worker:worker /workspace/shared/$category/$AGENT_ID
     sudo archil checkout /workspace/shared/$category/$AGENT_ID
   done
   ```
   - `mkdir` auto-grants delegation at the subdir level (because top-level dirs already exist)
   - `chown` gives the worker user UNIX write permission
   - `checkout` makes the delegation persistent (survives reconnects)

4. Create standard subdirectories (within owned dirs, no sudo needed):
   ```bash
   mkdir -p /workspace/shared/thoughts/$AGENT_ID/{plans,research,brainstorms}
   mkdir -p /workspace/shared/downloads/$AGENT_ID/slack
   ```

## Directory Layout

```
/workspace/
├── personal/              # Exclusive per-agent disk
│   ├── todos.md
│   └── ...
└── shared/                # Shared disk (--shared mount)
    ├── thoughts/
    │   ├── <agent-1-id>/
    │   │   ├── plans/
    │   │   ├── research/
    │   │   └── brainstorms/
    │   └── <agent-2-id>/
    │       └── ...
    ├── memory/
    │   ├── <agent-1-id>/
    │   └── <agent-2-id>/
    ├── downloads/
    │   ├── <agent-1-id>/
    │   │   └── slack/
    │   └── <agent-2-id>/
    └── misc/
        ├── <agent-1-id>/
        └── <agent-2-id>/
```

## Write Isolation Model

| Operation | Result |
|-----------|--------|
| Agent writes to own dir (`thoughts/$AGENT_ID/`) | Succeeds |
| Agent writes to other agent's dir | Fails: "Read-only file system" |
| Agent writes to top-level dir (`thoughts/rogue.txt`) | Fails: "Permission denied" (root-owned) |
| Agent reads any file on shared disk | Succeeds (shared mode) |

## Guardrails (Runtime)

### Hook-based guardrails (`src/hooks/hook.ts`)

Only active when `ARCHIL_MOUNT_TOKEN` is set:

1. **`isOwnedSharedPath()`** (line ~79) — checks if a path is within the agent's owned shared directories
2. **PreToolUse guard** (line ~835) — blocks Write/Edit tool calls targeting non-owned shared paths before execution
3. **PostToolUse guard** (line ~874) — detects "Read-only file system" errors in tool output and hints the agent to use its own subdirectory

### System prompt guidance (`src/prompts/base-prompt.ts`)

The base prompt includes shared disk directory layout documentation regardless of Archil, describing the per-agent directory convention. When Archil is enabled, additional guardrail hints are injected.

## Env Vars (Set by Deploy Script)

| Variable | Example | Purpose |
|----------|---------|---------|
| `ARCHIL_MOUNT_TOKEN` | `key-abc123...` | Auth token for Archil CLI |
| `ARCHIL_SHARED_DISK_NAME` | `org_xxx/swarm-zynap-shared` | Shared disk identifier |
| `ARCHIL_PERSONAL_DISK_NAME` | `org_xxx/swarm-zynap-personal-agentid` | Per-agent personal disk |
| `ARCHIL_API_DISK_NAME` | `org_xxx/swarm-zynap-api` | API data disk |
| `ARCHIL_REGION` | `aws-eu-west-1` | Archil region for mount |
| `AGENT_ID` | `b8cf84f7-ca73-...` | Agent UUID (used for subdir names) |

## Lessons Learned (Production Debugging)

### 1. FUSE permissions are per-mount, not persisted to R2
API machine's `chmod 777` does NOT propagate to worker machines' mounts. Each machine has its own FUSE layer with independent UNIX permissions. Workers must `sudo mkdir` + `sudo chown` their own dirs.

### 2. `mkdir -p` auto-grants delegation at the FIRST NEW parent
`mkdir -p thoughts/agent-1/plans` when `thoughts/` doesn't exist → delegation on `thoughts/` (too broad!). When `thoughts/` already exists → delegation on `thoughts/agent-1` (correct). This is why the API must pre-create top-level dirs.

### 3. Personal disks need `--force` on recreated machines
When machines are destroyed and recreated, stale delegations remain. `--force` reclaims them. Safe because personal disks are single-client.

### 4. Exclusive mount with `--force` for single-client disks
The API disk should NOT use `--shared` — it caused FUSE hangs that froze the entire API process. Shared mode is slower and less reliable when only one client accesses the disk. Must also use `--force` to reclaim stale delegations from previous machine incarnations (same reason as personal disks).

### 5. `chown` on shared FUSE mounts risks triggering root delegation
A `chown` is a write operation that could auto-grant delegation on the mount root. Use `sudo mkdir` + `sudo chown` on specific subdirs only, not on the mount root.

### 6. Docker build `cancel-in-progress`
The CI workflow has `cancel-in-progress: true`. Rapid pushes cancel intermediate builds, so `:latest` may point to an older version. Push once and wait for the full build. The deploy script now resolves image tags to `@sha256:...` digests to mitigate this.

## Files Reference

| File | What it does |
|------|-------------|
| `api-entrypoint.sh` | API boot: mount API disk (exclusive), mount shared disk, pre-create top-level dirs, unmount/remount |
| `docker-entrypoint.sh` | Worker boot: mount shared (--shared), mount personal (--force), create per-agent dirs with sudo |
| `src/hooks/hook.ts` | Runtime guardrails: PreToolUse blocks, PostToolUse error detection |
| `src/prompts/base-prompt.ts` | System prompt: directory layout docs, Archil guardrail hints |
| `src/slack/files.ts` | Slack file downloads: uses `downloads/$AGENT_ID/slack/` path |
| `src/tools/slack-download-file.ts` | Slack download tool: same path convention |
| `scripts/deploy-swarm.ts` (internal repo) | Deploy script: creates Archil disks, sets env vars, resolves image digests |

## Future Work / Backend Refactoring Notes

When refactoring the backend to be more Archil-aware:

1. **Database location**: SQLite lives on the API disk at `/mnt/data/agent-swarm-db.sqlite`. Currently hardcoded via `DATABASE_PATH` env var. The exclusive mount makes this reliable.

2. **Shared writes via API**: Currently deferred. If agents need to write to shared locations (e.g., shared plans), they should go through the API which holds no shared disk delegations (released at boot). The API would need a dedicated write endpoint.

3. **Memory indexing**: The `memory/$AGENT_ID/` directory is where agents store memory files. The hook system indexes these. Cross-agent memory reads work via shared mount.

4. **Graceful unmount**: Both entrypoints have `trap cleanup_archil EXIT INT TERM` to flush pending data on shutdown. Important for data integrity.

5. **Monitoring**: No alerting on FUSE hangs currently. The API disk hang was only caught via health check failure. Consider adding FUSE health probes.
