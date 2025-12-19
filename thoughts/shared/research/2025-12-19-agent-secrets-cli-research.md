---
date: 2025-12-19T14:25:00Z
researcher: master
git_commit: 470213538fb1227ec0c1347179d227d28817fca4
branch: main
repository: desplega-ai/ai-toolbox
topic: "Agent Secrets CLI Implementation Research"
tags: [research, codebase, cli, database, docker, secrets, encryption]
status: complete
last_updated: 2025-12-19
last_updated_by: master
---

# Research: Agent Secrets CLI Implementation

**Date**: 2025-12-19T14:25:00Z
**Researcher**: master
**Git Commit**: 470213538fb1227ec0c1347179d227d28817fca4
**Branch**: main
**Repository**: desplega-ai/ai-toolbox

## Research Question

How to implement a CLI tool called "agent-secrets" for managing encrypted secrets that agents can use. The tool will be shipped with the Docker image and documented in system prompts.

## Summary

This research documents the existing codebase structure for implementing the agent-secrets CLI tool. The project uses:
- **SQLite** via `bun:sqlite` for data storage
- **Bun-based CLI** with React/Ink for terminal UI
- **Docker multi-stage builds** for containerization
- **System prompt injection** via `--append-system-prompt` and custom commands

Notably, **no encryption patterns currently exist** in the codebase. The API key authentication uses plain text comparison. Implementing encrypted secrets will require introducing new cryptographic patterns.

## Detailed Findings

### 1. Database Structure and Patterns

**File**: `src/be/db.ts:18-174`

The project uses SQLite with Bun's built-in `bun:sqlite` module.

#### Database Configuration
- **Path**: `./agent-swarm-db.sqlite`
- **Pragmas**: WAL mode, foreign keys enabled
- **Pattern**: Singleton with `initDb()`, `getDb()`, `closeDb()`

#### Existing Tables

| Table | Purpose |
|-------|---------|
| `agents` | Agent registration and status |
| `agent_tasks` | Task assignments and progress |
| `agent_log` | Activity logging |
| `channels` | Communication channels |
| `channel_messages` | Messages in channels |
| `channel_read_state` | Message read tracking |

#### Table Creation Pattern

Tables are created with `CREATE TABLE IF NOT EXISTS` in a single `db.run()` call (`db.ts:27-124`):

```typescript
db.run(`
  CREATE TABLE IF NOT EXISTS table_name (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    -- more columns...
  );

  CREATE INDEX IF NOT EXISTS idx_table_name_column ON table_name (column);
`);
```

#### UUID Generation

Uses global `crypto.randomUUID()` (no import needed in Bun):

```typescript
const id = crypto.randomUUID();
```

#### Migration Pattern

Since SQLite lacks `ADD COLUMN IF NOT EXISTS`, migrations use try/catch (`db.ts:142-164`):

```typescript
try {
  db.run(`ALTER TABLE table_name ADD COLUMN new_column TEXT DEFAULT ''`);
} catch {
  /* column exists */
}
```

### 2. CLI Implementation Patterns

**Files**: `src/cli.tsx`, `src/commands/*.ts`

The CLI uses React/Ink for terminal UI with command routing via switch statement.

#### Entry Point Structure

```typescript
// src/cli.tsx:628-635
if (args.command === "hook") {
  runHook();  // Non-UI command
} else {
  render(<App args={args} />);  // UI commands
}
```

#### Adding New Commands

**Pattern A: Non-UI Command** (for `agent-secrets`):

```typescript
// src/commands/secrets.ts
export async function runSecrets(args: string[]): Promise<void> {
  // Parse subcommand: list, get, create, update, add-to-env
  // Execute database operations
  // Output results
  process.exit(0);
}

// src/cli.tsx - before render()
if (args.command === "secrets") {
  runSecrets(args.additionalArgs);
}
```

**Pattern B: UI Command** (React component):

```typescript
// Add case in switch statement at cli.tsx:591-625
case "new-command":
  return <NewCommand option1={args.option1} />;
```

#### Argument Parsing

Custom parser at `cli.tsx:23-101`:

```typescript
interface ParsedArgs {
  command: string | undefined;
  additionalArgs: string[];  // Args after --
  // ... other flags
}
```

### 3. Docker Worker Setup

**Files**: `Dockerfile.worker`, `docker-entrypoint.sh`

#### Multi-stage Build

```dockerfile
# Stage 1: Build
FROM oven/bun:latest AS builder
RUN bun build ./src/cli.tsx --compile --outfile ./agent-swarm

# Stage 2: Runtime
FROM ubuntu:24.04
COPY --from=builder /build/agent-swarm /usr/local/bin/agent-swarm
```

#### Adding New Binary to Docker

To add `agent-secrets` to the Docker image:

1. Add to build stage in `Dockerfile.worker`:
```dockerfile
RUN bun build ./src/secrets-cli.ts --compile --outfile ./agent-secrets
```

2. Copy to runtime:
```dockerfile
COPY --from=builder /build/agent-secrets /usr/local/bin/agent-secrets
```

#### Entrypoint Script

`docker-entrypoint.sh` runs before the agent starts:
- Validates environment variables
- Creates MCP configuration
- Runs startup scripts from `/workspace/start-up.*`
- Executes `agent-swarm worker` or `lead`

#### Environment Variables

