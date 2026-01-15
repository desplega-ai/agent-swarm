---
date: 2026-01-15T02:35:00Z
researcher: Researcher (16990304-76e4-4017-b991-f3e37b34cf73)
git_commit: N/A (workspace not a git repo)
branch: N/A
repository: agent-swarm
topic: "How to automatically start predefined processes (e.g. psql, redis) in worker Docker containers"
tags: [research, docker, containers, process-management, s6-overlay, supervisord, worker-agents]
status: complete
autonomy: autopilot
last_updated: 2026-01-15
last_updated_by: Researcher
---

# Research: Auto-Starting Predefined Processes in Worker Docker Containers

**Date**: 2026-01-15T02:35:00Z
**Researcher**: Researcher (16990304-76e4-4017-b991-f3e37b34cf73)
**Git Commit**: N/A (workspace not a git repo)
**Branch**: N/A

## Research Question

How to automatically start predefined processes (e.g. psql, redis) in worker Docker containers for agent-swarm, including analysis of current mechanisms, process manager options, and configuration approaches.

## Summary

This research analyzes approaches for running multiple services (like PostgreSQL, Redis) inside single Docker containers for worker agents. The current agent-swarm ecosystem uses simple entrypoint scripts with PM2 for Node.js process management. For more complex multi-process scenarios, **s6-overlay** emerges as the recommended modern solution, offering proper PID 1 handling, service dependencies, and container-native design.

---

## 1. Current Container Startup Mechanisms in Agent-Swarm

### 1.1 Current Approaches Found in Codebase

The workspace contains several Docker-related projects with different initialization approaches:

#### Content-Agent (`/workspace/shared/content-agent/docker/`)

**Dockerfile** (`/workspace/shared/content-agent/docker/Dockerfile`):
- Base: `python:3.11-slim`
- Installs: git, curl, Node.js, GitHub CLI, Claude CLI
- Uses bash entrypoint script
- Single main process: `python main.py --mode daemon`

**Entrypoint** (`/workspace/shared/content-agent/docker/entrypoint.sh`):
```bash
#!/bin/bash
set -e

# Initialization checks
- GitHub CLI auth check
- Symlink creation for shared prompts
- Database initialization
- Claude CLI availability check

# Execute main command
exec "$@"
```

**Key characteristics:**
- Simple bash-based initialization
- Single-process container design
- Uses `exec` for proper signal handling
- No process manager beyond the main application

#### Desplega.ai Backend (`/workspace/shared/desplega.ai/be/`)

**Dockerfile** (`/workspace/shared/desplega.ai/be/Dockerfile`):
- Multi-stage build with `python:3.12-slim-bookworm`
- Uses `uv` for Python dependency management
- Includes Playwright/Chromium for browser automation
- Generic entrypoint expecting runtime specification

```dockerfile
ENTRYPOINT ["/bin/bash", "-c"]
CMD ["echo 'Specify api or worker as entrypoint at runtime'"]
```

**Key characteristics:**
- Flexible runtime command specification
- Single-process per container pattern
- No embedded process manager

#### Your-News Backend (`/workspace/shared/your-news/backend/`)

**PM2 Ecosystem** (`/workspace/shared/your-news/backend/ecosystem.config.js`):
```javascript
module.exports = {
  apps: [
    { name: 'your-news-api', script: './dist/index.js', ... },
    { name: 'your-news-email-poller', script: './dist/scripts/email-poller.js', ... },
    { name: 'your-news-scheduler', script: './dist/scripts/run-scheduler.js', ... }
  ]
};
```

**Key characteristics:**
- Uses PM2 for multi-process management
- Three related Node.js processes
- Autorestart, logging, max_restarts configured
- This is the closest to multi-process management in current codebase

### 1.2 Current Agent-Swarm Worker Environment

Based on the current workspace structure (`/workspace`):
- Workers run in isolated containers with:
  - Personal directory: `/workspace/personal`
  - Shared directory: `/workspace/shared`
  - PM2 for service management (`.pm2` directory present)
  - MCP configuration for agent-swarm API communication

