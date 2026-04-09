import type { Metadata } from "next";
import {
  ArrowRight,
  ExternalLink,
  Layers,
  Route,
  GitBranch,
  ShieldCheck,
  Workflow,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { BlogPostLayout } from "@/components/blog-post-layout";
import { MermaidDiagram } from "@/components/mermaid-diagram";

export const metadata: Metadata = {
  title:
    "The Architecture Behind Task Delegation: Pools, Routing, and Dependencies — Agent Swarm Blog",
  description:
    "How we built an AI task delegation system with pools, dependency graphs, and offer/accept routing across 6 Claude Code agents. Lessons learned from 3,000+ completed tasks in production.",
  authors: [{ name: "Agent Swarm Team", url: "https://agent-swarm.dev" }],
  keywords: [
    "agent swarm",
    "AI agents",
    "task delegation",
    "multi-agent orchestration",
    "task pools",
    "dependency graphs",
    "AI task routing",
    "Claude Code",
    "agent workflow",
    "concurrent AI agents",
    "MCP server",
    "multi-agent architecture",
  ],
  openGraph: {
    title: "The Architecture Behind Task Delegation: Pools, Routing, and Dependencies",
    description:
      "How we built an AI task delegation system with pools, dependency graphs, and offer/accept routing across 6 Claude Code agents. Lessons from 3,000+ completed tasks.",
    url: "https://agent-swarm.dev/blog/task-delegation-architecture",
    siteName: "Agent Swarm",
    type: "article",
    publishedTime: "2026-03-30T00:00:00Z",
    section: "Agent Swarm",
    tags: ["architecture", "task delegation", "AI agents", "Claude Code", "orchestration"],
    images: [
      {
        url: "https://agent-swarm.dev/og-image.png",
        width: 1200,
        height: 630,
        alt: "The Architecture Behind Task Delegation: Pools, Routing, and Dependencies",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "The Architecture Behind Task Delegation: Pools, Routing, and Dependencies",
    description:
      "How we built an AI task delegation system with pools, dependency graphs, and offer/accept routing across 6 Claude Code agents. Lessons from 3,000+ completed tasks.",
    images: ["https://agent-swarm.dev/og-image.png"],
  },
  alternates: {
    canonical: "/blog/task-delegation-architecture",
  },
};

function SectionIcon({
  icon: Icon,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}) {
  return (
    <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${color}`}>
      <Icon className="w-4.5 h-4.5" />
    </div>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
      <div className="text-[14px] text-amber-900 leading-relaxed">{children}</div>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="my-6 rounded-xl bg-zinc-950 border border-zinc-800 px-5 py-4 overflow-x-auto">
      <code className="text-[13px] leading-relaxed text-zinc-300 font-mono">{children}</code>
    </pre>
  );
}

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  headline: "The Architecture Behind Task Delegation: Pools, Routing, and Dependencies",
  description:
    "How we built an AI task delegation system with pools, dependency graphs, and offer/accept routing across 6 Claude Code agents. Lessons from 3,000+ completed tasks.",
  datePublished: "2026-03-30T00:00:00Z",
  dateModified: "2026-03-30T00:00:00Z",
  author: {
    "@type": "Organization",
    name: "Agent Swarm Team",
    url: "https://agent-swarm.dev",
  },
  publisher: {
    "@type": "Organization",
    name: "Agent Swarm",
    url: "https://agent-swarm.dev",
    logo: {
      "@type": "ImageObject",
      url: "https://agent-swarm.dev/logo.png",
    },
  },
  mainEntityOfPage: {
    "@type": "WebPage",
    "@id": "https://agent-swarm.dev/blog/task-delegation-architecture",
  },
  image: "https://agent-swarm.dev/og-image.png",
  articleSection: "Agent Swarm",
  keywords: "agent swarm, AI agents, task delegation, multi-agent orchestration, task pools, dependency graphs, AI task routing, Claude Code, agent workflow, MCP server, multi-agent architecture",
  wordCount: 1400,
};

export default function TaskDelegationArchitecturePost() {
  return (
    <BlogPostLayout
      date="March 30, 2026"
      readTime="7 min read"
      title={
        <>
          The Architecture Behind Task Delegation:{" "}
          <span className="gradient-text">Pools, Routing, and Dependencies</span>
        </>
      }
      description="Most multi-agent systems start simple: one agent gets a task, does the work. But what happens when you have 6 agents, 50 concurrent tasks, and dependencies between them? Here's how we built the delegation system behind Agent Swarm — and the hard lessons from 3,000+ completed tasks."
      tags={["architecture", "task delegation", "AI agents", "orchestration"]}
      jsonLd={jsonLd}
    >
      {/* Intro */}
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        If you&apos;re building a multi-agent system, task delegation is the first problem that
        becomes non-trivial. A single agent with a single task is straightforward. But the moment you
        have multiple agents with different capabilities, concurrent work, and tasks that depend on
        each other, you need an actual system.
      </p>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-10">
        We&apos;ve been running Agent Swarm in production for over 90 days. Six agents. Over 3,000
        completed tasks. The delegation architecture has been rewritten twice. Here&apos;s what we
        landed on and why.
      </p>

      {/* Section 1: The Task Lifecycle */}
      <section className="mb-14">
        <div className="flex items-center gap-3 mb-6">
          <SectionIcon icon={Workflow} color="bg-amber-100 text-amber-700" />
          <h2 className="text-2xl font-bold text-zinc-900">The Task Lifecycle</h2>
        </div>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Every piece of work in Agent Swarm flows through a state machine. This sounds obvious, but
          getting the states right took multiple iterations. Our first version had three states
          (pending, running, done). The current version has ten — but the core flow looks like this:
        </p>

        <MermaidDiagram
          chart={`stateDiagram-v2
    [*] --> backlog
    backlog --> unassigned
    unassigned --> offered
    offered --> pending
    offered --> reviewing
    reviewing --> pending
    pending --> in_progress
    in_progress --> completed
    in_progress --> failed
    in_progress --> paused
    paused --> in_progress
    pending --> cancelled
    in_progress --> cancelled`}
        />

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          The key insight was separating <strong>assignment</strong> from{" "}
          <strong>execution</strong>. A task can be assigned to an agent (pending) but not yet
          started. This matters because agents run in Docker containers that poll for work — there is
          a real gap between &quot;this task is yours&quot; and &quot;the agent has picked it up.&quot;
        </p>

        <Callout>
          <strong>Lesson:</strong> If your agents are distributed processes, you need at least one
          state between &quot;assigned&quot; and &quot;running.&quot; Without it, you can&apos;t
          distinguish between an agent that hasn&apos;t started yet and one that crashed silently.
        </Callout>
      </section>

      {/* Section 2: Task Pools */}
      <section className="mb-14">
        <div className="flex items-center gap-3 mb-6">
          <SectionIcon icon={Layers} color="bg-blue-100 text-blue-700" />
          <h2 className="text-2xl font-bold text-zinc-900">Task Pools vs. Direct Assignment</h2>
        </div>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          We support two delegation models, and you need both. Direct assignment is when the Lead
          agent knows exactly who should do the work: &quot;Picateclas, implement this PR.&quot; Task
          pools are when work is posted without a specific assignee and agents claim it.
        </p>

        <div className="space-y-4 mb-6">
          <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-2 h-2 rounded-full shrink-0 bg-blue-500" />
              <h3 className="text-[15px] font-semibold text-zinc-900">Direct Assignment</h3>
            </div>
            <p className="text-[14px] text-zinc-600 leading-relaxed pl-5">
              The Lead creates a task and assigns it to a specific agent by ID. The target
              agent&apos;s runner picks it up on next poll. Best for specialized work where only one
              agent has the right context — like assigning a PR review to the Reviewer agent.
            </p>
          </div>

          <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-2 h-2 rounded-full shrink-0 bg-emerald-500" />
              <h3 className="text-[15px] font-semibold text-zinc-900">Task Pools</h3>
            </div>
            <p className="text-[14px] text-zinc-600 leading-relaxed pl-5">
              Tasks are created as &quot;unassigned&quot; with tags (e.g., implementation, research).
              Idle agents poll the pool, filter by their capabilities, and claim tasks. This is how
              we load-balance — if one coder agent is busy, another can pick up the work.
            </p>
          </div>

          <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-2 h-2 rounded-full shrink-0 bg-purple-500" />
              <h3 className="text-[15px] font-semibold text-zinc-900">Offer/Accept Pattern</h3>
            </div>
            <p className="text-[14px] text-zinc-600 leading-relaxed pl-5">
              A middle ground: the Lead offers a task to a specific agent, but the agent can reject it
              (e.g., if it lacks context or is overloaded). Rejected tasks go back to the pool or get
              re-offered. This prevents forcing work onto agents that would fail at it.
            </p>
          </div>
        </div>

        <Callout>
          <strong>Lesson:</strong> Start with direct assignment — it&apos;s simple and predictable.
          Add pools when you have more than 2-3 workers and want natural load balancing. Add
          offer/accept when you notice agents failing on tasks they shouldn&apos;t have been assigned.
        </Callout>
      </section>

      {/* Section 3: Routing */}
      <section className="mb-14">
        <div className="flex items-center gap-3 mb-6">
          <SectionIcon icon={Route} color="bg-emerald-100 text-emerald-700" />
          <h2 className="text-2xl font-bold text-zinc-900">How the Lead Routes Work</h2>
        </div>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          The Lead agent is itself an AI — it reads Slack messages, interprets intent, breaks down
          complex requests into sub-tasks, and decides who does what. This is both the most powerful
          and most fragile part of the system.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          The Lead has access to every agent&apos;s profile: their name, role description, current
          status, and task history. When a new request comes in, it evaluates which agent is the best
          fit based on role specialization and current workload. A bug fix goes to the coder. A PR
          review goes to the reviewer. A research question goes to the researcher.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          But the Lead also handles <strong>task decomposition</strong>. A Slack message like
          &quot;add a new blog post to the landing page&quot; becomes: (1) research the existing blog
          format, (2) write the post, (3) test the build, (4) create a PR. The Lead creates these as
          separate tasks with dependencies.
        </p>

        <Callout>
          <strong>Lesson:</strong> Your routing agent needs structured access to agent capabilities,
          not just names. We store each agent&apos;s role, specialization, and task history. Without this, the Lead agent guesses — and guesses wrong about 15% of the time.
        </Callout>
      </section>

      {/* Section 4: Dependencies */}
      <section className="mb-14">
        <div className="flex items-center gap-3 mb-6">
          <SectionIcon icon={GitBranch} color="bg-purple-100 text-purple-700" />
          <h2 className="text-2xl font-bold text-zinc-900">Task Dependencies</h2>
        </div>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Real work has order. You can&apos;t review a PR that doesn&apos;t exist yet. You can&apos;t
          deploy code that hasn&apos;t been tested. Agent Swarm supports{" "}
          <code className="text-[13px] font-mono bg-zinc-100 px-1.5 py-0.5 rounded">dependsOn</code>{" "}
          — a list of task IDs that must complete before a task becomes eligible for execution.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          When a task&apos;s dependencies are all completed, it transitions from blocked to its normal
          lifecycle. If any dependency fails, the dependent task can be automatically cancelled or
          left for the Lead to decide.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          We also built <strong>Workflows</strong> on top of this — declarative DAGs of tasks with
          interpolation. A workflow definition says &quot;run task A, pass its output to task B, then
          fan out to tasks C and D in parallel.&quot; Workflows are how we handle recurring
          multi-step processes like daily content generation or scheduled health checks.
        </p>

        <CodeBlock>
          {`// Workflow node with cross-step data access
{
  "id": "write-post",
  "type": "agent-task",
  "inputs": { "research": "gather-data" },
  "config": {
    "template": "Write a post using: {{research.taskOutput}}"
  },
  "next": ["review-post"]
}`}
        </CodeBlock>

        <Callout>
          <strong>Lesson:</strong> Dependencies are essential, but keep them shallow. Deep dependency
          chains (A → B → C → D → E) are fragile — one failure cascades. We aim for wide, shallow
          DAGs: fan out early, join late. Our most reliable workflows have 2-3 levels of depth, not
          5-6.
        </Callout>
      </section>

      {/* Section 5: Failure Handling */}
      <section className="mb-14">
        <div className="flex items-center gap-3 mb-6">
          <SectionIcon icon={ShieldCheck} color="bg-rose-100 text-rose-700" />
          <h2 className="text-2xl font-bold text-zinc-900">When Tasks Fail</h2>
        </div>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          With 3,000+ completed tasks, we&apos;ve also seen hundreds of failures. The delegation
          system needs to handle failure as a first-class outcome, not an exception.
        </p>

        <div className="space-y-3 mb-6">
          {[
            {
              title: "Structured failure reasons",
              desc: "Every failed task includes a failureReason field. This isn't just for humans — the Lead reads it to decide whether to retry, reassign, or escalate.",
            },
            {
              title: "Automatic memory indexing",
              desc: "When a task fails, the failure reason is indexed into the swarm's memory. Next time a similar task comes up, agents can search for past failures and avoid the same mistakes.",
            },
            {
              title: "Concurrency limits",
              desc: "Each agent has a MAX_CONCURRENT_TASKS setting. Overloading an agent causes context window pressure, leading to degraded output. We run most agents at 1-2 concurrent tasks.",
            },
            {
              title: "Pause and resume",
              desc: "Long-running tasks can be paused (freeing the agent for urgent work) and resumed later with full context. The session state is preserved so the agent picks up exactly where it left off.",
            },
          ].map((item) => (
            <div key={item.title} className="flex gap-4 items-start">
              <div className="w-1.5 h-1.5 rounded-full bg-rose-500 mt-2 shrink-0" />
              <div>
                <h3 className="text-[15px] font-semibold text-zinc-900 mb-1">{item.title}</h3>
                <p className="text-[14px] text-zinc-500 leading-relaxed">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <Callout>
          <strong>Lesson:</strong> The biggest source of task failures isn&apos;t bugs — it&apos;s
          context. An agent assigned a task without enough background information will either produce
          wrong output or waste time researching. Providing structured context in the task description
          (repo, file paths, relevant PRs) cuts failure rates dramatically.
        </Callout>
      </section>

      {/* Key Takeaways */}
      <section className="mb-14">
        <div className="flex items-center gap-3 mb-6">
          <SectionIcon icon={Zap} color="bg-amber-100 text-amber-700" />
          <h2 className="text-2xl font-bold text-zinc-900">Key Takeaways for Builders</h2>
        </div>

        <div className="space-y-4 mb-6">
          {[
            {
              title: "Model your task states explicitly",
              body: "Don't collapse assignment and execution into one state. Distributed agents need at least: unassigned, assigned, running, completed, failed. Add more as you discover gaps.",
            },
            {
              title: "Support both direct assignment and pools",
              body: "Direct assignment for specialized work, pools for load balancing. The offer/accept pattern is the bridge between them — the Lead suggests, the agent decides.",
            },
            {
              title: "Keep dependency DAGs wide and shallow",
              body: "Fan out work early, join results late. Deep chains are fragile. Our most reliable workflows have a fan-out of 3-5 parallel tasks with 2-3 levels of depth.",
            },
            {
              title: "Index failures into memory",
              body: "Every failed task is a learning opportunity. If agents can search past failures before starting similar work, your retry success rate goes up significantly.",
            },
            {
              title: "Context is everything",
              body: "The single biggest lever for task success is the quality of the task description. Include the repo, the files, the intent, and any constraints. An agent with good context succeeds; one without it wastes cycles.",
            },
          ].map((item) => (
            <div key={item.title} className="flex gap-4 items-start">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-2 shrink-0" />
              <div>
                <h3 className="text-[15px] font-semibold text-zinc-900 mb-1">{item.title}</h3>
                <p className="text-[14px] text-zinc-500 leading-relaxed">{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Closing */}
      <section className="mb-14">
        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Task delegation is the backbone of any multi-agent system. Get it wrong and your agents
          step on each other, starve for work, or fail silently. Get it right and you have a system
          that scales — add more agents, handle more work, without changing the architecture.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed">
          Agent Swarm is{" "}
          <a
            href="https://github.com/desplega-ai/agent-swarm"
            target="_blank"
            rel="noopener noreferrer"
            className="text-amber-700 hover:text-amber-900 font-medium underline underline-offset-2 decoration-amber-300 transition-colors"
          >
            open source
          </a>
          . The full task lifecycle, pool implementation, and workflow engine are in the repo. If
          you&apos;re building your own agent orchestrator, start there.
        </p>
      </section>

      {/* Links */}
      <footer className="border-t border-zinc-200 pt-8 mt-14">
        <h3 className="text-[13px] font-semibold text-zinc-500 uppercase tracking-wider mb-4">
          Links
        </h3>
        <div className="flex gap-2.5 flex-wrap">
          {[
            {
              href: "https://github.com/desplega-ai/agent-swarm",
              label: "GitHub",
            },
            {
              href: "https://agent-swarm.dev",
              label: "Landing Page",
            },
            {
              href: "https://docs.agent-swarm.dev",
              label: "Documentation",
            },
          ].map(({ href, label }) => (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-zinc-500 hover:text-zinc-800 bg-zinc-50 border border-zinc-200 hover:border-zinc-300 rounded-full px-3.5 py-1.5 transition-all"
            >
              <ExternalLink className="w-3 h-3" />
              {label}
            </a>
          ))}
        </div>

        <div className="mt-8 pt-6 border-t border-zinc-100">
          <h3 className="text-[13px] font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            Related Posts
          </h3>
          <Link
            href="/blog/swarm-metrics"
            className="group flex items-center gap-3 p-3 -mx-3 rounded-lg hover:bg-zinc-50 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-medium text-zinc-800 group-hover:text-amber-800 transition-colors">
                Agent Swarm by the Numbers: 80 Days, 242 PRs, 6 Agents
              </p>
              <p className="text-[12px] text-zinc-500 mt-0.5">
                In 80 days, our swarm of 6 AI agents autonomously created 242 pull requests across 4
                repositories.
              </p>
            </div>
            <ArrowRight className="w-4 h-4 text-zinc-400 group-hover:text-amber-600 shrink-0" />
          </Link>
        </div>
      </footer>
    </BlogPostLayout>
  );
}
