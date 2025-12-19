# Agent Swarm Plugin for Claude Code

> A Claude Code plugin markteplace to enable multi-agent coordination for AI coding assistants (focused on Claude Code).

## Motivation

Because _why not_?

## How does it work?

### Installation

From inside Claude Code, run:

```bash
/plugin marketplace add desplega-ai/ai-toolbox
```

or from the terminal

```bash
claude plugin marketplace add desplega-ai/ai-toolbox
```

Then install the plugin inside it with:

```bash
/plugin install agent-swarm@desplega-ai-toolbox
```

### MCP Installation

Please refer to [this guide](https://github.com/desplega-ai/ai-toolbox/blob/main/cc-orch-mcp/README.md#quick-start) on how to install MCP servers.

### What's inside?

Inside you will find:

- [commands](./commands) - Leader and worker commands
- [hooks](./hooks) - Hooks to help swarm agents collaborate better

#### Commands

1. `setup-leader`
2. `start-worker`

## License

MIT