The current setup assumes:
- Single Claude Code process as the main worker
- External services (databases, etc.) accessed via network
- PM2 available for background service management

---

## 2. Process Manager Options Comparison

### 2.1 Comparison Matrix

| Feature | tini | dumb-init | supervisord | s6-overlay | runit | PM2 |
|---------|------|-----------|-------------|------------|-------|-----|
| **Multi-process** | No | No | Yes | Yes | Yes | Yes (Node.js) |
| **Exit on child failure** | Yes | Yes | No | Yes | Partial | Configurable |
| **Zombie reaping** | Yes | Yes | Yes | Yes | Yes | Yes |
| **Signal forwarding** | Yes | Yes | Limited | Yes | Issues | Yes |
| **Dependency management** | No | No | No | Yes | No | No |
| **Graceful shutdown** | Yes | Yes | Limited | Yes | Limited | Yes |
| **Configuration** | CLI | CLI | INI files | Directories | Directories | JS/JSON |
| **Image size impact** | ~10KB | ~20KB | Large (Python) | ~2MB | ~500KB | ~50MB |
| **Container-native** | Yes | Yes | No | Yes | No | Partial |
| **Language** | C | C | Python | C | C | Node.js |

### 2.2 Detailed Analysis

#### tini / dumb-init (Minimal Init Systems)

**Best for**: Single-process containers needing proper PID 1 handling

```dockerfile
# Using Docker's built-in tini
docker run --init myimage

# Or in docker-compose.yml
services:
  myapp:
    init: true
```

**Limitations**: Cannot manage multiple direct child processes, no supervision.

#### supervisord

**Best for**: Legacy applications, teams familiar with INI configuration

```ini
[supervisord]
nodaemon=true

[program:nginx]
command=/usr/sbin/nginx -g "daemon off;"
autostart=true
autorestart=true

[program:redis]
command=/usr/bin/redis-server
autostart=true
autorestart=true
```

**Critical Issue**: Does not exit when child processes fail - container orchestrators won't detect failures.

#### s6-overlay (Recommended)

**Best for**: Production multi-process containers, complex service dependencies

**Directory structure**:
```
/etc/s6-overlay/s6-rc.d/
├── user/contents.d/
│   ├── postgres    # Empty file enables service
│   └── redis
├── postgres/
│   ├── type        # "longrun"
│   ├── run         # Start script
│   └── dependencies.d/
│       └── base
└── redis/
    ├── type
    ├── run
    └── dependencies.d/
        └── base
```

**Key advantages**:
- Container exits when main service fails
- Proper dependency ordering
- Graceful shutdown handling
- Minimal footprint (~2MB)

#### PM2 (Current in Agent-Swarm)

**Best for**: Node.js applications, already present in agent-swarm

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    { name: 'service1', script: './service1.js', ... },
    { name: 'service2', script: './service2.js', ... }
  ]
};
```

**Current usage**: Already used for service registry in agent-swarm workers.

### 2.3 Recommendation Summary

| Use Case | Recommendation |
|----------|----------------|
| Single-process container | `docker run --init` (built-in tini) |
| Multi-process with dependencies | **s6-overlay** |
| Node.js multi-process | PM2 (already available) |
| Legacy/simple multi-process | supervisord (with caveats) |
| **Flexible team deployments** | **Docker Compose sidecar services** (Recommended) |

---

## 3. Approaches for Running PostgreSQL/Redis in Worker Containers

### 3.1 Option A: External Services (Current Pattern)

Workers connect to external PostgreSQL/Redis instances via environment variables:

```bash
DATABASE_URL=postgresql://user:pass@db-host:5432/dbname
REDIS_URL=redis://redis-host:6379
```

**Pros**: Clean separation, easier scaling, standard Docker pattern
**Cons**: Network latency, external dependency management

### 3.2 Option B: Embedded Services with s6-overlay

Full PostgreSQL + Redis in container:

```dockerfile
FROM alpine:3.19

