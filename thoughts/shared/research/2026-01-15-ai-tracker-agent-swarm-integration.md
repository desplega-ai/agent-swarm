# Research: Integrating ai-tracker into Agent-Swarm Workers

**Date**: 2026-01-15
**Researcher**: Agent 16990304-76e4-4017-b991-f3e37b34cf73 (Researcher)
**Task ID**: e53f61b4-68df-448b-ba9e-821c39dbf41f

---

## Executive Summary

This research investigates integrating `ai-tracker` from the `desplega-ai/ai-toolbox` repository into agent-swarm workers for automatic usage tracking. The key finding is that **ai-tracker currently uses a fixed SQLite storage path** (`~/.config/ai-tracker/tracker.db`), which will require modifications to support per-agent databases in a shared location.

---

## 1. ai-tracker Architecture and Capabilities

### 1.1 Overview

**Source**: [desplega-ai/ai-toolbox/ai-tracker](https://github.com/desplega-ai/ai-toolbox/tree/main/ai-tracker)
**Package Name**: `cc-ai-tracker` (PyPI)
**License**: MIT
**Python Support**: 3.11, 3.12, 3.13

**Purpose**: Track the percentage of code changes in git repositories that are AI-generated (via Claude Code) versus human-made.

### 1.2 Core Components

The system operates through three integrated components:

| Component | Function |
|-----------|----------|
| **Claude Code Hooks (PostToolUse)** | Captures Edit/Write operations with line-level counts when Claude Code modifies files |
| **Git Post-commit Hook** | Attributes committed changes to either AI or human sources based on the edit log |
| **CLI Statistics** | Queries the SQLite database and displays formatted results using Rich formatting |

### 1.3 Data Flow

```
┌─────────────────────┐    ┌──────────────────┐    ┌───────────────┐
│   Claude Code       │───▶│  PostToolUse     │───▶│   SQLite DB   │
│   (Edit/Write)      │    │  Hook            │    │   (edits)     │
└─────────────────────┘    └──────────────────┘    └───────────────┘
                                                          │
                                                          ▼
┌─────────────────────┐    ┌──────────────────┐    ┌───────────────┐
│   Git Commit        │───▶│  Post-commit     │───▶│   SQLite DB   │
│                     │    │  Hook            │    │   (commits)   │
└─────────────────────┘    └──────────────────┘    └───────────────┘
```

### 1.4 Current Storage Configuration

| Setting | Value |
|---------|-------|
| **Database Location** | `~/.config/ai-tracker/tracker.db` (FIXED) |
| **Database Mode** | SQLite with WAL (Write-Ahead Logging) |
| **Config Directory** | `~/.config/ai-tracker/` |
| **Git Hooks Directory** | `~/.config/ai-tracker/git-hooks/` |
| **Cache Directory** | `~/.config/ai-tracker/cache/` |

### 1.5 Database Schema

**Table: `edits`**
- timestamp, session_id, tool_type (Edit/Write)
- file_path, lines_added, lines_removed
- working_directory, committed (boolean)

**Table: `commits`**
- commit_sha, repository_path
- ai_lines_added, ai_lines_removed
- human_lines_added, human_lines_removed
- timestamp

**Table: `commit_files`**
- commit_id (FK to commits)
- file_path
- ai_lines, human_lines

### 1.6 CLI Commands

```bash
ai-tracker install     # Install Claude Code + git hooks
ai-tracker uninstall   # Remove all hooks
ai-tracker stats       # Show all-time statistics
ai-tracker stats --graph --days 14  # Custom period chart
ai-tracker stats --repo my-project  # Filter by repository
```

### 1.7 Dependencies

- **rich** >= 13.0.0 (terminal formatting)
- **plotext** >= 5.0.0 (terminal charts)
- **click** >= 8.0.0 (CLI framework)

---

## 2. Agent-Swarm Worker Architecture

### 2.1 Worker Location and Structure

**Location**: `/workspace/shared/desplega.ai/be/worker/`

| File | Purpose |
|------|---------|
| `__init__.py` | Worker singleton initialization with Hatchet SDK |
| `healthcheck.py` | Healthcheck task definition |
| `utils.py` | Worker utilities (region-based worker selection) |
| `affinity.py` | Worker affinity/labeling system |
| `main_worker.py` | Main worker entry point (50+ workflows) |

### 2.2 Worker Initialization

```python
# /workspace/shared/desplega.ai/be/worker/__init__.py
class Worker:
    _instance = None
    _initialized = False

    def __init__(self):
        if self._initialized:
            return
        self.hatchet = Hatchet(
            debug=os.getenv("HATCHET_DEBUG", "false").lower() == "true",
        )
        self._initialized = True

worker = Worker()
hatchet = worker.hatchet
```

### 2.3 Worker Configuration

```python
# /workspace/shared/desplega.ai/be/main_worker.py
worker = hatchet.worker(
    f"desplega-worker-{worker_name}",
    labels={
        "name": worker_name,
        "org_id": org_id,
        "version": config.VERSION,
        "region": region,
    },
    slots=1000 if region == "auto" else 100,
    lifespan=lifespan,
    workflows=[...],  # 50+ registered workflows
)
```

### 2.4 Environment Variables

| Variable | Purpose |
|----------|---------|
| `WORKER_NAME` | Worker instance name (default: "default") |
| `WORKER_ORG_ID` | Organization ID to process (default: "all") |
| `WORKER_REGION` | Region affinity (default: "auto") |
| `HATCHET_DEBUG` | Enable debug mode |
| `IN_WORKER` | Flag indicating running in worker context |

### 2.5 Existing Telemetry Integration

The agent-swarm workers already have **comprehensive OpenTelemetry instrumentation**:

```python
# /workspace/shared/desplega.ai/be/config/__init__.py
if self.ENV == "production":
    AsyncioInstrumentor().instrument()

    if os.getenv("IN_WORKER", "false").lower() == "true":
        from hatchet_sdk.opentelemetry.instrumentor import HatchetInstrumentor
        HatchetInstrumentor(
            tracer_provider=get_tracer_provider(),
            config=ClientConfig(otel=OpenTelemetryConfig()),
        ).instrument()
```

**Instrumented Libraries** (30+ packages):
- AsyncIO, FastAPI, ASGI, Starlette
- Asyncpg, SQLAlchemy, Psycopg, SQLite3
- HTTPx, Requests, AIOHTTP
- Celery, Boto3 SQS, Redis, gRPC

### 2.6 Lifecycle Hooks

```python
# /workspace/shared/desplega.ai/be/main_worker.py
async def lifespan() -> AsyncGenerator[Lifespan, None]:
    with acx.use():
        yield Lifespan()

    # Cleanup: dispose database engine on shutdown
    try:
        from db.async_db import engine
        await engine.dispose()
    except Exception as e:
        logging.error(f"Error disposing database engine: {e}")
```

---

## 3. Integration Points in Agent-Swarm Workers

### 3.1 Potential Integration Points

| Integration Point | Location | Description |
|-------------------|----------|-------------|
| **Worker Initialization** | `worker/__init__.py` | Initialize ai-tracker with agent-specific DB path |
| **Lifespan Hook** | `main_worker.py:lifespan()` | Flush tracking data on shutdown |
| **OpenTelemetry** | `config/__init__.py` | Add ai-tracker as a custom span processor |
| **Context Manager** | `ctx/ctx.py:acx` | Propagate tracking context across async operations |
| **Healthcheck** | `worker/healthcheck.py` | Include tracking stats in health responses |

### 3.2 Recommended Integration Approach

**Option A: Hook-Based Integration (Recommended)**
- Inject ai-tracker hooks at worker startup
- Configure per-agent DB path via environment variable
- Minimal changes to existing worker code

**Option B: Middleware/Decorator Integration**
- Create a tracking decorator for workflow tasks
- Wrap each workflow function with tracking logic
- More invasive but provides finer control

**Option C: OpenTelemetry Exporter**
- Create custom OTEL exporter that writes to ai-tracker DB
- Leverages existing instrumentation
- Most elegant but requires OTEL knowledge

---

## 4. Configuration Strategy for Shared Storage

### 4.1 Current Limitation

ai-tracker currently has a **hardcoded storage path**:
```python
DB_PATH = Path.home() / ".config" / "ai-tracker" / "tracker.db"
```

This must be modified to support configurable paths.

### 4.2 Proposed Configuration Model

```python
# Environment variable approach
TRACKER_DB_PATH = os.environ.get(
    "AI_TRACKER_DB_PATH",
    f"/workspace/shared/tracking/{agent_id}.db"
)
```

### 4.3 Per-Agent Database Structure

```
/workspace/shared/tracking/
├── 16990304-76e4-4017-b991-f3e37b34cf73.db   # Agent 1
├── d454d1a5-4df9-49bd-8a89-e58d6a657dc3.db   # Agent 2 (Lead)
├── 38d36438-58a0-45b5-8602-a5d52b07c2f1.db   # Agent 3
└── aggregated/
    └── combined_stats.db                       # Optional: aggregated view
```

### 4.4 Implementation Approach

**Step 1: Fork/Modify ai-tracker**
```python
# ai_tracker/config.py
import os

def get_db_path(agent_id: str | None = None) -> Path:
    """Get database path, supporting per-agent configuration."""
    if custom_path := os.environ.get("AI_TRACKER_DB_PATH"):
        return Path(custom_path)

    if agent_id:
        base_dir = os.environ.get(
            "AI_TRACKER_SHARED_DIR",
            "/workspace/shared/tracking"
        )
        return Path(base_dir) / f"{agent_id}.db"

    # Default fallback
    return Path.home() / ".config" / "ai-tracker" / "tracker.db"
```

**Step 2: Worker Integration**
```python
# worker/__init__.py
import os
from ai_tracker import configure_tracker

class Worker:
    def __init__(self):
        if self._initialized:
            return

        # Configure ai-tracker with agent-specific path
        agent_id = os.environ.get("AGENT_ID")
        configure_tracker(
            db_path=f"/workspace/shared/tracking/{agent_id}.db"
        )

        self.hatchet = Hatchet(...)
        self._initialized = True
```

**Step 3: Lifespan Hook Integration**
```python
# main_worker.py
async def lifespan() -> AsyncGenerator[Lifespan, None]:
    from ai_tracker import tracker

    with acx.use():
        yield Lifespan()

    # Flush tracker before shutdown
    try:
        await tracker.flush()
    except Exception as e:
        logging.error(f"Error flushing tracker: {e}")

    # Existing cleanup...
```

---

## 5. Challenges and Considerations

### 5.1 Technical Challenges

| Challenge | Impact | Mitigation |
|-----------|--------|------------|
| **Fixed DB Path** | High | Fork ai-tracker and add configurable paths |
| **SQLite Concurrency** | Medium | WAL mode already enabled; consider connection pooling |
| **Claude Code Hooks** | High | Agent workers may not run Claude Code directly |
| **Git Hook Integration** | Medium | Workers may not perform git commits |

### 5.2 Architecture Considerations

1. **What to Track in Agent-Swarm Context?**
   - Original ai-tracker tracks Claude Code Edit/Write operations
   - Agent-swarm workers may not use Claude Code directly
   - **Consider**: Track task completions, API calls, tool usage instead

2. **Alternative Tracking Scope**
   - Track MCP tool invocations
   - Track Hatchet workflow executions
   - Track file modifications via any tool
   - Track API request/response metrics

3. **Data Aggregation**
   - Per-agent DBs are good for isolation
   - May need aggregation service for cross-agent analytics
   - Consider using existing OTEL infrastructure instead

### 5.3 Potential Blockers

1. **ai-tracker is Claude Code Specific**
   - The hooks are designed for PostToolUse in Claude Code
   - Agent-swarm workers use Hatchet SDK, not Claude Code directly
   - **Recommendation**: Either modify ai-tracker significantly or create a new tracking component

2. **Different Data Model Needed**
   - ai-tracker tracks code changes (lines added/removed)
   - Agent-swarm needs to track task execution, tool calls, API usage
   - The schemas don't align well

---

## 6. Recommendations

### 6.1 Short-Term (Quick Win)

If the goal is to track Claude Code usage within worker containers:
1. Fork `cc-ai-tracker` and add `AI_TRACKER_DB_PATH` environment variable support
2. Install the modified package in worker Docker image
3. Configure per-agent paths via Docker environment

### 6.2 Medium-Term (Better Integration)

Create a new tracking component inspired by ai-tracker but designed for agent-swarm:
1. Use the same SQLite + WAL approach
2. New schema for task/tool tracking instead of code changes
3. Integrate with OpenTelemetry for span correlation
4. Per-agent DBs in shared location

### 6.3 Long-Term (Production Ready)

Leverage existing OpenTelemetry infrastructure:
1. Create custom OTEL exporter for tracking data
2. Store in TimescaleDB/ClickHouse for analytics
3. Use OTEL spans for correlation
4. Grafana dashboards for visualization

---

## 7. Proposed New Schema (If Building Custom Tracker)

```sql
-- Agent activity tracking
CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    task_count INTEGER DEFAULT 0,
    tool_calls INTEGER DEFAULT 0
);

-- Task execution tracking
CREATE TABLE task_executions (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES agent_sessions(id),
    task_id TEXT NOT NULL,
    task_type TEXT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    status TEXT,  -- 'completed', 'failed', 'cancelled'
    duration_ms INTEGER
);

-- Tool/API call tracking
CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_execution_id TEXT REFERENCES task_executions(id),
    tool_name TEXT NOT NULL,
    called_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    duration_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    success BOOLEAN
);

-- File modification tracking (similar to original ai-tracker)
CREATE TABLE file_modifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_execution_id TEXT REFERENCES task_executions(id),
    file_path TEXT NOT NULL,
    modification_type TEXT,  -- 'create', 'edit', 'delete'
    lines_added INTEGER DEFAULT 0,
    lines_removed INTEGER DEFAULT 0,
    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 8. Conclusion

### Key Findings

1. **ai-tracker** is a well-designed tool for tracking Claude Code usage, but it has:
   - Fixed storage path requiring modification
   - Schema designed for code changes, not task execution
   - Hooks specific to Claude Code PostToolUse

2. **Agent-swarm workers** have:
   - Comprehensive OpenTelemetry instrumentation already
   - Clear lifecycle hooks for integration
   - Environment-based configuration patterns

3. **Integration Options**:
   - **Minimal**: Fork ai-tracker, add configurable paths
   - **Moderate**: Create agent-swarm specific tracker
   - **Comprehensive**: Extend OTEL infrastructure

### Next Steps

1. Decide on tracking scope (code changes vs task execution vs both)
2. Fork ai-tracker to add configurable DB path support
3. Create integration PR for worker initialization
4. Consider building agent-swarm specific tracking component long-term

---

## Appendix: File Paths Referenced

| File | Purpose |
|------|---------|
| `/workspace/shared/desplega.ai/be/worker/__init__.py` | Worker singleton |
| `/workspace/shared/desplega.ai/be/main_worker.py` | Main entry point |
| `/workspace/shared/desplega.ai/be/config/__init__.py` | OTEL configuration |
| `/workspace/shared/desplega.ai/be/ctx/ctx.py` | Context management |
| `/workspace/shared/desplega.ai/be/worker/healthcheck.py` | Health checks |
| `/workspace/shared/desplega.ai/be/worker/affinity.py` | Worker affinity |

---

*Research completed: 2026-01-15*
