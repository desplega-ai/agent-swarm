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

  if [ -n "$ARCHIL_API_DISK_NAME" ]; then
    echo "Mounting API disk ($ARCHIL_API_DISK_NAME) at /mnt/data..."
    mkdir -p /mnt/data
    archil mount "$ARCHIL_API_DISK_NAME" /mnt/data --region "$ARCHIL_REGION"
  fi

  if [ -n "$ARCHIL_SHARED_DISK_NAME" ]; then
    echo "Mounting shared disk ($ARCHIL_SHARED_DISK_NAME) at /workspace/shared..."
    mkdir -p /workspace/shared
    archil mount "$ARCHIL_SHARED_DISK_NAME" /workspace/shared --region "$ARCHIL_REGION"
  fi
  echo "===================="

  # Graceful unmount on shutdown (flushes pending data to backing store)
  cleanup_archil() {
    echo "Unmounting Archil disks..."
    archil unmount /mnt/data 2>/dev/null || true
    archil unmount /workspace/shared 2>/dev/null || true
  }
  trap cleanup_archil EXIT SIGINT SIGTERM
fi

# Print version banner and run the server
echo "=== Agent Swarm API v$(cat /app/package.json | grep '"version"' | cut -d'"' -f4) ==="
echo "Port: $PORT"
echo "Database: $DATABASE_PATH"
echo "=============================="

exec /usr/local/bin/agent-swarm-api
