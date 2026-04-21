/**
 * Generates two kinds of markdown artefacts at build time:
 *
 *   1. The legacy llms.txt convention (see llmstxt.org):
 *      - public/llms.txt       — short summary
 *      - public/llms-full.txt  — long-form content
 *
 *   2. Per-route markdown for acceptmarkdown.com content negotiation:
 *      - public/md/index.md
 *      - public/md/pricing.md
 *      - public/md/blog.md
 *      - public/md/blog/<slug>.md  (one per blog post)
 *      - public/md/examples.md
 *      - public/md/examples/<slug>.md
 *
 * The middleware at src/middleware.ts rewrites canonical URLs to the
 * matching /md/<slug>.md file when the request prefers text/markdown.
 *
 * Usage: bun run landing/scripts/generate-llms-txt.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const COMPONENTS_DIR = join(import.meta.dirname, "../src/components");
const APP_DIR = join(import.meta.dirname, "../src/app");
const PUBLIC_DIR = join(import.meta.dirname, "../public");
const MD_DIR = join(PUBLIC_DIR, "md");

const SITE_URL = "https://agent-swarm.dev";

function readSrc(path: string): string {
  return readFileSync(path, "utf-8");
}

function readComponent(name: string): string {
  return readSrc(join(COMPONENTS_DIR, `${name}.tsx`));
}

function readPage(route: string): string {
  return readSrc(join(APP_DIR, route, "page.tsx"));
}

function writeMd(relativePath: string, body: string): void {
  const out = join(MD_DIR, relativePath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body, "utf-8");
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
  platformPrice: number;
  workerPrice: number;
  examples: Array<{ workers: number; total: number }>;
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

  // Extract prices from the card JSX: {/* Platform card */} ... &euro;N ... {/* Worker card */} ... &euro;N
  const platformPriceMatch = src.match(/\{\/\* Platform card \*\/\}[\s\S]*?&euro;(\d+)/);
  const platformPrice = platformPriceMatch ? Number.parseInt(platformPriceMatch[1], 10) : 0;
  const workerPriceMatch = src.match(/\{\/\* Worker card \*\/\}[\s\S]*?&euro;(\d+)/);
  const workerPrice = workerPriceMatch ? Number.parseInt(workerPriceMatch[1], 10) : 0;

  // Extract examples array: { workers: N, total: N }
  const examples: Array<{ workers: number; total: number }> = [];
  const exMatch = src.match(/const examples = \[([\s\S]*?)\];/);
  if (exMatch) {
    const exRe = /workers:\s*(\d+),\s*total:\s*(\d+)/g;
    let em: RegExpExecArray | null;
    while ((em = exRe.exec(exMatch[1]))) {
      examples.push({ workers: Number.parseInt(em[1], 10), total: Number.parseInt(em[2], 10) });
    }
  }

  return { platformPrice, workerPrice, examples, platformFeatures, workerFeatures, faqs };
}

function extractWorkshops(): {
  timeline: Array<{ time: string; title: string; description: string }>;
  briefing: Array<{ time: string; title: string; description: string }>;
  references: Array<{ label: string; href: string }>;
} {
  const src = readComponent("workshops");
  const itemRe = /time:\s*"([^"]+)",\s*title:\s*"([^"]+)",\s*description:\s*"((?:[^"\\]|\\.)*)"/g;

  const timeline: Array<{ time: string; title: string; description: string }> = [];
  const tlMatch = src.match(/const workshopTimeline = \[([\s\S]*?)\];/);
  if (tlMatch) {
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(tlMatch[1]))) {
      timeline.push({ time: m[1], title: m[2], description: m[3].replace(/\\"/g, '"') });
    }
  }

  const briefing: Array<{ time: string; title: string; description: string }> = [];
  const brMatch = src.match(/const briefingTopics = \[([\s\S]*?)\];/);
  if (brMatch) {
    itemRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(brMatch[1]))) {
      briefing.push({ time: m[1], title: m[2], description: m[3].replace(/\\"/g, '"') });
    }
  }

  const references: Array<{ label: string; href: string }> = [];
  const refRe = /label:\s*"([^"]+)",\s*href:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(src))) {
    references.push({ label: m[1], href: m[2] });
  }

  return { timeline, briefing, references };
}

interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string;
  readTime: string;
  tags: string[];
}

function stitchString(raw: string): string {
  return raw
    .split(/"\s*\+\s*"/)
    .join("")
    .replace(/^"/, "")
    .replace(/"$/, "")
    .trim();
}

function extractBlogPosts(): BlogPost[] {
  const src = readPage("blog");
  const posts: BlogPost[] = [];
  const postRe = /\{\s*slug:\s*"([^"]+)",\s*title:\s*((?:"[^"]*"\s*\+?\s*)+),\s*description:\s*((?:"[^"]*"\s*\+?\s*)+),\s*date:\s*"([^"]+)",\s*readTime:\s*"([^"]+)",\s*tags:\s*\[([^\]]*)\][\s,]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = postRe.exec(src))) {
    const tags = Array.from(m[6].matchAll(/"([^"]+)"/g)).map((mm) => mm[1]);
    posts.push({
      slug: m[1],
      title: stitchString(m[2]),
      description: stitchString(m[3]),
      date: m[4],
      readTime: m[5],
      tags,
    });
  }
  return posts;
}

interface ExampleEntry {
  slug: string;
  title: string;
  description: string;
  tags: string[];
}

function extractExamples(): ExampleEntry[] {
  const src = readPage("examples");
  const examples: ExampleEntry[] = [];
  const exRe = /\{\s*slug:\s*"([^"]+)",\s*title:\s*"([^"]+)",\s*description:\s*"((?:[^"\\]|\\.)*)",\s*tags:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = exRe.exec(src))) {
    const tags = Array.from(m[4].matchAll(/"([^"]+)"/g)).map((mm) => mm[1]);
    examples.push({
      slug: m[1],
      title: m[2],
      description: m[3].replace(/\\"/g, '"'),
      tags,
    });
  }
  return examples;
}

interface PageMetadata {
  title?: string;
  description?: string;
  keywords?: string[];
  publishedTime?: string;
}

