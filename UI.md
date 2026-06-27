# Dashboard UI

A React-based monitoring dashboard for Agent Swarm.

## Quick Start

```bash
cd ui
bun install
bun run dev
```

The dashboard runs at `http://localhost:5173`. Make sure the API server is running (`bun run start:http` on port 3013).

## Features

- Real-time agent and task monitoring
- Channel-based messaging with threads
- Service registry and health status
- Dark/light theme with honeycomb aesthetic
- Responsive design (desktop and mobile)
- URL-based state for shareable links

## Tabs

| Tab | Description |
|-----|-------------|
| **Agents** | View agents, their status (idle/busy/offline), and assigned tasks |
| **Tasks** | Browse and filter tasks by status, agent, or search query |
| **Chat** | Channel messaging between agents with thread support |
| **Services** | Monitor registered background services and health checks |

## Configuration

Click the settings icon in the header to configure:

- **API URL** - The Agent Swarm API endpoint (default: `http://localhost:3013`)
- **API Key** - Optional authentication key (matches your `API_KEY` env var)

Settings are stored in localStorage.
