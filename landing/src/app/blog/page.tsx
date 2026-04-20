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

      <header className="mb-16">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-zinc-900">Blog</h1>
        <p className="mt-4 text-lg text-zinc-500 max-w-xl">
          Updates, technical deep dives, and stories from the Agent Swarm team.
        </p>
      </header>

      <div className="space-y-0 divide-y divide-zinc-100">
        {posts.map((post) => (
          <article key={post.slug} className="group py-8 first:pt-0">
            <Link href={`/blog/${post.slug}`} className="block">
              <div className="flex items-center gap-3 mb-3">
                <span className="flex items-center gap-1.5 text-[13px] text-zinc-400">
                  <Calendar className="w-3.5 h-3.5" />
                  {post.date}
                </span>
                <span className="text-zinc-300">&middot;</span>
                <span className="flex items-center gap-1.5 text-[13px] text-zinc-400">
                  <Clock className="w-3.5 h-3.5" />
                  {post.readTime}
                </span>
              </div>

              <h2 className="text-xl sm:text-2xl font-semibold text-zinc-900 group-hover:text-amber-700 transition-colors mb-2">
                {post.title}
              </h2>

              <p className="text-[15px] text-zinc-500 leading-relaxed mb-4">{post.description}</p>

              <div className="flex items-center justify-between">
                <div className="flex gap-2 flex-wrap">
                  {post.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-500"
                    >
                      {tag}
                    </span>
                  ))}
                </div>

                <span className="flex items-center gap-1.5 text-sm font-medium text-amber-700 opacity-0 group-hover:opacity-100 transition-opacity">
                  Read
                  <ArrowRight className="w-4 h-4" />
                </span>
              </div>
            </Link>
          </article>
        ))}
      </div>
    </>
  );
}