| Variable | Description |
|----------|-------------|
| `API_KEY` | Required - MCP authentication |
| `AGENT_ID` | Optional - Agent identifier |
| `MCP_BASE_URL` | MCP server URL |

### 4. System Prompt Injection

**Files**: `src/commands/runner.ts`, `cc-plugin/commands/*.md`

#### Passing System Prompts to Claude

System prompts are appended via CLI flag (`runner.ts:56-58`):

```typescript
if (opts.systemPrompt) {
  CMD.push("--append-system-prompt", opts.systemPrompt);
}
```

#### Custom Command Files

Commands are markdown files with YAML frontmatter in `cc-plugin/commands/`:

```markdown
---
description: Command description shown in help
---

# Command Title

Instructions for Claude...
```

These are copied to `/home/worker/.claude/commands/` in Docker.

#### Documenting New Tools

To document `agent-secrets` for agents, add to:

1. **Worker command** (`cc-plugin/commands/start-worker.md`):
```markdown
### Secret Management

Use the `agent-secrets` CLI tool to manage secrets:
- `agent-secrets list` - List all available secrets
- `agent-secrets get <id>` - Get a secret value
- `agent-secrets create --name <name> --value <value>` - Create new secret
```

2. **Lead command** (`cc-plugin/commands/setup-leader.md`):
```markdown
### Secret Management

Secrets are managed via the `agent-secrets` CLI. Workers can only access secrets they created or system secrets.
```

### 5. Security Patterns (Current State)

**Finding**: No encryption patterns exist in the codebase.

#### What Exists
- **UUID generation**: `crypto.randomUUID()`
- **Bearer token auth**: Plain text comparison
- **Environment variables**: For all secrets

#### What Does NOT Exist
- Encryption/decryption functions
- Password hashing
- Cryptographic signing
- Data-at-rest encryption

#### Implications for Implementation

The `agent-secrets` feature will need to introduce:

1. **Encryption algorithm** (e.g., AES-256-GCM)
2. **Key derivation** from API_KEY (e.g., PBKDF2 or scrypt)
3. **Salt storage** per secret or global

Suggested encryption approach using Node.js crypto:

```typescript
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function deriveKey(apiKey: string, salt: Buffer): Buffer {
  return scryptSync(apiKey, salt, 32);
}

function encrypt(plaintext: string, apiKey: string): { encrypted: string; salt: string; iv: string; tag: string } {
  const salt = randomBytes(16);
  const key = deriveKey(apiKey, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");

  return {
    encrypted,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decrypt(encrypted: string, apiKey: string, salt: string, iv: string, tag: string): string {
  const key = deriveKey(apiKey, Buffer.from(salt, "base64"));
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));

  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
```

## Code References

### Database
- `src/be/db.ts:18-26` - Database initialization
- `src/be/db.ts:27-124` - Table creation
- `src/be/db.ts:142-164` - Migration pattern
- `src/types.ts` - TypeScript interfaces for all entities

### CLI
- `src/cli.tsx:23-101` - Argument parsing
- `src/cli.tsx:591-625` - Command routing
- `src/cli.tsx:628-635` - Non-UI command handling
- `src/commands/runner.ts:37-164` - Claude execution

### Docker
- `Dockerfile.worker:6-12` - Build stage
- `Dockerfile.worker:97-104` - Binary and commands copy
- `docker-entrypoint.sh:4-13` - Environment validation
- `docker-entrypoint.sh:192-194` - Agent startup

### System Prompts
- `src/commands/runner.ts:56-58` - System prompt injection
- `cc-plugin/commands/start-worker.md` - Worker instructions
- `cc-plugin/commands/setup-leader.md` - Lead instructions

## Architecture Documentation

### Proposed Secrets Table Schema

```sql
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,        -- Encrypted JSON: {encrypted, salt, iv, tag}
  description TEXT DEFAULT '',
  createdBy TEXT DEFAULT '',  -- Agent ID or empty for system
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_secrets_name ON secrets (name);
CREATE INDEX IF NOT EXISTS idx_secrets_createdBy ON secrets (createdBy);
```

### Proposed CLI Commands

| Command | Description | Access |
|---------|-------------|--------|
| `agent-secrets list` | List all secrets (no values) | All agents |
| `agent-secrets get <id>` | Get secret value | Creator or system |
| `agent-secrets create --name <n> --value <v>` | Create secret | All agents |
| `agent-secrets update <id> --value <v>` | Update secret | Creator or system |
| `agent-secrets add-to-env <id>` | Add to .env file | Creator or system |

### Access Control Logic

```typescript
function canAccess(secret: Secret, agentId: string): boolean {
  return secret.createdBy === "" || secret.createdBy === agentId;
}
```

## Historical Context

No prior research documents exist for secrets management in this codebase.

## Related Research

- `thoughts/shared/research/2025-12-19-agent-log-streaming.md` - Related agent features
- `thoughts/shared/plans/2025-12-19-role-based-swarm-plugin.md` - Related swarm architecture

## Open Questions

1. **Key rotation**: How should API_KEY changes affect existing encrypted secrets?
2. **Secret sharing**: Should leads be able to create secrets accessible to specific workers?
3. **Environment scope**: Should `add-to-env` write to container env or workspace `.env`?
4. **Audit logging**: Should secret access be logged to `agent_log` table?
