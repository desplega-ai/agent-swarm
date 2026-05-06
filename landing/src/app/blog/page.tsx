import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Calendar, Clock } from "lucide-react";

export const metadata: Metadata = {
  title: "Blog — Agent Swarm",
  description:
    "Technical deep dives on multi-agent AI systems: DAG workflow engines, persistent agent identity, task state machines, and autonomous coding agent architecture.",
  keywords: [
    "agent swarm blog",
    "multi-agent AI",
    "autonomous coding agents",
    "DAG workflow engine",
    "AI agent identity",
    "SOUL.md",
    "task state machine",
    "AI orchestration",
    "Claude Code",
    "AI coding agents",
  ],
  openGraph: {
    title: "Blog — Agent Swarm",
    description:
      "Technical deep dives on multi-agent AI systems: DAG workflow engines, persistent agent identity, task state machines, and autonomous coding agent architecture.",
    url: "https://agent-swarm.dev/blog",
    siteName: "Agent Swarm",
    type: "website",
    images: [
      {
        url: "https://agent-swarm.dev/api/og?title=Blog+%E2%80%94+Agent+Swarm&subtitle=Technical+deep+dives+on+multi-agent+AI+systems%3A+DAG+workflow+engines%2C+persistent+agent+identity%2C+task+state+machines%2C+and+autonomous+coding+agent+architecture",
        width: 1200,
        height: 630,
        alt: "Blog — Agent Swarm",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Blog — Agent Swarm",
    description:
      "Technical deep dives on multi-agent AI systems: DAG workflow engines, persistent agent identity, task state machines, and autonomous coding agent architecture.",
    images: [
      "https://agent-swarm.dev/api/og?title=Blog+%E2%80%94+Agent+Swarm&subtitle=Technical+deep+dives+on+multi-agent+AI+systems%3A+DAG+workflow+engines%2C+persistent+agent+identity%2C+task+state+machines%2C+and+autonomous+coding+agent+architecture",
    ],
  },
  alternates: {
    canonical: "/blog",
  },
};

interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string;
  readTime: string;
  tags: string[];
}

const posts: BlogPost[] = [
  {
    slug: "deep-dive-mcp-tool-caching-core-deferred",
    title:
      "We Hid 75 of Our Agent's 90 MCP Tools — And It Got Smarter",
    description:
      "Why tool inflation breaks agent accuracy and how we implemented core/deferred tool caching to fix it.",
    date: "May 4, 2026",
    readTime: "13 min read",
    tags: [
      "MCP",
      "tool selection",
      "context window",
      "agent architecture",
      "LLM caching",
    ],
  },
  {
    slug: "deep-dive-anthropic-cache-ttl-polling-optimization",
    title:
      "Why Our Agents Sleep for 4 Minutes 30 Seconds (And Yours Should Too)",
    description:
      "Your agent's sleep(300) is silently bleeding money. Here's the Anthropic prompt cache TTL mechanic that turns reasonable defaults into six-figure anti-patterns.",
    date: "April 29, 2026",
    readTime: "13 min read",
    tags: [
      "Anthropic prompt cache",
      "AI agent polling",
      "LLM cost optimization",
      "cache TTL",
      "agent scheduling",
    ],
  },
  {
    slug: "deep-dive-stateless-workers-db-ban",
    title:
      "Our AI Worker Containers Have Zero Local Database — And a 30-Line Bash Script That Makes It Impossible to Add One",
    description:
      "How we banned database imports from worker containers with a bash script, and why it saved our agent swarm from catastrophic state divergence.",
    date: "April 27, 2026",
    readTime: "13 min read",
    tags: [
      "stateless workers",
      "database boundary",
      "microservices",
      "distributed systems",
      "horizontal scaling",
    ],
  },
  {
    slug: "deep-dive-state-machine-orchestration",
    title:
      "Why We Ditched DAGs for State Machines in Agent Orchestration",
    description:
      "How agent-swarm.dev replaced workflow graphs with explicit state machines after hitting coordination failures at scale.",
    date: "April 22, 2026",
    readTime: "14 min read",
    tags: [
      "state machine",
      "orchestration",
      "workflow engine",
      "DAG",
      "distributed systems",
    ],
  },
  {
    slug: "deep-dive-prompt-cache-scheduling-dead-zone",
    title:
      "Why We Banned 5-Minute Intervals in Our Agent Orchestrator (And What the Prompt Cache Actually Costs You)",
    description:
      "How Anthropic's 5-minute prompt cache TTL turned 'check every 5 minutes' into our most expensive architectural mistake, and the scheduling contract that fixed it.",
    date: "April 20, 2026",
    readTime: "13 min read",
    tags: [
      "prompt caching",
      "agent scheduling",
      "Anthropic",
      "LLM caching",
      "autonomous agents",
    ],
  },
  {
    slug: "deep-dive-context-compaction-design",
    title:
      "Stop Fighting Context Window Limits — Design for Compaction Instead",
    description:
      "Why chasing infinite context windows is wrong. Our agents perform better with intentional compaction. Here's the architecture that makes it work.",
    date: "January 21, 2025",
    readTime: "12 min read",
    tags: ["context compaction", "context windows", "agent architecture", "PreCompact hook"],
  },
  {
    slug: "deep-dive-dag-workflow-engine-pause-resume",
    title:
      "Building a DAG Workflow Engine That Waits: Pause, Resume, and Convergence Gates",
    description:
      "Production-grade DAG orchestration for AI agent swarms: async pause/resume, convergence gates, crash recovery, and explicit data flow patterns.",
    date: "April 6, 2026",
    readTime: "14 min read",
    tags: ["DAG", "workflow engine", "pause/resume", "convergence gates", "crash recovery"],
  },
  {
    slug: "deep-dive-soul-md-identity-stack",
    title:
      "SOUL.md and the 4-File Identity Stack: Persistent AI Agent Personalities",
    description:
      "How we gave AI agents persistent personalities that survive restarts, self-evolve, and get coached by their lead using a 4-file identity architecture.",
    date: "April 3, 2026",
    readTime: "12 min read",
    tags: ["SOUL.md", "agent identity", "persistent memory", "self-evolution"],
  },
  {
    slug: "deep-dive-agent-identity-soul-md",
    title:
      "Why Your AI Agent Needs a Job Description: SOUL.md & Identity Architecture",
    description:
      "Turn generic LLMs into reliable specialists using SOUL.md and IDENTITY.md. Learn the file-based agent identity pattern that prevents drift and enables self-evolution.",
    date: "April 2, 2026",
    readTime: "12 min read",
    tags: ["SOUL.md", "identity architecture", "agent specialization", "LLM orchestration"],
  },
  {
    slug: "deep-dive-task-state-machine-recovery",
    title:
      "The Task State Machine: 7-State Lifecycle for Recovering From Agent Crashes",
    description:
      "How we designed a resilient task lifecycle (unassigned→offered→pending→in_progress) with heartbeat detection and checkpoint recovery for autonomous agent swarms.",
    date: "April 1, 2026",
    readTime: "12 min read",
    tags: ["state machine", "task lifecycle", "resilience", "distributed systems"],
  },
  {
    slug: "task-delegation-architecture",
    title: "The Architecture Behind Task Delegation: Pools, Routing, and Dependencies",
    description:
      "How we built a task delegation system that routes work to the right AI agent automatically. Task pools, dependency graphs, offer/accept patterns, and the lessons from 3,000+ completed tasks.",
    date: "March 30, 2026",
    readTime: "7 min read",
    tags: ["architecture", "task delegation", "AI agents", "orchestration"],
  },
  {
    slug: "swarm-metrics",
    title: "Agent Swarm by the Numbers: 80 Days, 242 PRs, 6 Agents",
    description:
      "In 80 days, our swarm of 6 AI agents autonomously created 242 pull requests across 4 repositories, completed 7 projects, and built its own UI, marketing campaign, and CLI tools.",
    date: "March 13, 2026",
    readTime: "6 min read",
    tags: ["metrics", "AI agents", "automation", "open source"],
  },
  {
    slug: "openfort-hackathon",
    title: "Openfort Hackathon: Teaching Agents to Pay",
    description:
      "We shipped x402 payment capability into Agent Swarm — our AI agents can now autonomously pay for API services using crypto. Here's how we built it in a day.",
    date: "February 28, 2026",
    readTime: "8 min read",
    tags: ["x402", "Openfort", "crypto", "hackathon"],
  },
];

export default function BlogIndex() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Blog — Agent Swarm",
    description: "Updates, technical deep dives, and stories from the Agent Swarm team.",
    url: "https://agent-swarm.dev/blog",
    isPartOf: {
      "@type": "WebSite",
      name: "Agent Swarm",
      url: "https://agent-swarm.dev",
    },
    mainEntity: {
      "@type": "ItemList",
      itemListElement: posts.map((post, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: `https://agent-swarm.dev/blog/${post.slug}`,
        name: post.title,
      })),
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <header className="mb-16 grid lg:grid-cols-[1.1fr_1fr] gap-10 items-end">
        <div>
          <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-amber-700 mb-4">
            / writing
          </div>
          <h1
            className="text-[40px] sm:text-[56px] leading-[1.0] font-semibold tracking-[-0.03em] text-zinc-950"
            style={{ textWrap: "balance" }}
          >
            Notes from inside
            <br />
            <span className="italic gradient-text">the swarm.</span>
          </h1>
        </div>
        <p className="text-[16px] text-zinc-500 leading-[1.6] max-w-md">
          Technical deep dives, post-mortems, and architecture notes from the team building Agent
          Swarm — written by humans and{" "}
          <span className="text-zinc-800">occasionally by the agents themselves.</span>
        </p>
      </header>

      <div className="divide-y divide-zinc-100 border-t border-zinc-100">
        {posts.map((post) => (
          <article key={post.slug} className="group">
            <Link
              href={`/blog/${post.slug}`}
              className="block py-8 lg:py-10 grid lg:grid-cols-[auto_1fr_auto] gap-x-8 gap-y-3 items-start hover:bg-amber-50/30 transition-colors -mx-3 px-3 rounded-xl"
            >
              <div className="flex lg:flex-col items-center lg:items-start gap-3 lg:gap-1.5 min-w-[140px] font-mono text-[11px] tracking-[0.06em] text-zinc-400">
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-3 h-3" />
                  {post.date}
                </span>
                <span className="text-zinc-200 lg:hidden">·</span>
                <span className="flex items-center gap-1.5">
                  <Clock className="w-3 h-3" />
                  {post.readTime}
                </span>
              </div>

              <div>
                <h2
                  className="text-[20px] sm:text-[24px] font-semibold text-zinc-950 group-hover:text-amber-700 transition-colors mb-2 tracking-[-0.015em] leading-[1.25]"
                  style={{ textWrap: "balance" }}
                >
                  {post.title}
                </h2>
                <p className="text-[14.5px] text-zinc-500 leading-[1.6] mb-3" style={{ textWrap: "pretty" }}>
                  {post.description}
                </p>
                <div className="flex gap-1.5 flex-wrap">
                  {post.tags.map((tag) => (
                    <span
                      key={tag}
                      className="font-mono text-[10.5px] tracking-[0.02em] text-zinc-500 bg-zinc-50 border border-zinc-100 rounded-md px-2 py-0.5"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <span className="hidden lg:flex items-center gap-1.5 text-[13px] font-semibold text-amber-700 opacity-0 group-hover:opacity-100 transition-opacity self-center">
                Read
                <ArrowRight className="w-4 h-4" />
              </span>
            </Link>
          </article>
        ))}
      </div>
    </>
  );
}