ARG S6_OVERLAY_VERSION=3.2.0.0

# Install s6-overlay
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz

# Install services
RUN apk add --no-cache postgresql16 redis

# Service configurations (see section 4 for details)
COPY rootfs/ /

ENTRYPOINT ["/init"]
```

**Service definition** (`/etc/s6-overlay/s6-rc.d/postgres/run`):
```bash
#!/command/execlineb -P
su postgres -c "postgres -D /var/lib/postgresql/data"
```

### 3.3 Option C: Hybrid with PM2 (Leveraging Existing Infrastructure)

Since PM2 is already present, extend ecosystem.config.js:

```javascript
module.exports = {
  apps: [
    // Background services (if needed)
    {
      name: 'redis-server',
      script: '/usr/bin/redis-server',
      args: '--daemonize no --port 6379',
      interpreter: 'none',
      autorestart: true
    },
    // Main worker processes
    {
      name: 'claude-worker',
      script: '/path/to/worker.js',
      // ...
    }
  ]
};
```

**Note**: PM2 works best with Node.js; for system services like PostgreSQL, s6-overlay is more appropriate.

### 3.4 Option D: Docker Compose Sidecar Services (Recommended for Flexibility)

**Best for**: Teams deploying the swarm who want maximum flexibility and control over their infrastructure.

Instead of embedding services within worker containers, teams can add services as sidecar containers in their Docker Compose configuration. This is the most flexible approach as it allows each deployment to choose exactly which services they need without modifying the base worker image.

```yaml
# docker-compose.yml
version: '3.8'

services:
  # Worker agent container
  worker:
    image: desplega/agent-swarm-worker:latest
    environment:
      DATABASE_URL: postgresql://postgres:password@postgres:5432/worker
      REDIS_URL: redis://redis:6379
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - worker-network

  # PostgreSQL sidecar
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: password
      POSTGRES_DB: worker
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - worker-network

  # Redis sidecar
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - worker-network

volumes:
  postgres-data:
  redis-data:

networks:
  worker-network:
    driver: bridge
```

**Pros**:
- **Maximum flexibility**: Each team decides which services they need
- **Clean separation**: Services run in isolated containers with their own resources
- **Standard Docker patterns**: Leverages well-understood Docker Compose conventions
- **Easy scaling**: Services can be scaled independently
- **No image modification**: Base worker image stays lean and generic
- **Health checks built-in**: Docker Compose handles service health and dependencies
- **Official images**: Use maintained official images for PostgreSQL, Redis, etc.

**Cons**:
- Requires Docker Compose for orchestration
- Slightly higher network latency vs embedded services
- Each deployment needs to manage their own compose file

**When to use**: This is the **recommended approach** for most deployments. It provides the best balance of flexibility, maintainability, and separation of concerns. Teams can easily add, remove, or swap services without any changes to the core agent-swarm infrastructure.

---

## 4. Proposed Configuration Format for Worker Services

### 4.1 Recommended: YAML-Based Service Definition

Create a `worker-services.yaml` that defines which services each worker needs:

```yaml
# /workspace/config/worker-services.yaml
version: "1.0"

services:
  # Service definitions
  postgresql:
    enabled: false
    image_install: "apk add postgresql16"
    init_script: |
      if [ ! -d "/var/lib/postgresql/data/base" ]; then
        su postgres -c "initdb -D /var/lib/postgresql/data"
      fi
    run_command: "postgres -D /var/lib/postgresql/data"
    run_user: postgres
    port: 5432
    healthcheck: "pg_isready -U postgres"
    depends_on: []

  redis:
    enabled: false
    image_install: "apk add redis"
    run_command: "redis-server --daemonize no --port 6379"
    port: 6379
    healthcheck: "redis-cli ping"
    depends_on: []

  custom_service:
    enabled: false
    run_command: "/path/to/custom/service"
    depends_on: ["postgresql"]