function extractPageMetadata(route: string): PageMetadata {
  const src = readPage(route);
  const meta: PageMetadata = {};

  const grab = (key: string): string | undefined => {
    // Match: title: "abc" + "def"  OR  title: "abc"
    const re = new RegExp(`${key}:\\s*((?:"[^"]*"(?:\\s*\\+\\s*"[^"]*")*))`);
    const m = src.match(re);
    if (!m) return undefined;
    return stitchString(m[1]);
  };

  meta.title = grab("title");
  meta.description = grab("description");

  const kwMatch = src.match(/keywords:\s*\[([\s\S]*?)\]/);
  if (kwMatch) {
    meta.keywords = Array.from(kwMatch[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
  }

  const ptMatch = src.match(/publishedTime:\s*"([^"]+)"/);
  if (ptMatch) meta.publishedTime = ptMatch[1];

  return meta;
}

// ── Generate markdown ─────────────────────────────────────────────────────

function generateLlmsTxt(features: ReturnType<typeof extractFeatures>, steps: ReturnType<typeof extractHowItWorks>): string {
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

- Website: ${SITE_URL}
- GitHub: https://github.com/desplega-ai/agent-swarm
- Docs: https://docs.agent-swarm.dev
- Cloud: https://cloud.agent-swarm.dev
- Templates: https://templates.agent-swarm.dev
- Built by: https://desplega.sh
`;
}

function generateLlmsFullTxt(
  features: ReturnType<typeof extractFeatures>,
  steps: ReturnType<typeof extractHowItWorks>,
  pricing: ReturnType<typeof extractPricing>,
  workshops: ReturnType<typeof extractWorkshops>,
): string {
  const { platformPrice, workerPrice, examples, platformFeatures, workerFeatures, faqs } = pricing;
  const { timeline, briefing, references } = workshops;
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

### Platform — €${platformPrice}/mo

Base infrastructure. 7-day free trial included.

${platformFeatures.map((f) => `- ${f}`).join("\n")}

### Worker Compute — €${workerPrice}/mo per worker

Docker-isolated agent. 7-day free trial included.

${workerFeatures.map((f) => `- ${f}`).join("\n")}

#### Example pricing

| Workers | Monthly cost |
|---------|-------------|
${examples.map((ex) => `| ${ex.workers} | €${ex.total}/mo |`).join("\n")}

Prefer self-hosting? It's [free and MIT-licensed](https://docs.agent-swarm.dev/docs/getting-started).

## FAQ

${faqs.map((f) => `**${f.question}**\n\n${f.answer}`).join("\n\n")}

## Get Started

Start your 7-day free trial on [Agent Swarm Cloud](https://cloud.agent-swarm.dev), or [self-host](https://docs.agent-swarm.dev/docs/getting-started) the open-source version for free.

## Links

- Website: ${SITE_URL}
- GitHub: https://github.com/desplega-ai/agent-swarm
- Docs: https://docs.agent-swarm.dev
- Cloud: https://cloud.agent-swarm.dev
- Templates: https://templates.agent-swarm.dev
- Built by [desplega.sh](https://desplega.sh)
- MIT License
`;
}

function generatePricingMd(pricing: ReturnType<typeof extractPricing>): string {
  const { platformPrice, workerPrice, examples, platformFeatures, workerFeatures, faqs } = pricing;
  return `# Pricing — Agent Swarm Cloud

> Simple, predictable pricing for Agent Swarm Cloud. Platform base at €${platformPrice}/mo plus €${workerPrice}/mo per worker. 7-day free trial included.

Canonical URL: ${SITE_URL}/pricing

## Platform — €${platformPrice}/mo

Base infrastructure. 7-day free trial included.

${platformFeatures.map((f) => `- ${f}`).join("\n")}

## Worker Compute — €${workerPrice}/mo per worker

Docker-isolated agent. 7-day free trial included.

${workerFeatures.map((f) => `- ${f}`).join("\n")}

## Example pricing

| Workers | Monthly cost |
|---------|-------------|
${examples.map((ex) => `| ${ex.workers} | €${ex.total}/mo |`).join("\n")}

Prefer self-hosting? It's [free and MIT-licensed](https://docs.agent-swarm.dev/docs/getting-started).

## FAQ

${faqs.map((f) => `**${f.question}**\n\n${f.answer}`).join("\n\n")}
`;
}

function generateBlogIndexMd(posts: BlogPost[]): string {
  return `# Blog — Agent Swarm

> Updates, technical deep dives, and stories from the Agent Swarm team.

Canonical URL: ${SITE_URL}/blog

${posts
  .map(
    (p) =>
      `## [${p.title}](${SITE_URL}/blog/${p.slug})\n\n*${p.date} · ${p.readTime}*\n\n${p.description}\n\nTags: ${p.tags.map((t) => `\`${t}\``).join(", ")}\n`,
  )
  .join("\n")}
`;
}

function generateBlogPostMd(post: BlogPost, meta: PageMetadata): string {
  const canonical = `${SITE_URL}/blog/${post.slug}`;
  const titleLine = meta.title ?? post.title;
  const descriptionLine = meta.description ?? post.description;
  const keywordsLine = meta.keywords?.length
    ? `\nKeywords: ${meta.keywords.map((k) => `\`${k}\``).join(", ")}\n`
    : "";
  const publishedLine = meta.publishedTime ? `Published: ${meta.publishedTime}\n` : "";
  return `# ${titleLine}

> ${descriptionLine}

${publishedLine}Read time: ${post.readTime}
Tags: ${post.tags.map((t) => `\`${t}\``).join(", ")}
${keywordsLine}
Canonical URL: ${canonical}

---

This post is rendered as React components on the canonical URL. For the full
content with code blocks, diagrams, and inline links, fetch the HTML at
[${canonical}](${canonical}) (send \`Accept: text/html\`).

A short summary, plus the listed metadata above, is provided here so AI agents
performing content negotiation can index the article without parsing the React
tree.
`;
}

function generateExamplesIndexMd(examples: ExampleEntry[]): string {
  return `# Examples — Real Agent Swarm Sessions

> Real session transcripts showing autonomous AI agent coordination in action.

Canonical URL: ${SITE_URL}/examples

${examples
  .map(
    (e) =>
      `## [${e.title}](${SITE_URL}/examples/${e.slug})\n\n${e.description}\n\nTags: ${e.tags.map((t) => `\`${t}\``).join(", ")}\n`,
  )
  .join("\n")}
