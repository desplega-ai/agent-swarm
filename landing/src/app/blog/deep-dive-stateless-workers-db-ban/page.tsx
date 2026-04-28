import type { Metadata } from "next";
import { BlogPostLayout } from "@/components/blog-post-layout";

export const metadata: Metadata = {
  title:
    "Our AI Worker Containers Have Zero Local Database — And a 30-Line Bash Script That Makes It Impossible to Add One | Agent Swarm",
  description:
    "How we banned database imports from worker containers with a bash script, and why it saved our agent swarm from catastrophic state divergence.",
  keywords: [
    "agent-swarm",
    "AI agents",
    "orchestration",
    "stateless workers",
    "database boundary",
    "microservices",
    "distributed systems",
    "sqlite",
    "horizontal scaling",
  ],
  authors: [{ name: "Agent Swarm Team", url: "https://agent-swarm.dev" }],
  openGraph: {
    title:
      "Our AI Worker Containers Have Zero Local Database",
    description:
      "How we banned database imports from worker containers with a bash script, and why it saved our agent swarm from catastrophic state divergence.",
    url: "https://agent-swarm.dev/blog/deep-dive-stateless-workers-db-ban",
    siteName: "Agent Swarm",
    images: [
      {
        url: "https://agent-swarm.dev/images/deep-dive-stateless-workers-db-ban.png",
        width: 1200,
        height: 630,
        alt: "Stateless worker architecture diagram showing API boundary between workers and database",
      },
    ],
    type: "article",
    publishedTime: "2026-04-27T00:00:00Z",
    section: "Agent Swarm",
  },
  twitter: {
    card: "summary_large_image",
    title: "Our AI Worker Containers Have Zero Local Database",
    description:
      "How we banned database imports from worker containers with a bash script, and why it saved our agent swarm from catastrophic state divergence.",
    images: [
      "https://agent-swarm.dev/images/deep-dive-stateless-workers-db-ban.png",
    ],
  },
  alternates: {
    canonical: "/blog/deep-dive-stateless-workers-db-ban",
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
    "Our AI Worker Containers Have Zero Local Database — And a 30-Line Bash Script That Makes It Impossible to Add One",
  description:
    "How we banned database imports from worker containers with a bash script, and why it saved our agent swarm from catastrophic state divergence.",
  datePublished: "2026-04-27T00:00:00Z",
  dateModified: "2026-04-27T00:00:00Z",
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
      "https://agent-swarm.dev/blog/deep-dive-stateless-workers-db-ban",
  },
  image:
    "https://agent-swarm.dev/images/deep-dive-stateless-workers-db-ban.png",
};