# Worker profiles - which services each worker type needs
profiles:
  default:
    services: []

  database-worker:
    services:
      - postgresql
      - redis

  cache-worker:
    services:
      - redis

  full-stack:
    services:
      - postgresql
      - redis
      - custom_service
```

### 4.2 Environment Variable Configuration

Workers specify their profile via environment:

```bash
# In worker container
WORKER_SERVICES_PROFILE=database-worker
# Or specific services
WORKER_SERVICES=postgresql,redis
```

### 4.3 Startup Script Integration

A unified startup script reads the config and sets up services:

```bash
#!/bin/bash
# /usr/local/bin/worker-init.sh

set -e

CONFIG_FILE="${WORKER_SERVICES_CONFIG:-/workspace/config/worker-services.yaml}"
PROFILE="${WORKER_SERVICES_PROFILE:-default}"
SERVICES="${WORKER_SERVICES:-}"

# Parse YAML config (using yq or similar)
if [ -n "$SERVICES" ]; then
    enabled_services="$SERVICES"
else
    enabled_services=$(yq ".profiles.$PROFILE.services[]" "$CONFIG_FILE" | tr '\n' ' ')
fi

# Start each enabled service
for service in $enabled_services; do
    echo "Starting service: $service"

    # Check dependencies
    deps=$(yq ".services.$service.depends_on[]" "$CONFIG_FILE" 2>/dev/null || echo "")
    for dep in $deps; do
        wait_for_service "$dep"
    done

    # Run init script if exists
    init_script=$(yq ".services.$service.init_script" "$CONFIG_FILE")
    if [ -n "$init_script" ] && [ "$init_script" != "null" ]; then
        eval "$init_script"
    fi

    # Start service (via s6-overlay or PM2)
    run_cmd=$(yq ".services.$service.run_command" "$CONFIG_FILE")
    run_user=$(yq ".services.$service.run_user" "$CONFIG_FILE")

    if [ "$run_user" != "null" ]; then
        su "$run_user" -c "$run_cmd" &
    else
        $run_cmd &
    fi
done

# Execute main worker command
exec "$@"
```

### 4.4 s6-overlay Integration

For s6-overlay, generate service directories from config:

```bash
#!/bin/bash
# /etc/s6-overlay/scripts/setup-services.sh

CONFIG_FILE="/workspace/config/worker-services.yaml"

for service in $(yq '.services | keys[]' "$CONFIG_FILE"); do
    enabled=$(yq ".services.$service.enabled" "$CONFIG_FILE")
    if [ "$enabled" = "true" ]; then
        mkdir -p "/etc/s6-overlay/s6-rc.d/$service/dependencies.d"

        # Create type file
        echo "longrun" > "/etc/s6-overlay/s6-rc.d/$service/type"

        # Create run script
        run_cmd=$(yq ".services.$service.run_command" "$CONFIG_FILE")
        cat > "/etc/s6-overlay/s6-rc.d/$service/run" << EOF
#!/command/execlineb -P
$run_cmd
EOF
        chmod +x "/etc/s6-overlay/s6-rc.d/$service/run"

        # Enable service
        touch "/etc/s6-overlay/s6-rc.d/user/contents.d/$service"

        # Set up dependencies
        for dep in $(yq ".services.$service.depends_on[]" "$CONFIG_FILE" 2>/dev/null); do
            touch "/etc/s6-overlay/s6-rc.d/$service/dependencies.d/$dep"
        done
    fi
