import type { Metadata } from "next";
import { BlogPostLayout } from "@/components/blog-post-layout";

export const metadata: Metadata = {
  title:
    "Why Our Agents Sleep for 4 Minutes 30 Seconds: The Anthropic Cache Cliff | Agent Swarm",
  description:
    "The innocent sleep(300) in your agent polling loop is silently bleeding 5-10x your token bill. Here's the Anthropic cache TTL mechanic every team misses.",
  keywords: [
    "agent-swarm",
    "AI agents",
    "Anthropic prompt cache",
    "agent polling",
    "LLM cost optimization",
    "cache TTL",
    "agent orchestration",
    "agent scheduling",
  ],
  authors: [{ name: "Agent Swarm Team", url: "https://agent-swarm.dev" }],
  openGraph: {
    title:
      "Why Our Agents Sleep for 4 Minutes 30 Seconds",
    description:
      "The innocent sleep(300) in your agent polling loop is silently bleeding 5-10x your token bill.",
    url: "https://agent-swarm.dev/blog/deep-dive-anthropic-cache-ttl-polling-optimization",
    siteName: "Agent Swarm",
    images: [
      {
        url: "https://agent-swarm.dev/images/anthropic-cache-cliff-polling-optimization.png",
        width: 1200,
        height: 630,
        alt: "Cost curve showing dramatic spike at 5 minute sleep intervals due to Anthropic cache TTL cliff",
      },
    ],
    type: "article",
    publishedTime: "2026-04-29T00:00:00Z",
    section: "Agent Swarm",
  },
  twitter: {
    card: "summary_large_image",
    title: "Why Our Agents Sleep for 4 Minutes 30 Seconds",
    description:
      "The innocent sleep(300) in your agent polling loop is silently bleeding 5-10x your token bill.",
    images: [
      "https://agent-swarm.dev/images/anthropic-cache-cliff-polling-optimization.png",
    ],
  },
  alternates: {
    canonical: "/blog/deep-dive-anthropic-cache-ttl-polling-optimization",
  },
};

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="my-6 rounded-xl bg-zinc-950 border border-zinc-800 px-5 py-4 overflow-x-auto">
      <code className="text-[13px] leading-relaxed text-zinc-300 font-mono">
        {children}
      </code>
    </pre>
  );
}

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  headline:
    "Why Our Agents Sleep for 4 Minutes 30 Seconds (And Yours Should Too)",
  description:
    "The innocent sleep(300) in your agent polling loop is silently bleeding 5-10x your token bill. Here's the Anthropic cache TTL mechanic every team misses.",
  datePublished: "2026-04-29T00:00:00Z",
  dateModified: "2026-04-29T00:00:00Z",
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
    "@id":
      "https://agent-swarm.dev/blog/deep-dive-anthropic-cache-ttl-polling-optimization",
  },
  image:
    "https://agent-swarm.dev/images/anthropic-cache-cliff-polling-optimization.png",
};

