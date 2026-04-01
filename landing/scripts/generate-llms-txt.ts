/**
 * Generates llms.txt and llms-full.txt from the landing page component source files.
 *
 * The llms.txt convention (see llmstxt.org) provides a machine-readable summary of a site
 * that AI agents can fetch and parse. This script extracts text content from the React
 * components and produces clean markdown.
 *
 * Usage: bun run landing/scripts/generate-llms-txt.ts
 * Output: landing/public/llms.txt, landing/public/llms-full.txt
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS_DIR = join(import.meta.dirname, "../src/components");
const PUBLIC_DIR = join(import.meta.dirname, "../public");

function readComponent(name: string): string {
  return readFileSync(join(COMPONENTS_DIR, `${name}.tsx`), "utf-8");
}

// ── Extract data from components ──────────────────────────────────────────

function extractFeatures(): Array<{ title: string; description: string; link?: string }> {
  const src = readComponent("features");
  const features: Array<{ title: string; description: string; link?: string }> = [];

  const blockRe = /\{\s*icon:\s*\w+,\s*title:\s*"([^"]+)",\s*description:\s*"([^"]+)"(?:,\s*color:\s*"[^"]*")?(?:,\s*link:\s*"([^"]*)")?\s*,?\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(src))) {
    features.push({ title: m[1], description: m[2], link: m[3] });
  }
  return features;
}

function extractHowItWorks(): Array<{ number: string; title: string; description: string; badge: string }> {
  const src = readComponent("how-it-works");
  const steps: Array<{ number: string; title: string; description: string; badge: string }> = [];

  const blockRe = /number:\s*"(\d+)",\s*title:\s*"([^"]+)",\s*description:\s*"([^"]+)",\s*badge:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(src))) {
    steps.push({ number: m[1], title: m[2], description: m[3], badge: m[4] });
  }
  return steps;
}

function extractPricing(): {
  platformFeatures: string[];
  workerFeatures: string[];
  faqs: Array<{ question: string; answer: string }>;
} {
  const src = readComponent("pricing-section");

  const platformFeatures: string[] = [];
  const pfMatch = src.match(/const platformFeatures = \[([\s\S]*?)\];/);
  if (pfMatch) {
    const strRe = /"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(pfMatch[1]))) platformFeatures.push(m[1]);
  }

  const workerFeatures: string[] = [];
  const wfMatch = src.match(/const workerFeatures = \[([\s\S]*?)\];/);
  if (wfMatch) {
    const strRe = /"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(wfMatch[1]))) workerFeatures.push(m[1]);
  }

  const faqs: Array<{ question: string; answer: string }> = [];
  const faqRe = /question:\s*"([^"]+)",\s*answer:\s*"((?:[^"\\]|\\.)*)"/g;
  let fm: RegExpExecArray | null;
  while ((fm = faqRe.exec(src))) {
    faqs.push({ question: fm[1], answer: fm[2].replace(/\\"/g, '"') });
  }

  return { platformFeatures, workerFeatures, faqs };
}

function extractWorkshops(): {
  timeline: Array<{ time: string; title: string; description: string }>;
  briefing: Array<{ time: string; title: string; description: string }>;
  references: Array<{ label: string; href: string }>;
} {
  const src = readComponent("workshops");

  const timeline: Array<{ time: string; title: string; description: string }> = [];
  const tlRe = /time:\s*"([^"]+)",\s*title:\s*"([^"]+)",\s*description:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  // First set of matches = workshopTimeline, second set = briefingTopics
  const allMatches: Array<{ time: string; title: string; description: string }> = [];
  while ((m = tlRe.exec(src))) {
    allMatches.push({ time: m[1], title: m[2], description: m[3].replace(/\\"/g, '"') });
  }

  // workshopTimeline has 4 items, briefingTopics has 3
  const workshopTimeline = allMatches.slice(0, 4);
  const briefingTopics = allMatches.slice(4, 7);

  const references: Array<{ label: string; href: string }> = [];
  const refRe = /label:\s*"([^"]+)",\s*href:\s*"([^"]+)"/g;
  while ((m = refRe.exec(src))) {
    references.push({ label: m[1], href: m[2] });
  }

  return { timeline: workshopTimeline, briefing: briefingTopics, references };
}

// ── Generate markdown ─────────────────────────────────────────────────────

function generateLlmsTxt(): string {
  const features = extractFeatures();
  const steps = extractHowItWorks();

  return `# Agent Swarm

> Intelligence that compounds

Open-source multi-agent orchestration for Claude Code. Orchestrate autonomous AI agents that learn, remember, and get smarter with every session.

- [GitHub](https://github.com/desplega-ai/agent-swarm)
- [Documentation](https://docs.agent-swarm.dev)
- [Cloud](https://cloud.agent-swarm.dev)
- [Templates](https://templates.agent-swarm.dev)
- [Pricing](/pricing)
- [Blog](/blog)

## Features

${features.map((f) => `- **${f.title}**: ${f.description}`).join("\n")}

## How It Works

${steps.map((s) => `${s.number}. **${s.title}** — ${s.description}`).join("\n")}

## Links

- Website: https://agent-swarm.dev
- GitHub: https://github.com/desplega-ai/agent-swarm
- Docs: https://docs.agent-swarm.dev
- Cloud: https://cloud.agent-swarm.dev
- Templates: https://templates.agent-swarm.dev
- Built by: https://desplega.sh
`;
}

function generateLlmsFullTxt(): string {
  const features = extractFeatures();
  const steps = extractHowItWorks();
  const { platformFeatures, workerFeatures, faqs } = extractPricing();
  const { timeline, briefing, references } = extractWorkshops();

  return `# Agent Swarm

> Intelligence that compounds

Open Source · MCP-Powered · TypeScript · Claude Code

Orchestrate autonomous AI agents that learn, remember, and get smarter with every session. A lead coordinates workers. Memory persists. Knowledge compounds. Deploy in minutes with Agent Swarm Cloud, or self-host for free.

- [GitHub](https://github.com/desplega-ai/agent-swarm)
- [Documentation](https://docs.agent-swarm.dev)
- [Cloud](https://cloud.agent-swarm.dev)
- [Templates](https://templates.agent-swarm.dev)
- [Pricing](/pricing)
- [Blog](/blog)

## Features

From task delegation to persistent memory, Agent Swarm provides the full infrastructure for autonomous multi-agent coordination.

${features.map((f) => `### ${f.title}\n\n${f.description}${f.link ? ` [Learn more](${f.link})` : ""}`).join("\n\n")}

## How It Works

Three steps to a swarm that gets smarter every day.

${steps.map((s) => `### ${s.number}. ${s.title}\n\n${s.description}\n\n*${s.badge}*`).join("\n\n")}

## Workshops

### Hands-on Workshop (2 Hours)

Best for technical teams familiar with CLIs or IDEs with background agents, aiming to move to agentic coding.

By the end of this workshop, your team will have a swarm of agents in the cloud, capable of producing code constantly — removing the need for your team to write code.

${timeline.map((t) => `- **${t.title}** (${t.time}): ${t.description}`).join("\n")}

### Agentic Strategy Briefing (1 Hour)

Best for teams looking for a high-level conceptual roadmap to understand the agentic coding landscape.

${briefing.map((t) => `- **${t.title}** (${t.time}): ${t.description}`).join("\n")}

Contact: [contact@desplega.sh](mailto:contact@desplega.sh?subject=Agentic%20SDLC%20Workshop%20Inquiry)

#### References

${references.map((r) => `- [${r.label}](${r.href})`).join("\n")}

## Pricing

Simple, predictable pricing. One platform fee, plus a flat rate per worker. No usage surprises, no hidden costs.

### Platform — €9/mo

Base infrastructure. 7-day free trial included.

${platformFeatures.map((f) => `- ${f}`).join("\n")}

### Worker Compute — €29/mo per worker

Docker-isolated agent. 7-day free trial included.

${workerFeatures.map((f) => `- ${f}`).join("\n")}

#### Example pricing

| Workers | Monthly cost |
|---------|-------------|
| 1 | €38/mo |
| 3 | €96/mo |
| 6 | €183/mo |

Prefer self-hosting? It's [free and MIT-licensed](https://docs.agent-swarm.dev/docs/getting-started).

## FAQ

${faqs.map((f) => `**${f.question}**\n\n${f.answer}`).join("\n\n")}

## Get Started

Start your 7-day free trial on [Agent Swarm Cloud](https://cloud.agent-swarm.dev), or [self-host](https://docs.agent-swarm.dev/docs/getting-started) the open-source version for free.

## Links

- Website: https://agent-swarm.dev
- GitHub: https://github.com/desplega-ai/agent-swarm
- Docs: https://docs.agent-swarm.dev
- Cloud: https://cloud.agent-swarm.dev
- Templates: https://templates.agent-swarm.dev
- Built by [desplega.sh](https://desplega.sh)
- MIT License
`;
}

// ── Main ──────────────────────────────────────────────────────────────────

const llmsTxt = generateLlmsTxt();
const llmsFullTxt = generateLlmsFullTxt();

writeFileSync(join(PUBLIC_DIR, "llms.txt"), llmsTxt, "utf-8");
writeFileSync(join(PUBLIC_DIR, "llms-full.txt"), llmsFullTxt, "utf-8");

console.log(`✓ Generated llms.txt (${llmsTxt.length} bytes)`);
console.log(`✓ Generated llms-full.txt (${llmsFullTxt.length} bytes)`);