export default function StatelessWorkersDbBanPost() {
  return (
    <BlogPostLayout
      date="April 27, 2026"
      readTime="13 min read"
      title={
        <>
          Our AI Worker Containers Have Zero Local Database{" "}
          <span className="gradient-text">
            And a 30-Line Bash Script That Makes It Impossible to Add One
          </span>
        </>
      }
      description="How we banned database imports from worker containers with a bash script, and why it saved our agent swarm from catastrophic state divergence."
      tags={[
        "stateless workers",
        "database boundary",
        "microservices",
        "distributed systems",
        "agent architecture",
        "horizontal scaling",
      ]}
      jsonLd={jsonLd}
    >
      {/* Hero Image */}
      <div className="mb-10 rounded-xl overflow-hidden border border-zinc-200">
        <img
          src="/images/deep-dive-stateless-workers-db-ban.png"
          alt="Stateless worker architecture diagram showing API boundary between workers and database"
          className="w-full"
        />
      </div>

      {/* Intro */}
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Three workers. Three SQLite databases. Three different beliefs about
        whether task #8472 was pending, in-progress, or complete.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We shipped three contradictory pull requests to the same Linear issue
        before anyone noticed. Each worker had &ldquo;successfully&rdquo;
        updated its own local state. None of them had checked with each other.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        This is the story of why we banned database imports from our worker
        containers entirely&mdash;not with documentation, not with code review
        checklists, but with a 30-line bash script that runs in CI and fails the
        build if any worker tries to touch a database module.
      </p>

      {/* Section: The Incident */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Incident: When &ldquo;Fast Memory&rdquo; Becomes Distributed
        Corruption
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Our agent swarm architecture seemed sensible: an API server owns the
        task queue, workers pull tasks and execute them. But workers need
        context&mdash;previous actions, conversation history, cached
        embeddings. We added SQLite because &ldquo;it&rsquo;s just temporary
        state&rdquo; and &ldquo;direct SQL is faster than HTTP calls.&rdquo;
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The pattern was everywhere in our codebase. Workers would:
      </p>

      <ul className="space-y-2 text-[15px] text-zinc-600 leading-relaxed pl-6 list-disc mb-6">
        <li>Fetch a task from the API</li>
        <li>
          Write{" "}
          <code>UPDATE tasks SET status = &lsquo;in_progress&rsquo;</code> to
          local SQLite
        </li>
        <li>
          Begin work, periodically syncing &ldquo;real&rdquo; progress back to
          the API
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        This worked fine with one worker. It worked fine with two. At three
        workers, the race conditions started.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Worker A pulled task #8472, wrote <code>in_progress</code> to its
        SQLite, started processing. Worker B, starting 400ms later, found the
        task still marked <code>pending</code> in the API (Worker A hadn&rsquo;t
        synced yet), pulled it, wrote <code>in_progress</code> to its own
        SQLite, and started processing. Worker C did the same.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Three LLM inference sessions. Three conflicting code suggestions. Three
        PRs opened against the same Linear ticket. The API server eventually
        received three completion notifications and had to reconcile
        conflicting outputs.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The debugging session was a nightmare. Each worker&rsquo;s SQLite had
        a different timeline. The API server had a fourth timeline. We had to
        manually reconstruct which worker did what when, cross-referencing
        container logs with database timestamps that weren&rsquo;t synchronized.
      </p>

      {/* Section: The Rule */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Rule: Six Paths, Two Patterns, Zero Exceptions
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We made a decision immediately after that incident: worker containers
        may not import database modules, ever. Not for caching. Not for
        temporary state. Not for &ldquo;just this one query.&rdquo;
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We codified this in three layers:
      </p>

      <ul className="space-y-2 text-[15px] text-zinc-600 leading-relaxed pl-6 list-disc mb-6">
        <li>
          <strong>Architectural:</strong> Workers are stateless executors. The
          API server is the sole owner of state.
        </li>
        <li>
          <strong>API design:</strong> Every worker action that previously
          touched the database now goes through HTTP endpoints.
        </li>
        <li>
          <strong>Enforcement:</strong> A bash script that runs in CI and fails
          the build on any violation.
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The forbidden zones in our worker codebase:
      </p>

      <ul className="space-y-2 text-[15px] text-zinc-600 leading-relaxed pl-6 list-disc mb-6">
        <li>
          <code>src/commands/</code>&mdash;CLI commands that trigger agent
          actions
        </li>
        <li>
          <code>src/hooks/</code>&mdash;lifecycle hooks for task execution
        </li>
        <li>
          <code>src/providers/</code>&mdash;LLM provider integrations and tool
          definitions
        </li>
        <li>
          <code>src/prompts/</code>&mdash;prompt templates and context assembly
        </li>
        <li>
          <code>src/cli.tsx</code>&mdash;main entry point and command routing
        </li>
        <li>
          <code>src/claude.ts</code>&mdash;Claude-specific integration and
          response parsing
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The two forbidden import patterns:
      </p>

      <ul className="space-y-2 text-[15px] text-zinc-600 leading-relaxed pl-6 list-disc mb-6">
        <li>
          <code>from &lsquo;be/db&rsquo;</code>&mdash;our database query layer
        </li>
        <li>
          <code>bun:sqlite</code>&mdash;the raw SQLite driver
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Pattern-based detection beats type-based enforcement because it&rsquo;s
        trivial to verify and impossible to circumvent through type gymnastics.
        You either import the module or you don&rsquo;t.
      </p>

      {/* Section: Why bash, not eslint */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Why Bash, Not ESLint?
      </h2>

      <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
        <div className="text-[14px] text-amber-900 leading-relaxed">
          Because{" "}
          <code>// eslint-disable-next-line @agent-swarm/no-db-import</code>{" "}
          exists. ESLint rules can be bypassed with a comment. Bash grep checks
          the actual file content&mdash;a violation either exists or it
          doesn&rsquo;t.
        </div>
      </div>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We tried lint rules first. They&rsquo;re elegant. They integrate with
        IDEs. They provide helpful error messages. And they fail exactly when
        you need them most&mdash;under deadline pressure, when someone really
        needs to &ldquo;just add one quick query.&rdquo;
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Bash is dumb. Bash is fast. Bash checks the actual file content. A
        violation either exists in the file or it doesn&rsquo;t. There&rsquo;s
        no semantic analysis to bypass, no configuration to tweak, no comment
        directive to suppress.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Here&rsquo;s the full script we run in CI:
      </p>

      <CodeBlock>{`#!/bin/bash
# scripts/check-db-boundary.sh
# Enforces: workers may never import database modules

set -euo pipefail

# Forbidden patterns
DB_MODULE="from ['\\"]be/db['\\"]"
SQLITE_DRIVER="bun:sqlite"

# Worker paths that must remain database-free
WORKER_PATHS=(
  "src/commands/"
  "src/hooks/"
  "src/providers/"
  "src/prompts/"
  "src/cli.tsx"
  "src/claude.ts"
)

VIOLATIONS=0

for path in "\${WORKER_PATHS[@]}"; do
  if [ -d "$path" ]; then
    if grep -rE "$DB_MODULE" "$path" --include="*.ts" --include="*.tsx" 2>/dev/null; then
      echo "ERROR: Database module import found in $path"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
    if grep -rE "$SQLITE_DRIVER" "$path" --include="*.ts" --include="*.tsx" 2>/dev/null; then
      echo "ERROR: SQLite driver import found in $path"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  elif [ -f "$path" ]; then
    if grep -E "$DB_MODULE" "$path" 2>/dev/null; then
      echo "ERROR: Database module import found in $path"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
    if grep -E "$SQLITE_DRIVER" "$path" 2>/dev/null; then
      echo "ERROR: SQLite driver import found in $path"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  fi
done

if [ $VIOLATIONS -gt 0 ]; then
  echo ""
  echo "Found $VIOLATIONS database boundary violation(s)."
  echo "Workers must remain stateless. Use HTTP APIs instead."
  exit 1
fi

echo "Database boundary check passed."`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Run time: ~200ms on our entire worker codebase. The CI step looks like
        this:
      </p>

      <CodeBlock>{`# .github/workflows/ci.yml
- name: Enforce database boundary
  run: |
    chmod +x scripts/check-db-boundary.sh
    ./scripts/check-db-boundary.sh`}</CodeBlock>

      {/* Section: The Replacement */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Replacement: HTTP-First Architecture
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Every worker action that previously touched the database now goes
        through our API server. The surface is simple:
      </p>

      <div className="my-6 rounded-xl border border-zinc-200 overflow-hidden">
        <table className="w-full text-[14px]">
          <thead className="bg-zinc-50">
            <tr>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">
                Old pattern
              </th>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">
                New pattern
              </th>
              <th className="py-3 px-4 text-right font-semibold text-zinc-700">
                Latency
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            <tr>
              <td className="py-3 px-4 text-zinc-600 align-top">
                <code>db.query(&lsquo;SELECT * FROM tasks...&rsquo;)</code>
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top">
                <code>GET /api/tasks/:id</code>
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top text-right">
                +12ms
              </td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600 align-top">
                <code>db.exec(&lsquo;UPDATE tasks...&rsquo;)</code>
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top">
                <code>POST /api/tasks/:id/progress</code>
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top text-right">
                +8ms
              </td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600 align-top">
                <code>INSERT INTO messages...</code>
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top">
                <code>POST /api/messages</code>
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top text-right">
                +15ms
              </td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600 align-top">
                <code>SELECT * FROM context_cache...</code>
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top">
                <code>GET /api/context/:taskId</code>
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top text-right">
                +11ms
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[13px] text-zinc-400 leading-relaxed mb-6">
        Measured via internal benchmarks, 1000 requests each, p50 latency.
        Worker and API server co-located in the same VPC.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Workers carry two headers on every request:
      </p>

      <CodeBlock>{`// src/lib/api-client.ts
const apiClient = new Axios({
  baseURL: process.env.API_SERVER_URL,
  headers: {
    'Authorization': \`Bearer \${process.env.API_KEY}\`,
    'X-Agent-ID': process.env.AGENT_ID,
  },
});

// All state access goes through this client
export async function fetchTask(taskId: string): Promise<Task> {
  const { data } = await apiClient.get(\`/api/tasks/\${taskId}\`);
  return data;
}

export async function updateProgress(
  taskId: string,
  progress: ProgressUpdate
): Promise<void> {
  await apiClient.post(\`/api/tasks/\${taskId}/progress\`, progress);
}`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The 8&ndash;15ms overhead per call is noise compared to LLM inference
        time. A typical agent task involves 3&ndash;5 API calls and 2&ndash;4
        LLM inferences. The HTTP overhead is under 100ms; the LLM calls are
        2&ndash;30 seconds.
      </p>

      {/* Section: Counterintuitive Benefit */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Counterintuitive Benefit Nobody Warned Us About
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Debugging a multi-agent failure used to require checking N container
        logs plus N local databases, then reconciling N parallel timelines. Now
        it&rsquo;s: check the API database, replay the task ID.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Single source of truth makes every cross-agent investigation an order
        of magnitude faster. When three workers interact with a task,
        there&rsquo;s exactly one timeline in the API database&mdash;not three
        timelines that have to be merged with timestamps that may or may not
        be synchronized.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The mental model is simple: the API server is the computer. Workers
        are just CPUs that execute instructions. They don&rsquo;t have memory.
        They don&rsquo;t have state. They don&rsquo;t have opinions about what
        &ldquo;should&rdquo; be happening.
      </p>

      {/* Section: Ripple Effect */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Ripple Effect: What Statelessness Unlocked
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Once workers became stateless, three things became trivial:
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>Horizontal scaling became a non-event.</strong> Any container
        can handle any task because they&rsquo;re identical. No sticky
        sessions. No data migration. No &ldquo;warmup&rdquo; containers that
        have cached state. We scale by adding containers to a pool. The API
        server&rsquo;s task queue handles distribution.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>Workers became ephemeral.</strong> We run worker containers as
        Docker images that get killed and recreated constantly. A worker that
        crashes mid-task simply&hellip; stops. Its replacement pulls the same
        task from the queue and continues. No state to preserve. No
        &ldquo;graceful shutdown&rdquo; handler that might fail.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>API design became rigorous.</strong> When you can&rsquo;t take
        shortcuts through the database, every data access pattern needs a
        proper API endpoint. This forced us to design clean boundaries between
        concerns. The API server is now a well-documented service with
        explicit contracts. Workers are dumb clients that don&rsquo;t need to
        understand database schemas.
      </p>

      {/* Section: What didn't work */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What We Tried That Didn&rsquo;t Work
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Before settling on the bash script, we experimented with softer
        enforcement:
      </p>

      <ul className="space-y-2 text-[15px] text-zinc-600 leading-relaxed pl-6 list-disc mb-6">
        <li>
          <strong>Code review checklists:</strong> forgotten under deadline
          pressure. Reviewers don&rsquo;t catch violations in 400-line PRs.
        </li>
        <li>
          <strong>ESLint rules with custom plugins:</strong> bypassed with{" "}
          <code>// eslint-disable</code>. The escape hatch becomes the default
          during crunch.
        </li>
        <li>
          <strong>Runtime detection:</strong> checking imports at worker
          startup. This catches violations late&mdash;after deployment, when
          the build already passed.
        </li>
        <li>
          <strong>Architecture Decision Records:</strong> great for onboarding,
          useless for enforcement. Developers don&rsquo;t re-read ADRs before
          submitting PRs.
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The bash script won because it&rsquo;s the only option with zero escape
        hatches. You cannot bypass a grep. You cannot negotiate with a failing
        CI check at 2 AM when you need to ship a hotfix.
      </p>

      {/* Section: The Pattern */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Pattern: Apply This to Any Agent System
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        You don&rsquo;t need our exact stack to use this pattern. The general
        form is:
      </p>

      <ol className="space-y-2 text-[15px] text-zinc-600 leading-relaxed pl-6 list-decimal mb-6">
        <li>
          Identify your <strong>orchestrator</strong> (owns state) and{" "}
          <strong>workers</strong> (execute tasks)
        </li>
        <li>
          Define the boundary&mdash;which modules/paths workers may not access
        </li>
        <li>Write a dumb script that greps for violations</li>
        <li>Make it a merge gate in CI</li>
        <li>Replace direct state access with HTTP/queue messages</li>
      </ol>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The enforcement mechanism matters more than the specific technology.
        Discipline degrades under deadline pressure; bash scripts don&rsquo;t.
      </p>

      {/* Section: The Prediction */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Prediction: Where Agent Frameworks Are Heading
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Within 12 months, every mature agent framework will ship with a default
        &ldquo;workers must not access shared state directly&rdquo; invariant.
        The alternative is debugging race conditions that surface as
        &ldquo;flaky agent behavior&rdquo; weeks after deployment.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Teams running 10+ concurrent agents who give each worker database
        access are quietly racking up state divergence bugs. They manifest as:
      </p>

      <ul className="space-y-2 text-[15px] text-zinc-600 leading-relaxed pl-6 list-disc mb-6">
        <li>
          Agents that &ldquo;forget&rdquo; constraints mentioned in previous
          turns
        </li>
        <li>Tasks marked complete by one agent and pending by another</li>
        <li>Duplicate actions executed by different workers</li>
        <li>
          Intermittent failures that can&rsquo;t be reproduced with
          single-worker testing
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        These aren&rsquo;t flaky agents. They&rsquo;re distributed systems bugs
        wearing agent costumes. The fix isn&rsquo;t better prompting&mdash;it&rsquo;s
        architectural separation enforced with tooling.
      </p>

      {/* Section: When to add the rule */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        When Should You Add This Rule?
      </h2>

      <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
        <div className="text-[14px] text-amber-900 leading-relaxed">
          Not when you hit 10 workers. Not when you first see a race condition.
          Add it when you have two workers and are tempted to give them SQLite
          for &ldquo;fast memory.&rdquo; That temptation is the warning sign.
          The cost of fixing state divergence grows quadratically with worker
          count. Fix it at two workers, not twenty.
        </div>
      </div>

      {/* Section: What about caching embeddings */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What About &ldquo;Just Cache Embeddings Locally&rdquo;?
      </h2>

      <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
        <div className="text-[14px] text-amber-900 leading-relaxed">
          This is the most common resistance we hear. Embedding caches are the
          gateway drug to local state. Use Redis with a shared instance, or
          call an embedding API with caching at the API server level. The 50ms
          you save isn&rsquo;t worth the distributed systems headache
          you&rsquo;re creating. Cache invalidation across local SQLite
          instances is the problem you&rsquo;re avoiding by avoiding the cache
          entirely.
        </div>
      </div>

      {/* Section: The Keystone */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Script Is the Keystone
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Every architectural decision in our agent swarm traces back to that
        30-line bash script. Stateless workers. Ephemeral containers. Clean
        API boundaries. Horizontal scaling without config changes. Debugging
        via single timeline replay.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The script isn&rsquo;t clever. It&rsquo;s not even elegant. But
        it&rsquo;s the invariant that holds everything together, and it will
        outlast every engineer on the team. That&rsquo;s the point.
        Architectural boundaries enforced with tooling survive team turnover,
        late-night refactors, and &ldquo;just this once&rdquo; shortcuts.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Your agent swarm will face the same temptation. The question is
        whether you&rsquo;ll enforce the boundary before the incident, or
        after.
      </p>
    </BlogPostLayout>
  );
}