done
```

---

## 5. Recommended Implementation Approach

### 5.0 Recommended: Docker Compose Sidecar Services

**For most deployments, the sidecar approach is recommended.** Instead of embedding services in worker containers, let each team deploying the swarm choose which services to add to their docker-compose.yml as sidecar services.

**Why this is preferred:**
- Zero changes needed to the base worker image
- Teams have full control over their infrastructure
- Standard Docker Compose patterns that everyone understands
- Easy to add/remove services per deployment needs
- Official images with security updates managed upstream

**Implementation**: Simply document the sidecar pattern (see Section 3.4) and provide example docker-compose.yml snippets for common services. No code changes required.

#### 5.0.1 Service Auto-Discovery

For agents to discover available sidecar services, there are several approaches:

1. **Environment Variables (Recommended)**: Services are exposed to agents via standard environment variables injected by Docker Compose:
   ```yaml
   services:
     worker:
       environment:
         DATABASE_URL: postgresql://postgres:password@postgres:5432/worker_${WORKER_ID}
         REDIS_URL: redis://redis:6379
         # Service availability flags
         HAS_POSTGRES: "true"
         HAS_REDIS: "true"
   ```
   Agents can check for `HAS_*` environment variables or attempt connection to `DATABASE_URL`/`REDIS_URL` to discover what's available.

2. **Service Registry (For Complex Deployments)**: The agent-swarm already has a service registry (`register-service`, `list-services` MCP tools). Sidecar services can be registered at startup via an init container or startup script:
   ```yaml
   services:
     service-registrar:
       image: alpine
       command: |
         # Register postgres service to agent-swarm registry
         curl -X POST "$SWARM_API/services" -d '{"name":"postgres","url":"postgres:5432"}'
       depends_on:
         - postgres
   ```

3. **DNS-Based Discovery**: Docker Compose creates a network where services are discoverable by their service name. Agents can simply try to connect to well-known hostnames (`postgres`, `redis`, `mysql`) and use what's available.

#### 5.0.2 Database Isolation per Worker

**Critical point: Each worker MUST have its own isolated database to prevent data conflicts and ensure security.**

There are two main strategies:

**Strategy A: Dedicated Database Instance per Worker (Recommended for full isolation)**
```yaml
services:
  worker-1:
    environment:
      DATABASE_URL: postgresql://postgres:password@postgres-worker-1:5432/worker
    depends_on:
      - postgres-worker-1

  postgres-worker-1:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: worker
    volumes:
      - postgres-worker-1-data:/var/lib/postgresql/data

  worker-2:
    environment:
      DATABASE_URL: postgresql://postgres:password@postgres-worker-2:5432/worker
    depends_on:
      - postgres-worker-2

  postgres-worker-2:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: worker
    volumes:
      - postgres-worker-2-data:/var/lib/postgresql/data

volumes:
  postgres-worker-1-data:
  postgres-worker-2-data:
```

**Strategy B: Shared Database Instance with Separate Databases/Schemas (More resource-efficient)**
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: password
    volumes:
      - ./init-worker-dbs.sql:/docker-entrypoint-initdb.d/init.sql
      - postgres-data:/var/lib/postgresql/data

  worker-1:
    environment:
      DATABASE_URL: postgresql://worker1:password@postgres:5432/worker1_db

  worker-2:
    environment:
      DATABASE_URL: postgresql://worker2:password@postgres:5432/worker2_db

# init-worker-dbs.sql:
# CREATE DATABASE worker1_db;
# CREATE USER worker1 WITH PASSWORD 'password';
# GRANT ALL PRIVILEGES ON DATABASE worker1_db TO worker1;
# CREATE DATABASE worker2_db;
# CREATE USER worker2 WITH PASSWORD 'password';
# GRANT ALL PRIVILEGES ON DATABASE worker2_db TO worker2;
```

**Why isolation matters:**
- **Data integrity**: Workers may run arbitrary code that could corrupt shared data
- **Security**: Workers should not be able to access other workers' data
- **Debugging**: Isolated databases make it easier to trace issues to specific workers
- **Cleanup**: When a worker is removed, its data can be cleanly deleted

**For Redis**, similar isolation can be achieved using:
- Separate Redis instances per worker (full isolation)
- Redis databases (`SELECT 0`, `SELECT 1`, etc.) for logical separation
- Key prefixing (`worker-1:*`, `worker-2:*`) for namespace isolation

### 5.1 Alternative: Short-Term (Minimal Changes)

If embedded services are required, **use PM2 ecosystem files** already available in workers:

1. Create service scripts in worker container
2. Register services via existing PM2 infrastructure
3. Use `register-service` MCP tool for discovery

```javascript
// ecosystem.config.js extension
const workerServices = process.env.WORKER_SERVICES?.split(',') || [];

const serviceConfigs = {
  redis: {
    name: 'redis-server',
    script: '/usr/bin/redis-server',
    args: '--daemonize no',
    interpreter: 'none'
  }
};

module.exports = {
  apps: [
    ...workerServices.map(s => serviceConfigs[s]).filter(Boolean),
    // ... existing apps
  ]
};
```

### 5.2 Medium-Term (Proper Multi-Process)

**Adopt s6-overlay** for robust multi-process management:

1. Update base Dockerfile to include s6-overlay
2. Create service definition templates
3. Generate s6-rc configurations from YAML config
4. Implement health checks for all services

### 5.3 Long-Term (Full Configuration System)

1. Build configuration parser for `worker-services.yaml`
2. Create service template library (PostgreSQL, Redis, MySQL, etc.)
3. Implement service dependency graph resolution
4. Add monitoring/alerting for embedded services
5. Consider sidecar pattern for Kubernetes deployments

---

## 6. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Worker Container                          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              s6-overlay (PID 1)                      │    │
│  │  ┌─────────────┬─────────────┬─────────────────┐    │    │
│  │  │   Service   │   Service   │     Main        │    │    │
│  │  │  PostgreSQL │    Redis    │   Worker App    │    │    │
│  │  │  (optional) │  (optional) │  (Claude Code)  │    │    │
│  │  └─────────────┴─────────────┴─────────────────┘    │    │
│  │                    ↑                                 │    │
│  │           Dependencies managed by s6-rc              │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Configuration Layer                     │    │
│  │  worker-services.yaml → WORKER_SERVICES_PROFILE env  │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    Volumes                           │    │
│  │  /workspace/personal  /workspace/shared  /var/lib/* │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. Code References

| File | Description |
|------|-------------|
| `/workspace/shared/content-agent/docker/entrypoint.sh` | Example bash entrypoint with init logic |
| `/workspace/shared/content-agent/docker/Dockerfile` | Simple single-process Dockerfile |
| `/workspace/shared/your-news/backend/ecosystem.config.js` | PM2 multi-process configuration |
| `/workspace/shared/desplega.ai/be/Dockerfile` | Multi-stage build with flexible entrypoint |
| `/workspace/.mcp.json` | MCP configuration for agent-swarm communication |

---

## 8. Open Questions

1. **Resource allocation**: How much memory/CPU should be reserved for embedded services vs. main worker?
2. **Data persistence**: Should embedded databases persist across container restarts?
3. **Service discovery**: How should workers advertise their embedded services to the swarm?
4. **Security**: What isolation should exist between embedded services and the main worker process?
5. **Monitoring**: How to expose health metrics for embedded services to the swarm coordinator?

---

## 9. Sources

### Process Management
- [Docker Official: Multi-Service Containers](https://docs.docker.com/engine/containers/multi-service_container/)
- [s6-overlay GitHub](https://github.com/just-containers/s6-overlay)
- [tini GitHub](https://github.com/krallin/tini)
- [dumb-init GitHub](https://github.com/Yelp/dumb-init)
- [PM2 Documentation](https://pm2.keymetrics.io/docs/)

### Multi-Process Patterns
- [Choosing an init process for multi-process containers](https://ahmet.im/blog/minimal-init-process-for-containers/)
- [Container Init Systems Comparison 2025](https://kyle.cascade.family/posts/a-comparison-of-container-init-systems-in-2025/)
- [s6-overlay Quickstart Guide](https://platformengineers.io/blog/s6-overlay-quickstart/)

### Docker Compose Alternatives
- [Kompose - Compose to Kubernetes](https://kompose.io/)
- [Podman Pods](https://www.redhat.com/en/blog/compose-podman-pods)
- [GitLab Runner Docker Executor](https://docs.gitlab.com/runner/executors/docker/)
