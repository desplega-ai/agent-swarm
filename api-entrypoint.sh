#!/bin/sh
set -e

# Archil disk mounts (skipped when ARCHIL_MOUNT_TOKEN is not set)
if [ -n "$ARCHIL_MOUNT_TOKEN" ]; then
  echo ""
  echo "=== Archil Mount ==="

  # Ensure /dev/fuse exists (needed in some VM environments like Fly.io Firecracker)
  if [ ! -e /dev/fuse ]; then
    mknod /dev/fuse c 10 229
    chmod 666 /dev/fuse
  fi

  # NOTE: API data disk (/mnt/data) is now a Fly volume, auto-mounted by Fly.
  # No Archil mount needed for it.

  if [ -n "$ARCHIL_SHARED_DISK_NAME" ]; then
    echo "Mounting shared disk ($ARCHIL_SHARED_DISK_NAME) at /workspace/shared..."
    mkdir -p /workspace/shared
    archil mount --shared "$ARCHIL_SHARED_DISK_NAME" /workspace/shared --region "$ARCHIL_REGION"

    # Pre-create top-level shared directories so that workers' mkdir
    # auto-grants delegation at the SUBDIR level (e.g., thoughts/$AGENT_ID),
    # not the parent level (thoughts/). Then unmount/remount to release
    # the parent-level delegations this mkdir created.
    echo "Pre-creating shared directory structure..."
    for category in thoughts memory downloads misc; do
      mkdir -p "/workspace/shared/$category" 2>/dev/null || true
      # API runs as root; make dirs world-writable so worker user can
      # create per-agent subdirs. Safe because Archil delegations (not
      # UNIX perms) enforce write isolation between agents.
      chmod 777 "/workspace/shared/$category" 2>/dev/null || true
    done
    archil unmount /workspace/shared 2>/dev/null || true
    archil mount --shared \
      --region "$ARCHIL_REGION" "$ARCHIL_SHARED_DISK_NAME" /workspace/shared
    echo "Shared directory structure ready (delegations released)"
  fi
  echo "===================="

  # Graceful unmount on shutdown (flushes pending data to backing store)
  cleanup_archil() {
    echo "Unmounting Archil disks..."
    archil unmount /workspace/shared 2>/dev/null || true
  }
  trap cleanup_archil EXIT INT TERM
fi

# Print version banner and run the server
echo "=== Agent Swarm API v$(cat /app/package.json | grep '"version"' | cut -d'"' -f4) ==="
echo "Port: $PORT"
echo "Database: $DATABASE_PATH"
echo "=============================="

exec /usr/local/bin/agent-swarm-api
