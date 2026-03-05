import type { Metadata } from "next";
import {
  ArrowLeft,
  Calendar,
  Clock,
  Users,
  GitPullRequest,
  Target,
  BarChart3,
  Bot,
  ExternalLink,
  Zap,
} from "lucide-react";
import { Navbar } from "@/components/navbar";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title:
    "Agent Swarm by the Numbers: 67 Days, 177 PRs, 6 Agents — Agent Swarm Blog",
  description:
    "In 67 days, our swarm of 6 AI agents autonomously created 177 pull requests across 4 repositories, completed 4 epics, and built its own UI, marketing campaign, and CLI tools.",
  openGraph: {
    title: "Agent Swarm by the Numbers: 67 Days, 177 PRs, 6 Agents",
    description:
      "In 67 days, our swarm of 6 AI agents autonomously created 177 pull requests across 4 repositories.",
    url: "https://agent-swarm.dev/blog/swarm-metrics",
    siteName: "Agent Swarm",
    type: "article",
    publishedTime: "2026-02-28T00:00:00Z",
    images: [
      {
        url: "https://agent-swarm.dev/og-image.png",
        width: 1200,
        height: 630,
        alt: "Agent Swarm by the Numbers: 67 Days, 177 PRs, 6 Agents",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Swarm by the Numbers: 67 Days, 177 PRs, 6 Agents",
    description:
      "In 67 days, our swarm of 6 AI agents autonomously created 177 pull requests across 4 repositories.",
    images: ["https://agent-swarm.dev/og-image.png"],
  },
  alternates: {
    canonical: "/blog/swarm-metrics",
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
    <div
      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${color}`}
    >
      <Icon className="w-4.5 h-4.5" />
    </div>
  );
}

function StatCard({
  value,
  label,
  sublabel,
}: {
  value: string;
  label: string;
  sublabel?: string;
}) {
  return (
    <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-5 text-center">
      <div className="text-3xl sm:text-4xl font-bold text-zinc-900 mb-1">
        {value}
      </div>
      <div className="text-[14px] font-medium text-zinc-600">{label}</div>
      {sublabel && (
        <div className="text-[12px] text-zinc-400 mt-0.5">{sublabel}</div>
      )}
    </div>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
      <div className="text-[14px] text-amber-900 leading-relaxed">
        {children}
      </div>
    </div>
  );
}

export default function SwarmMetricsPost() {
  return (
    <main className="min-h-screen bg-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            headline:
              "Agent Swarm by the Numbers: 67 Days, 177 PRs, 6 Agents",
            description:
              "In 67 days, our swarm of 6 AI agents autonomously created 177 pull requests across 4 repositories, completed 4 epics, and built its own UI, marketing campaign, and CLI tools.",
            datePublished: "2026-02-28T00:00:00Z",
            author: {
              "@type": "Organization",
              name: "Agent Swarm",
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
              "@id": "https://agent-swarm.dev/blog/swarm-metrics",
            },
            image: "https://agent-swarm.dev/og-image.png",
          }),
        }}
      />
      <Navbar />

      <article className="mx-auto max-w-3xl px-6 pt-32 pb-20">
        {/* Back link */}
        <a
          href="/blog"
          className="inline-flex items-center gap-1.5 text-[13px] text-zinc-400 hover:text-zinc-700 transition-colors mb-8"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Blog
        </a>

        {/* Header */}
        <header className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <span className="flex items-center gap-1.5 text-[13px] text-zinc-400">
              <Calendar className="w-3.5 h-3.5" />
              February 28, 2026
            </span>
            <span className="text-zinc-300">&middot;</span>
            <span className="flex items-center gap-1.5 text-[13px] text-zinc-400">
              <Clock className="w-3.5 h-3.5" />
              6 min read
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-zinc-900 leading-tight mb-4">
            Agent Swarm by the Numbers:{" "}
            <span className="gradient-text">
              67 Days, 177 PRs, 6 Agents
            </span>
          </h1>

          <p className="text-lg text-zinc-500 leading-relaxed max-w-2xl">
            From December 23 to February 28, a swarm of 6 AI agents
            autonomously shipped 177 pull requests across 4 repositories. They
            built their own UI, fixed their own bugs, and launched their own
            marketing campaign. Here are the numbers.
          </p>

          <div className="flex gap-2 flex-wrap mt-6">
            {["metrics", "AI agents", "automation", "open source"].map(
              (tag) => (
                <span
                  key={tag}
                  className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-500"
                >
                  {tag}
                </span>
              )
            )}
          </div>
        </header>

        {/* ---- Content ---- */}
        <div className="prose-custom">
          {/* Hero Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-14">
            <StatCard value="67" label="Days" sublabel="of operation" />
            <StatCard value="177" label="PRs Merged" sublabel="across 4 repos" />
            <StatCard value="6" label="Agents" sublabel="specialized roles" />
            <StatCard value="4" label="Epics" sublabel="completed" />
          </div>

          {/* Intro */}
          <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
            Agent Swarm is an open-source framework for orchestrating teams of
            AI agents. Each agent runs as a headless Claude Code process inside
            a Docker container, connected through an MCP server that handles
            task routing, messaging, and memory.
          </p>
          <p className="text-[15px] text-zinc-600 leading-relaxed mb-10">
            We&apos;ve been running our own swarm in production since December
            2025. One human (Taras) messages the swarm via Slack. The Lead agent
            interprets the request, delegates to the right specialist, and the
            work gets done. No manual task assignment. No copy-pasting between
            tools. Just Slack messages in, pull requests out.
          </p>

          {/* Section 1: The Team */}
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-6">
              <SectionIcon
                icon={Users}
                color="bg-amber-100 text-amber-700"
              />
              <h2 className="text-2xl font-bold text-zinc-900">
                The Team: 6 Specialized Agents
              </h2>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
              Each agent has a persistent identity, accumulated memory, and a
              specialized role. They don&apos;t just execute — they learn,
              develop preferences, and get better at their work over time.
            </p>

            <div className="space-y-3 mb-6">
              {[
                {
                  name: "Lead",
                  role: "Orchestrator",
                  desc: "Routes tasks, monitors progress, coordinates across agents. The single point of contact for humans via Slack.",
                  color: "bg-amber-100 text-amber-800",
                },
                {
                  name: "Picateclas",
                  role: "Implementation Engineer",
                  desc: "The coding arm. TypeScript, Node.js, git worktrees. Turns plans into PRs — fast.",
                  color: "bg-blue-100 text-blue-800",
                },
                {
                  name: "Researcher",
                  role: "Research & Analysis",
                  desc: "Explores codebases, plans implementations, writes documentation. Thinks before anyone codes.",
                  color: "bg-purple-100 text-purple-800",
                },
                {
                  name: "Reviewer",
                  role: "PR Review Specialist",
                  desc: "Reviews every pull request for quality, correctness, and style. The team's quality gate.",
                  color: "bg-emerald-100 text-emerald-800",
                },
                {
                  name: "Jackknife",
                  role: "Forward Deployed Engineer",
                  desc: "End-to-end testing, browser automation, and test maintenance. Catches what others miss.",
                  color: "bg-rose-100 text-rose-800",
                },
                {
                  name: "Tester",
                  role: "QA Specialist",
                  desc: "Feature verification, regression testing, PR verification. The final check before merge.",
                  color: "bg-cyan-100 text-cyan-800",
                },
              ].map((agent) => (
                <div
                  key={agent.name}
                  className="flex items-start gap-4 rounded-xl bg-zinc-50 border border-zinc-200 p-4"
                >
                  <div
                    className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${agent.color}`}
                  >
                    <Bot className="w-4.5 h-4.5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <h3 className="text-[15px] font-semibold text-zinc-900">
                        {agent.name}
                      </h3>
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-200/60 text-zinc-500">
                        {agent.role}
                      </span>
                    </div>
                    <p className="text-[13px] text-zinc-500 leading-relaxed">
                      {agent.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Section 2: PRs */}
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-6">
              <SectionIcon
                icon={GitPullRequest}
                color="bg-blue-100 text-blue-700"
              />
              <h2 className="text-2xl font-bold text-zinc-900">
                177 Pull Requests
              </h2>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
              Every line of code goes through pull requests — created, reviewed,
              and merged by the swarm. Here&apos;s the breakdown across
              repositories:
            </p>

            <div className="rounded-xl border border-zinc-200 overflow-hidden mb-6">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-200">
                    <th className="text-left px-4 py-3 font-semibold text-zinc-700">
                      Repository
                    </th>
                    <th className="text-center px-4 py-3 font-semibold text-zinc-700">
                      Jan
                    </th>
                    <th className="text-center px-4 py-3 font-semibold text-zinc-700">
                      Feb
                    </th>
                    <th className="text-center px-4 py-3 font-semibold text-zinc-700">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {[
                    {
                      repo: "agent-swarm",
                      jan: 42,
                      feb: 44,
                      total: 86,
                    },
                    {
                      repo: "desplega.ai",
                      jan: 32,
                      feb: 30,
                      total: 62,
                    },
                    {
                      repo: "x402-logo",
                      jan: 0,
                      feb: 17,
                      total: 17,
                    },
                    {
                      repo: "ai-toolbox",
                      jan: 7,
                      feb: 5,
                      total: 12,
                    },
                  ].map((row) => (
                    <tr key={row.repo}>
                      <td className="px-4 py-3 text-zinc-800 font-medium font-mono text-[13px]">
                        {row.repo}
                      </td>
                      <td className="px-4 py-3 text-center text-zinc-600">
                        {row.jan}
                      </td>
                      <td className="px-4 py-3 text-center text-zinc-600">
                        {row.feb}
                      </td>
                      <td className="px-4 py-3 text-center font-semibold text-zinc-900">
                        {row.total}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-zinc-50 font-semibold">
                    <td className="px-4 py-3 text-zinc-900">Total</td>
                    <td className="px-4 py-3 text-center text-zinc-700">81</td>
                    <td className="px-4 py-3 text-center text-zinc-700">96</td>
                    <td className="px-4 py-3 text-center text-zinc-900">177</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <Callout>
              <strong>Steady output:</strong> 81 PRs in January, 96 in
              February. The swarm doesn&apos;t slow down — it accelerates as
              agents accumulate codebase knowledge and the tooling improves.
            </Callout>
          </section>

          {/* Section 3: Epics */}
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-6">
              <SectionIcon
                icon={Target}
                color="bg-emerald-100 text-emerald-700"
              />
              <h2 className="text-2xl font-bold text-zinc-900">
                4 Epics Completed
              </h2>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
              Epics are multi-task projects that span days or weeks. Here&apos;s
              what the swarm shipped end-to-end:
            </p>

            <div className="space-y-4 mb-6">
              {[
                {
                  name: "GTM: 100k GitHub Stars",
                  tasks: "20 tasks (14 completed)",
                  desc: "Full marketing campaign: X/Twitter content strategy, Show HN post, dev.to articles, newsletter outreach, demo video scripts, and awesome-list submissions. The swarm planned and executed its own go-to-market.",
                  color: "bg-amber-500",
                },
                {
                  name: "UI Revamp",
                  tasks: "11 tasks (10 completed)",
                  desc: "Complete redesign of the swarm dashboard using shadcn/ui, AG Grid, and React Query. The swarm rebuilt its own interface — the one humans use to monitor it.",
                  color: "bg-blue-500",
                },
                {
                  name: "Lead Concurrency Fix",
                  tasks: "9 tasks (7 completed)",
                  desc: "Fixed concurrent session awareness with 3 PRs merged. Implemented Jaccard similarity duplicate detection and session tracking so the Lead doesn't create duplicate tasks.",
                  color: "bg-purple-500",
                },
                {
                  name: "dokcli",
                  tasks: "6 tasks (6 completed, 100% success)",
                  desc: "Built a Bun-based CLI that auto-generates commands from the Dokploy OpenAPI spec. The only epic with a perfect completion rate.",
                  color: "bg-emerald-500",
                },
              ].map((epic) => (
                <div
                  key={epic.name}
                  className="rounded-xl bg-zinc-50 border border-zinc-200 p-5"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${epic.color}`}
                    />
                    <h3 className="text-[15px] font-semibold text-zinc-900">
                      {epic.name}
                    </h3>
                    <span className="text-[11px] font-mono text-zinc-400 ml-auto">
                      {epic.tasks}
                    </span>
                  </div>
                  <p className="text-[14px] text-zinc-600 leading-relaxed pl-5">
                    {epic.desc}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Section 4: Task Stats */}
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-6">
              <SectionIcon
                icon={BarChart3}
                color="bg-purple-100 text-purple-700"
              />
              <h2 className="text-2xl font-bold text-zinc-900">
                Task Execution
              </h2>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
              Every piece of work is tracked as a task — from single-file fixes
              to multi-day epics. Tasks are routed by the Lead, executed by
              workers, and the results are stored in searchable memory.
            </p>

            <div className="grid grid-cols-3 gap-3 mb-6">
              <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-center">
                <div className="text-2xl font-bold text-emerald-800">
                  Hundreds
                </div>
                <div className="text-[12px] text-emerald-600 mt-0.5">
                  completed
                </div>
              </div>
              <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-center">
                <div className="text-2xl font-bold text-red-800">61</div>
                <div className="text-[12px] text-red-600 mt-0.5">failed</div>
              </div>
              <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-4 text-center">
                <div className="text-2xl font-bold text-zinc-700">33</div>
                <div className="text-[12px] text-zinc-500 mt-0.5">
                  cancelled
                </div>
              </div>
            </div>

            <Callout>
              <strong>~75%+ success rate</strong> — and failures are
              informative. When a task fails, the agent reports what went wrong,
              and those learnings are indexed into memory so the same mistake
              isn&apos;t repeated.
            </Callout>

            <p className="text-[15px] text-zinc-600 leading-relaxed">
              The swarm operates across 5 active agents (Lead handles routing,
              4 workers handle implementation), with tasks flowing through a
              lifecycle:{" "}
              <span className="font-mono text-[13px] text-zinc-500">
                unassigned &rarr; offered &rarr; pending &rarr; in_progress
                &rarr; completed
              </span>
              . Each transition is logged and visible in the dashboard.
            </p>
          </section>

          {/* Section 5: Highlights */}
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-6">
              <SectionIcon icon={Zap} color="bg-amber-100 text-amber-700" />
              <h2 className="text-2xl font-bold text-zinc-900">
                Highlights
              </h2>
            </div>

            <div className="space-y-4 mb-6">
              {[
                {
                  title: "Self-improving infrastructure",
                  body: "The swarm built and rebuilt its own dashboard, fixed its own concurrency bugs, and optimized its own task routing. It's not just running — it's maintaining itself.",
                },
                {
                  title: "Slack-native orchestration",
                  body: "Taras sends a message in Slack. The Lead agent reads it, creates tasks, and delegates to the right specialist. Results come back as PR links, Slack replies, or deployed services.",
                },
                {
                  title: "First on-chain transaction",
                  body: "During the Openfort hackathon, the swarm made its first autonomous crypto payment — $0.10 USDC on Base mainnet to buy an SVG from omghost.xyz via the x402 protocol.",
                },
                {
                  title: "Persistent agent memory",
                  body: "Each agent has searchable memory powered by embeddings. Solutions, patterns, and mistakes are indexed automatically — so the swarm gets smarter with every task.",
                },
              ].map((item) => (
                <div key={item.title} className="flex gap-4 items-start">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-2 shrink-0" />
                  <div>
                    <h3 className="text-[15px] font-semibold text-zinc-900 mb-1">
                      {item.title}
                    </h3>
                    <p className="text-[14px] text-zinc-500 leading-relaxed">
                      {item.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* What's Next */}
          <section className="mb-14">
            <h2 className="text-2xl font-bold text-zinc-900 mb-6">
              What&apos;s Next
            </h2>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
              67 days in, the swarm is just getting started. The numbers tell
              the story of a system that works — agents that ship real code,
              review each other&apos;s work, and learn from their mistakes.
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
              . If you want to run your own swarm — or join ours — the code,
              docs, and dashboard are all public.
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
                {
                  href: "https://agent-swarm.dev/blog/openfort-hackathon",
                  label: "Openfort Hackathon Post",
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
          </footer>
        </div>
      </article>

      <Footer />
    </main>
  );
}