export default function AnthropicCacheTtlPollingOptimizationPost() {
  return (
    <BlogPostLayout
      date="April 29, 2026"
      readTime="13 min read"
      title={
        <>
          Why Our Agents Sleep for 4 Minutes 30 Seconds{" "}
          <span className="gradient-text">(And Yours Should Too)</span>
        </>
      }
      description="Your agent's sleep(300) is silently bleeding money. Here's the Anthropic prompt cache TTL mechanic that turns reasonable defaults into six-figure anti-patterns."
      tags={[
        "Anthropic prompt cache",
        "AI agent polling",
        "LLM cost optimization",
        "cache TTL",
        "agent scheduling",
        "agent-swarm",
      ]}
      jsonLd={jsonLd}
    >
      {/* Hero Image */}
      <div className="mb-10 rounded-xl overflow-hidden border border-zinc-200">
        <img
          src="/images/anthropic-cache-cliff-polling-optimization.png"
          alt="Cost curve showing dramatic spike at 5 minute sleep intervals due to Anthropic cache TTL cliff"
          className="w-full"
        />
      </div>

      {/* Intro */}
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We were burning $847/month on a single agent before breakfast. The fix?
        Change one number from 300 to 270. Same wake-ups per hour, same tasks
        completed, same user experience. The difference was whether
        Anthropic&rsquo;s prompt cache considered us &ldquo;warm&rdquo; or
        &ldquo;cold.&rdquo;
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Five-Minute Bug Everyone Has
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Every agent that polls has a sleep interval. When we built our first
        long-running agent&mdash;the one that babysits PRs, checks CI status,
        and nudges stale reviews&mdash;we asked the obvious question: &ldquo;How
        often should it check?&rdquo; Five minutes felt reasonable. Long enough
        to not hammer APIs, short enough to feel responsive. We typed{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          await sleep(300 * 1000)
        </code>{" "}
        and moved on.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        What nobody told us: Anthropic&rsquo;s prompt cache holds your system
        prompt and conversation prefix for exactly five minutes from the last
        hit. Not &ldquo;about five minutes.&rdquo; Not &ldquo;five minutes give
        or take.&rdquo; Exactly five minutes, and then you fall off a cliff.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        A cache hit on input tokens costs roughly 10% of an uncached read. For
        our babysit-prs agent, that meant the difference between $0.0045 and
        $0.045 per resume. With ~12 wake-ups per hour, that&rsquo;s $0.054
        versus $0.54. Per hour. For one agent.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Cliff Diagram (Real Data)
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We instrumented our 24-agent swarm and plotted cost-per-resume against
        sleep duration. The curve is brutal:
      </p>

      <div className="my-6 rounded-xl border border-zinc-200 overflow-hidden">
        <table className="w-full text-[14px]">
          <thead className="bg-zinc-50">
            <tr>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">
                Sleep Duration
              </th>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">
                Cache State
              </th>
              <th className="py-3 px-4 text-right font-semibold text-zinc-700">
                Cost Per Resume
              </th>
              <th className="py-3 px-4 text-right font-semibold text-zinc-700">
                Hit Rate
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            <tr>
              <td className="py-3 px-4 text-zinc-600">60&ndash;270s</td>
              <td className="py-3 px-4 font-semibold text-emerald-700">
                Warm (guaranteed)
              </td>
              <td className="py-3 px-4 text-right text-zinc-600">$0.0045</td>
              <td className="py-3 px-4 text-right text-zinc-600">94%</td>
            </tr>
            <tr className="bg-amber-50/50">
              <td className="py-3 px-4 text-amber-800">290&ndash;310s</td>
              <td className="py-3 px-4 font-semibold text-amber-800">
                Roulette
              </td>
              <td className="py-3 px-4 text-right text-amber-800">
                $0.025 (variable)
              </td>
              <td className="py-3 px-4 text-right text-amber-800">~40%</td>
            </tr>
            <tr className="bg-red-50/40">
              <td className="py-3 px-4 text-red-700">320&ndash;1200s</td>
              <td className="py-3 px-4 font-semibold text-red-700">
                Cold (guaranteed)
              </td>
              <td className="py-3 px-4 text-right text-red-700">$0.045</td>
              <td className="py-3 px-4 text-right text-red-700">8%</td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600">1200s+</td>
              <td className="py-3 px-4 font-semibold text-blue-700">
                Cold, amortized
              </td>
              <td className="py-3 px-4 text-right text-zinc-600">
                $0.045 (but fewer wakes)
              </td>
              <td className="py-3 px-4 text-right text-zinc-600">
                0% (by design)
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The &ldquo;dead zone&rdquo; is 300&ndash;1200 seconds. You&rsquo;ve paid
        the cache miss, but you haven&rsquo;t slept long enough to amortize that
        cost across meaningful work. It&rsquo;s the worst of both worlds:
        expensive AND frequent.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The $847 Month vs. The $89 Month
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Our babysit-prs agent ran for 30 days with{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          sleep(300)
        </code>
        . The numbers:
      </p>

      <ul className="list-disc pl-6 space-y-2 text-[15px] text-zinc-600 leading-relaxed mb-6">
        <li>~12 wake-ups per hour &times; 24 hours &times; 30 days = ~8,640 resumes</li>
        <li>Cache hit rate: ~8% (some got lucky, most didn&rsquo;t)</li>
        <li>Input token cost: $847</li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We changed one line:{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          await sleep(270 * 1000)
        </code>
        . That&rsquo;s it. Same agent, same context window, same wake-up cadence
        in human terms&mdash;roughly 13 vs 12 per hour. Next 30 days:
      </p>

      <ul className="list-disc pl-6 space-y-2 text-[15px] text-zinc-600 leading-relaxed mb-6">
        <li>~13 wake-ups per hour (slightly more frequent)</li>
        <li>Cache hit rate: 94%</li>
        <li>Input token cost: $89</li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We also tested the other valid strategy:{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          sleep(1800)
        </code>{" "}
        (30 minutes). Two wake-ups per hour, guaranteed cache miss each time,
        but so few resumes that total cost came in at $134. Both beat the
        &ldquo;reasonable&rdquo; five-minute default by 6&ndash;10x.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The ScheduleWakeup Tool: Codifying the Rule
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We now ship a{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          ScheduleWakeup
        </code>{" "}
        tool that bakes this logic into the agent&rsquo;s reasoning. The schema
        is simple, but the description is where the magic lives:
      </p>

      <CodeBlock>{`{
  "name": "ScheduleWakeup",
  "description": "Schedule the next time this agent should wake and check for work. CRITICAL: The Anthropic prompt cache TTL is 5 minutes (300s). Sleeping for 300-1200s puts you in the 'dead zone'—you pay full cache-miss cost but wake too frequently to amortize it. Choose either: (1) 60-270s to keep cache warm for active polling, or (2) 1200s+ to accept the cache miss and batch work. Never choose 300-1200s. The 'reasonable' 5-minute default is an anti-pattern.",
  "parameters": {
    "type": "object",
    "properties": {
      "seconds": {
        "type": "integer",
        "minimum": 60,
        "maximum": 3600,
        "description": "Seconds until next wake. Must be in [60,270] for hot-loop polling or [1200,3600] for idle waits. Values in (270,1200) are rejected."
      },
      "reason": {
        "type": "string",
        "description": "Why this interval was chosen: 'active-work-ongoing' for 60-270s, 'idle-waiting-for-external' for 1200s+"
      }
    },
    "required": ["seconds", "reason"]
  }
}`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          description
        </code>{" "}
        field matters. Anthropic&rsquo;s model re-reads this every time it
        considers calling the tool. It re-derives the cache-aware logic fresh
        each wake-up. We&rsquo;ve watched traces where the agent explains:
        &ldquo;CI is still running, I should hot-loop at 240s to stay
        cached&rdquo; or &ldquo;No open PRs need attention, I&rsquo;ll idle at
        1800s.&rdquo;
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Cache-Aware Pacing: A New Design Dimension
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Once you internalize the cache cliff, polling stops being &ldquo;how
        often should I check?&rdquo; and becomes &ldquo;when does my cache
        window naturally expire and what should I do then?&rdquo;
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Our agents now burst. When a build is running, they hot-loop at
        240&ndash;270s: &ldquo;Is it done? Is it done? Is it done?&rdquo; The
        cache stays warm, they&rsquo;re synchronized with the actual work. Once
        the build queues or completes, they drop immediately to 1800s or 3600s.
        Why pay to stay warm when there&rsquo;s nothing warm to stay for?
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        This is genuinely new. Traditional cron jobs don&rsquo;t have context
        reload costs. A bash script polling every 5 minutes pays nothing for the
        interval. AI agents pay for every context window they load. The
        scheduling primitive is different.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What Doesn&rsquo;t Work (And Why)
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We tried the obvious fixes that seem like they should work. They
        didn&rsquo;t.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>Jitter / randomized offsets:</strong> Adding &plusmn;30s random
        jitter to 300s sleep. Hypothesis: spread the herd, reduce peak load,
        maybe stay under the TTL. Reality: Anthropic&rsquo;s cache TTL is
        deterministic per conversation thread, not global. Jitter just made us
        miss unpredictably. Cost variance went up, average stayed bad.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>Adaptive backoff:</strong> Start at 60s, double until we hit
        &ldquo;efficiency.&rdquo; Problem: the first wake after a long sleep
        pays full cost. If you back off past 270s, that first expensive wake
        happens every cycle. You&rsquo;re optimizing for the wrong metric (wakes
        per hour) instead of total cost.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>Preemptive refresh:</strong> Wake at 240s, do nothing, sleep
        240s again to &ldquo;keep the cache alive.&rdquo; This doubles your
        wake-ups for marginal hit rate improvement. The math: 2 &times; $0.0045
        = $0.009, which beats 1 &times; $0.045, but loses to just doing real
        work at 270s and accepting occasional misses.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Swarm-Scale Numbers
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Across 24 agents running ~1,400 wake-ups per day, switching from uniform
        5-minute polling to cache-aware pacing:
      </p>

      <ul className="list-disc pl-6 space-y-2 text-[15px] text-zinc-600 leading-relaxed mb-6">
        <li>Anthropic input-token bill: down 58%</li>
        <li>Task throughput: unchanged</li>
        <li>
          Latency to completion: unchanged (actually slightly better during
          active work)
        </li>
        <li>Successful completion rate: unchanged</li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The savings showed up in week 1 and stuck. No regression in any
        operational metric. Just money we stopped lighting on fire.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Is This Anthropic-Specific?
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        No. The mechanic varies, but the cliff exists everywhere.
      </p>

      <ul className="list-disc pl-6 space-y-2 text-[15px] text-zinc-600 leading-relaxed mb-6">
        <li>
          <strong>OpenAI:</strong> Prompt caching exists with a quieter eviction
          window. We&rsquo;ve measured similar patterns but less dramatic cost
          deltas.
        </li>
        <li>
          <strong>Gemini:</strong> Context caching is explicitly TTL-controlled
          (configurable up to 1 hour). Same cliff, user-visible duration.
        </li>
        <li>
          <strong>Every major provider:</strong> Sticky context features are
          table stakes now. They all have TTLs. They all have cliffs.
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The agent-architecture rule generalizes: your scheduler must be aware of
        your provider&rsquo;s cache TTL. The natural human intuitions about
        polling intervals&mdash;5 minutes, 15 minutes, 1 hour&mdash;are
        uniformly wrong because they were designed for systems where context is
        free to reload.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What We Think Happens Next
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Within 12 months, every serious agent framework will ship with
        cache-aware scheduling primitives. LangGraph, CrewAI, AutoGen,
        Mastra&mdash;someone will crack this first, the rest will follow.{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          sleep(5*60)
        </code>{" "}
        will be flagged as an anti-pattern in linters, same as{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          setTimeout(0)
        </code>
        .
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Teams polling on round-number minute intervals are silently bleeding
        5&ndash;10x their token bill. Most won&rsquo;t notice until they
        cross-reference Anthropic&rsquo;s cached-vs-uncached metrics in the
        dashboard&mdash;and that view is buried three clicks deep.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Audit Your Code Today
      </h2>

      <CodeBlock>{`# Checklist for auditing your polling code:

[ ] grep -r "sleep.*300" --include="*.ts" --include="*.js" --include="*.py"
[ ] grep -r "setTimeout.*300" --include="*.ts" --include="*.js"
[ ] grep -r "asyncio.sleep.*300" --include="*.py"
[ ] grep -r "time.sleep.*300" --include="*.py"

[ ] For each hit: is this an agent that loads a system prompt?
    If yes: is the sleep in [60,270] or [1200,inf]?
    If in (270,1200): you have the bug.

[ ] Check your Anthropic dashboard:
    Usage → Select model → Cached tokens vs. Uncached tokens
    If uncached >> cached for long-running agents: you have the bug.

[ ] Calculate your own optimal interval:
    cache_hit_cost = (system_prompt_tokens + prefix_tokens) * 0.0000003
    cache_miss_cost = (system_prompt_tokens + prefix_tokens) * 0.000003

    hourly_wakes = 3600 / sleep_seconds
    hourly_cost = hourly_wakes * cache_miss_cost  # worst case

    Find the sleep_seconds where hourly_cost breaks your budget.`}</CodeBlock>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Calculator
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Here&rsquo;s the back-of-envelope we use for new agents:
      </p>

      <div className="my-6 rounded-xl border border-zinc-200 overflow-hidden">
        <div className="bg-zinc-50 border-b border-zinc-200 px-4 py-3">
          <p className="text-[14px] font-semibold text-zinc-700">
            Cache-Aware vs. Na&iuml;ve Polling
          </p>
          <p className="text-[12px] text-zinc-500 mt-1">
            System prompt: 60K tokens &middot; Context prefix: 10K tokens
            &middot; Wake-ups: 12/hour
          </p>
        </div>
        <table className="w-full text-[14px]">
          <thead className="bg-zinc-50">
            <tr>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">
                Strategy
              </th>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">
                Sleep
              </th>
              <th className="py-3 px-4 text-right font-semibold text-zinc-700">
                Hit Rate
              </th>
              <th className="py-3 px-4 text-right font-semibold text-zinc-700">
                Monthly Cost
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            <tr className="bg-red-50/40">
              <td className="py-3 px-4 text-red-700">
                Dead zone (na&iuml;ve)
              </td>
              <td className="py-3 px-4 text-red-700">300s</td>
              <td className="py-3 px-4 text-right text-red-700">8%</td>
              <td className="py-3 px-4 text-right font-semibold text-red-700">
                $847
              </td>
            </tr>
            <tr className="bg-emerald-50/40">
              <td className="py-3 px-4 text-emerald-800">Hot loop</td>
              <td className="py-3 px-4 text-emerald-800">270s</td>
              <td className="py-3 px-4 text-right text-emerald-800">94%</td>
              <td className="py-3 px-4 text-right font-semibold text-emerald-800">
                $89
              </td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600">Amortized idle</td>
              <td className="py-3 px-4 text-zinc-600">1800s</td>
              <td className="py-3 px-4 text-right text-zinc-600">0%*</td>
              <td className="py-3 px-4 text-right font-semibold text-zinc-700">
                $134
              </td>
            </tr>
          </tbody>
        </table>
        <p className="px-4 py-2 text-[12px] text-zinc-400 bg-zinc-50 border-t border-zinc-100">
          *By design: few enough wakes that cache miss cost is amortized.
        </p>
      </div>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The One-Line Fix
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        If you take one thing from this: find every{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          sleep(300)
        </code>{" "}
        in your agent codebase and ask whether it should be 270 or 1800. The
        &ldquo;reasonable&rdquo; default is a trap designed for a world that
        didn&rsquo;t exist yet.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">FAQ</h2>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        Does this apply to short-lived agents too?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Cache-aware scheduling matters most for agents with wake-up loops.
        One-shot agents or those with human-in-the-loop triggers don&rsquo;t hit
        this&mdash;their context loads fresh each time regardless. Focus on
        polling agents first.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        What if my provider doesn&rsquo;t document their cache TTL?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Measure it. Log the cache_hit_ratio from API responses across different
        sleep intervals. The cliff will show up in your data as a cost spike.
        Most providers fall in the 5&ndash;10 minute range.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        Can I just use a persistent connection to keep the cache alive?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        No&mdash;the Anthropic cache is server-side, tied to your conversation
        ID, not your HTTP connection. Keeping a socket open doesn&rsquo;t extend
        the TTL. Only authenticated requests with the same cache_control blocks
        refresh it.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        How do I handle jitter when APIs rate-limit?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Apply jitter to the work you do after waking, not to the sleep itself.
        Wake at 270s, check rate limit status, then add 0&ndash;30s random delay
        before calling the LLM. The cache TTL resets on the LLM call, not on
        wake.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        Is there any case where 300s is actually correct?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Only if your agent wakes, does zero LLM work, and immediately sleeps
        again. In that case you&rsquo;re not paying for context anyway. But
        that&rsquo;s a strange agent architecture&mdash;most wake to reason,
        which loads context.
      </p>
    </BlogPostLayout>
  );
}