`;
}

function generateExampleMd(example: ExampleEntry, meta: PageMetadata): string {
  const canonical = `${SITE_URL}/examples/${example.slug}`;
  const titleLine = meta.title ?? example.title;
  const descriptionLine = meta.description ?? example.description;
  const keywordsLine = meta.keywords?.length
    ? `\nKeywords: ${meta.keywords.map((k) => `\`${k}\``).join(", ")}\n`
    : "";
  return `# ${titleLine}

> ${descriptionLine}

Tags: ${example.tags.map((t) => `\`${t}\``).join(", ")}
${keywordsLine}
Canonical URL: ${canonical}

---

This example is rendered as React components on the canonical URL. For the full
walkthrough with screenshots and embedded media, fetch the HTML at
[${canonical}](${canonical}) (send \`Accept: text/html\`).
`;
}

// ── Main ──────────────────────────────────────────────────────────────────

const features = extractFeatures();
if (features.length === 0) throw new Error("extractFeatures() returned nothing — check features.tsx structure");

const steps = extractHowItWorks();
if (steps.length === 0) throw new Error("extractHowItWorks() returned nothing — check how-it-works.tsx structure");

const pricing = extractPricing();
if (pricing.platformFeatures.length === 0) throw new Error("extractPricing() returned no platformFeatures — check pricing-section.tsx structure");
if (pricing.workerFeatures.length === 0) throw new Error("extractPricing() returned no workerFeatures — check pricing-section.tsx structure");
if (pricing.faqs.length === 0) throw new Error("extractPricing() returned no FAQs — check pricing-section.tsx structure");
if (pricing.platformPrice === 0) throw new Error("extractPricing() could not find platform price — check pricing-section.tsx structure");
if (pricing.workerPrice === 0) throw new Error("extractPricing() could not find worker price — check pricing-section.tsx structure");
if (pricing.examples.length === 0) throw new Error("extractPricing() returned no examples — check pricing-section.tsx structure");

const workshops = extractWorkshops();
if (workshops.timeline.length === 0) throw new Error("extractWorkshops() returned no timeline items — check workshops.tsx structure");
if (workshops.briefing.length === 0) throw new Error("extractWorkshops() returned no briefing items — check workshops.tsx structure");
if (workshops.references.length === 0) throw new Error("extractWorkshops() returned no references — check workshops.tsx structure");

const blogPosts = extractBlogPosts();
if (blogPosts.length === 0) throw new Error("extractBlogPosts() returned nothing — check blog/page.tsx structure");

const examples = extractExamples();
if (examples.length === 0) throw new Error("extractExamples() returned nothing — check examples/page.tsx structure");

const llmsTxt = generateLlmsTxt(features, steps);
const llmsFullTxt = generateLlmsFullTxt(features, steps, pricing, workshops);

writeFileSync(join(PUBLIC_DIR, "llms.txt"), llmsTxt, "utf-8");
writeFileSync(join(PUBLIC_DIR, "llms-full.txt"), llmsFullTxt, "utf-8");
console.log(`✓ Generated llms.txt (${llmsTxt.length} bytes)`);
console.log(`✓ Generated llms-full.txt (${llmsFullTxt.length} bytes)`);

// Per-route markdown for acceptmarkdown.com content negotiation
mkdirSync(MD_DIR, { recursive: true });

writeMd("index.md", llmsFullTxt);
console.log(`✓ Generated md/index.md`);

writeMd("pricing.md", generatePricingMd(pricing));
console.log(`✓ Generated md/pricing.md`);

writeMd("blog.md", generateBlogIndexMd(blogPosts));
console.log(`✓ Generated md/blog.md`);

for (const post of blogPosts) {
  const meta = extractPageMetadata(`blog/${post.slug}`);
  writeMd(`blog/${post.slug}.md`, generateBlogPostMd(post, meta));
}
console.log(`✓ Generated md/blog/<slug>.md (${blogPosts.length} posts)`);

writeMd("examples.md", generateExamplesIndexMd(examples));
console.log(`✓ Generated md/examples.md`);

for (const example of examples) {
  const meta = extractPageMetadata(`examples/${example.slug}`);
  writeMd(`examples/${example.slug}.md`, generateExampleMd(example, meta));
}
console.log(`✓ Generated md/examples/<slug>.md (${examples.length} examples)`);
