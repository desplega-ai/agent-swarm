<p align="center"><a href="https://github.com/desplega-ai/agent-swarm/stargazers"><img src="https://img.shields.io/github/stars/desplega-ai/agent-swarm?style=flat-square&color=yellow" alt="GitHub Stars"></a> <a href="https://github.com/desplega-ai/agent-swarm/blob/main/LICENSE"><img src="https://img.shields.io/github/license/desplega-ai/agent-swarm?style=flat-square" alt="MIT License"></a> <a href="https://github.com/desplega-ai/agent-swarm/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome"></a></p>
<p align="center"><b>An engine to make your company AI Native</b><br/><sub>Built by <a href="https://desplega.sh">desplega.sh</a>.</sub></p>

> [!TIP]
> **This repo evolves every single day.** [Watch now →](https://github.com/desplega-ai/agent-swarm/subscription)
<p align="center"><video src="https://github.com/user-attachments/assets/e220712e-c54d-4f46-b059-bac04639d229" controls muted playsinline width="720"></video></p>
<p align="center"><sub>▸ <a href="./assets/agent-swarm.mp4">daily evolution</a> · <a href="./assets/agent-swarm-slack-to-pr.mp4">slack → pr</a> · <a href="./assets/video-source">Making of</a></sub></p>
<p align="center"><a href="https://agent-swarm.dev"><img src="https://img.shields.io/badge/Website-agent--swarm.dev-000?style=for-the-badge" alt="Website"></a> <a href="https://docs.agent-swarm.dev"><img src="https://img.shields.io/badge/Docs-docs.agent--swarm.dev-amber?style=for-the-badge" alt="Docs"></a> <a href="https://app.agent-swarm.dev"><img src="https://img.shields.io/badge/Dashboard-app.agent--swarm.dev-blue?style=for-the-badge" alt="Dashboard"></a> <a href="https://discord.gg/KZgfyyDVZa"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord"></a> <a href="https://x.com/desplegalabs"><img src="https://img.shields.io/badge/𝕏-@desplegalabs-000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X"></a> <a href="https://www.linkedin.com/company/desplega-labs/"><img src="https://img.shields.io/badge/LinkedIn-Desplega%20Labs-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white" alt="Desplega Labs on LinkedIn"></a></p>

agent-swarm.dev is an open-source operating system for AI work. A lead agent delegates goals to workers such as Claude Code or Codex. Isolated containers, shared memory, tools, schedules, and review gates preserve work across sessions.

## What you get

- A lead agent that receives work from Slack, repositories, issue trackers, email, or the API
- Workers in isolated Docker containers with development environments
- Memory and identity that persist across sessions
- Workflows, schedules, scripts, and apps for recurring work
- [Realtime rooms](./runbooks/realtime-rooms.md) for shared page state, presence, and live channels
- Your choice of harness and models: Claude Code, Codex, pi, opencode, Devin, or ACP agents

```mermaid
flowchart LR
    subgraph IN["Tasks come in"]
        direction TB
        S["Slack"]
        G["GitHub / GitLab"]
        E["Email"]
        A["API / CLI"]
    end

    LEAD(["Lead Agent<br/>plans &amp; delegates"])

    subgraph WORKERS["Workers in Docker"]
        direction TB
        W1["Worker"]
        W2["Worker"]
        W3["Worker"]
    end

    subgraph BRAIN["Persistent brain"]
        direction TB
        MEM["Memory<br/>(vector search)"]
        ID["Identity<br/>(SOUL, CLAUDE.md)"]
    end

    subgraph OUT["Work ships"]
        direction TB
        PR["Pull Requests"]
        REPLY["Slack replies"]
        EMAIL["Email replies"]
    end

    IN --> LEAD --> WORKERS
    WORKERS -->|reads context| BRAIN
    WORKERS -->|writes learnings| BRAIN
    WORKERS --> OUT
```

## Quick Start

Give your coding agent the operator skill for Docker Compose or Kubernetes:

```bash
npx skills add desplega-ai/agent-swarm
```

Or use the examples directly:

```bash
git clone https://github.com/desplega-ai/agent-swarm.git && cd agent-swarm
cp .env.docker.example .env  # Set API_KEY, a harness credential, and all eight agent UUIDs.
openssl rand -base64 32 > encryption_key
chmod 600 .env encryption_key
docker compose -f docker-compose.example.yml --env-file .env up -d
```

Read the [Compose checklist](./skills/agent-swarm/references/compose.md) before starting. API: http://localhost:3013, with `/docs` and `/openapi.json`. [Dashboard](https://app.agent-swarm.dev): connect it to your API.
Kubernetes: [install the OCI Helm chart](./charts/agent-swarm/README.md).

## Integrations

Slack · GitHub · GitLab · Linear · Jira · AgentMail · WhatsApp (Kapso) · Composio · Sentry · Devin. [Integration guides](https://docs.agent-swarm.dev/docs/integrations).

## Learn more

- [Getting started](https://docs.agent-swarm.dev/docs/getting-started) · [Architecture](https://docs.agent-swarm.dev/docs/architecture/overview) · [Playbooks](https://docs.agent-swarm.dev/docs/playbooks) · [CLI](https://docs.agent-swarm.dev/docs/reference/cli) · [API reference](https://docs.agent-swarm.dev/docs/api-reference)
- [Agent templates](https://templates.agent-swarm.dev)
- Help: [contact@desplega.sh](mailto:contact@desplega.sh) · [Discord](https://discord.gg/KZgfyyDVZa)

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md), fork the repository, create a branch, and open a PR. Discuss ideas on [Discord](https://discord.gg/KZgfyyDVZa).
> Are you an agent? Run `npx skills add desplega-ai/agent-swarm` or read the [operator skill](./skills/agent-swarm/SKILL.md).

## Star History

<picture><source media="(prefers-color-scheme: dark)" srcset="./assets/star-history-dark.svg" /> <source media="(prefers-color-scheme: light)" srcset="./assets/star-history-light.svg" /> <img alt="Star History Chart" src="./assets/star-history-light.svg" /></picture>

## License

[MIT](./LICENSE) · 2025-2026 [desplega.sh](https://desplega.sh)
