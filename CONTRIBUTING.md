# Contributing to Agent Swarm

Thanks for your interest in contributing to Agent Swarm!

## Table of Contents

- [Development Setup](#development-setup)
- [Running the Project](#running-the-project)
- [Code Quality](#code-quality)
- [Building](#building)
- [Project Structure](#project-structure)
- [Adding New Tools](#adding-new-tools)

---

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) (recommended) or Node.js 22+
- Git

### Install Dependencies

```bash
git clone https://github.com/desplega-ai/agent-swarm.git
cd agent-swarm
bun install
```

### Environment Setup

```bash
cp .env.docker.example .env
# Edit .env with your API_KEY
```

---

## Running the Project

### MCP Server

```bash
# STDIO transport (for local testing)
bun run start

# HTTP transport (for production)
bun run start:http

# With hot reload
bun run dev      # STDIO
bun run dev:http # HTTP
```

### MCP Inspector

Debug and test MCP tools interactively:

```bash
bun run inspector:http # HTTP transport
```

### CLI Commands

```bash
# Run CLI locally
bun run cli setup
bun run cli setup --dry-run

# Run worker/lead
bun run worker
bun run lead

# Hook handler
bun run hook
```

### Docker Worker

```bash
# Build worker image
bun run docker:build:worker

# Run worker container
bun run docker:run:worker

# Run lead container
bun run docker:run:lead
```

---

## Code Quality

### Linting

```bash
# Check for issues
bun run lint

# Fix issues automatically
bun run lint:fix
```

### Formatting

```bash
bun run format
```

### Type Checking

```bash
bun run tsc:check
```

### Pre-commit

Run all checks before committing:

```bash
bun run lint && bun run tsc:check
```

---

## Building

### Binary Builds

Create standalone binaries for Linux:

```bash
# x64
bun run build:binary

# ARM64
bun run build:binary:arm64
```

Output: `./dist/agent-swarm`

### Docker Images

```bash
# Build worker image
bun run docker:build:worker

# Push to registry (maintainers only)
bun run deploy:docker
```

---

## Project Structure

```
agent-swarm/
├── src/
│   ├── cli.tsx          # CLI entry point (Ink/React)
│   ├── http.ts          # HTTP server entry
│   ├── server.ts        # MCP server setup & tool registration
│   ├── tools/           # MCP tool implementations
│   │   ├── join-swarm.ts
│   │   ├── poll-task.ts
│   │   ├── send-task.ts
│   │   └── ...
│   ├── be/              # Backend (database, business logic)
│   │   └── db.ts        # SQLite database
│   ├── commands/        # CLI command implementations
│   │   ├── worker.ts
│   │   ├── lead.ts
│   │   └── ...
│   └── hooks/           # Claude Code hooks
├── deploy/              # Deployment scripts
├── scripts/             # Utility scripts
├── docker-compose.example.yml
├── Dockerfile           # API server image
├── Dockerfile.worker    # Worker image
└── package.json
```

---

## Adding New Tools

### 1. Create Tool File

Create `src/tools/my-tool.ts`:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar } from "@/tools/utils";

export const registerMyTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "my-tool",
    {
      title: "My Tool",
      description: "What this tool does.",
      inputSchema: z.object({
        param1: z.string().describe("Parameter description"),
        param2: z.number().optional().describe("Optional parameter"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ param1, param2 }, requestInfo, _meta) => {
      // requestInfo.agentId - caller's agent ID
      // requestInfo.sessionId - session ID

      // Your implementation here

      return {
        content: [{ type: "text", text: "Result message" }],
        structuredContent: {
          success: true,
          message: "Result message",
        },
      };
    },
  );
};
```

### 2. Register in Server

Edit `src/server.ts`:

```typescript
import { registerMyTool } from "./tools/my-tool";

export function createServer() {
  // ...existing code...

  // Register under appropriate capability
  if (hasCapability("my-capability")) {
    registerMyTool(server);
  }

  return server;
}
```

### 3. Update Documentation

```bash
bun run docs:mcp
```

---

## Coding Guidelines

See [CLAUDE.md](./CLAUDE.md) for:

- Bun-specific APIs and patterns
- Testing conventions
- Frontend development with HTML imports

### Key Points

- Use Bun instead of Node.js (`bun run`, `Bun.serve()`, `bun:sqlite`)
- Use Zod for schema validation
- Return both `content` (text) and `structuredContent` (JSON) from tools
- Group tools by capability (core, task-pool, messaging, profiles, services)
