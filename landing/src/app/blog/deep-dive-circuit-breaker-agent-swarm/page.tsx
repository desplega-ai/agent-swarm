import type { Metadata } from "next";
import { BlogPostLayout } from "@/components/blog-post-layout";

export const metadata: Metadata = {
  title:
    "Why Your Agent Swarm Keeps Burning Through API Budgets (And the Circuit Breaker Pattern That Fixed Ours) | Agent Swarm",
  description:
    "We burned $2,400 in 45 minutes because our agents kept retrying failed API calls. Here is the distributed circuit breaker pattern that cut costs by 94%.",
  keywords: [
    "agent-swarm",
    "AI agents",
    "circuit breaker",
    "orchestration",
    "cost optimization",
    "distributed systems",
  ],
  authors: [{ name: "Agent Swarm Team", url: "https://agent-swarm.dev" }],
  openGraph: {
    title: "Why Your Agent Swarm Keeps Burning Through API Budgets",
    description:
      "We burned $2,400 in 45 minutes because our agents kept retrying failed API calls.",
    url: "https://agent-swarm.dev/blog/deep-dive-circuit-breaker-agent-swarm",
    siteName: "Agent Swarm",
    images: [
      {
        url: "https://agent-swarm.dev/images/deep-dive-circuit-breaker-agent-swarm.png",
        width: 1200,
        height: 630,
        alt: "Circuit breaker pattern for AI agent swarms",
      },
    ],
    type: "article",
    publishedTime: "2026-04-08T00:00:00Z",
    section: "Agent Swarm",
  },
  twitter: {
    card: "summary_large_image",
    title: "Why Your Agent Swarm Keeps Burning Through API Budgets",
    description:
      "We burned $2,400 in 45 minutes because our agents kept retrying failed API calls.",
    images: [
      "https://agent-swarm.dev/images/deep-dive-circuit-breaker-agent-swarm.png",
    ],
  },
  alternates: {
    canonical: "/blog/deep-dive-circuit-breaker-agent-swarm",
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
    "Why Your Agent Swarm Keeps Burning Through API Budgets (And the Circuit Breaker Pattern That Fixed Ours)",
  description:
    "We burned $2,400 in 45 minutes because our agents kept retrying failed API calls. Here is the distributed circuit breaker pattern that cut costs by 94%.",
  datePublished: "2026-04-08T00:00:00Z",
  dateModified: "2026-04-08T00:00:00Z",
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
      "https://agent-swarm.dev/blog/deep-dive-circuit-breaker-agent-swarm",
  },
  image:
    "https://agent-swarm.dev/images/deep-dive-circuit-breaker-agent-swarm.png",
};

export default function CircuitBreakerDeepDive() {
  return (
    <BlogPostLayout
      date="April 8, 2026"
      readTime="14 min read"
      title={
        <>
          Why Your Agent Swarm Keeps{" "}
          <span className="gradient-text">
            Burning Through API Budgets
          </span>
        </>
      }
      description="We burned $2,400 in 45 minutes because our agents kept retrying failed API calls. Here is the distributed circuit breaker pattern that cut our costs by 94%."
      tags={[
        "circuit breaker",
        "cost optimization",
        "distributed systems",
        "AI agents",
        "orchestration",
      ]}
      jsonLd={jsonLd}
    >
      {/* Hero Image */}
      <div className="mb-10 rounded-xl overflow-hidden border border-zinc-200">
        <img
          src="/images/deep-dive-circuit-breaker-agent-swarm.png"
          alt="Circuit breaker pattern for AI agent swarms"
          className="w-full"
        />
      </div>

      {/* Intro */}
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        At 3:47 AM on November 14th, our lead agent received task #4521:
        analyze 12,000 customer support tickets and generate a sentiment
        report by 9 AM. By 4:32 AM, we had burned through $2,400 in OpenAI
        API credits and the task was only 3% complete. The culprit was not a
        prompt injection attack or a runaway loop. It was far more
        embarrassing: every agent in our 40-node swarm encountered a 503
        error from our vector database, assumed it was transient, and retried
        with exponential backoff. Forty agents times twelve retries times
        $0.03 per embedding call. The math hurts.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        This is the dirty secret of production agent systems: your
        availability strategies are your cost strategies. And most teams
        optimize for the wrong one.
      </p>

      {/* Section: What Broke */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          What Exactly Broke
        </h2>

        <div className="my-6 rounded-xl bg-zinc-950 border border-zinc-800 px-5 py-4 overflow-x-auto">
          <code className="text-[13px] leading-relaxed text-zinc-300 font-mono whitespace-pre-line">
            03:47:12 Task #4521 queued &rarr; Lead Agent Alpha{"\n"}
            03:47:45 Alpha initiates 8 sub-agents for parallel processing{"\n"}
            03:48:02 Vector DB returns 503 (maintenance window overrun){"\n"}
            03:48:03 Agent_01 retry #1... Agent_02 retry #1... Agent_03 retry #1...{"\n"}
            03:48:45 All 8 agents escalate to Lead Agent Alpha (&quot;DB seems slow&quot;){"\n"}
            03:49:12 Alpha spawns 32 additional agents to &quot;work around the slowness&quot;{"\n"}
            04:32:00 $2,400 burned. DB still down. Zero vectors embedded.
          </code>
        </div>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          The horror was not that we retried. The horror was that we retried{" "}
          <em>intelligently</em>. Each agent used exponential backoff with
          jitter. Each agent respected rate limits individually. Each agent
          was, in isolation, behaving correctly. But swarm intelligence
          requires swarm awareness, and our agents were blind to each
          other&apos;s suffering.
        </p>
      </section>

      {/* Section: Why Per-Agent Retry Fails */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          Why Per-Agent Retry Logic Fails in Distributed Systems
        </h2>

        <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
          <div className="text-[14px] text-amber-900 leading-relaxed">
            Standard retry policies assume independence. In an agent swarm,
            dozens of processes hit the same endpoint within seconds &mdash;
            creating a thundering herd that amplifies the outage.
          </div>
        </div>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Standard retry policies assume independence. In a monolithic
          service, if you get a 503, you wait and try again. The probability
          that the service recovers during your backoff is reasonably high.
          But in an agent swarm, you have dozens or hundreds of independent
          processes hitting the same endpoint within seconds of each other.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          When our vector DB went down, all 40 agents entered their retry
          loops simultaneously. With exponential backoff (1s, 2s, 4s,
          8s...), they created a thundering herd that not only burned cash
          but actually prolonged the outage by hammering the DB as it tried
          to recover. We were DDoSing ourselves with retries.
        </p>

        <div className="my-8 overflow-x-auto">
          <table className="w-full text-left text-[14px]">
            <thead>
              <tr className="border-b border-zinc-200">
                <th className="pb-3 font-semibold text-zinc-900">Strategy</th>
                <th className="pb-3 font-semibold text-zinc-900">Requests/Min (Peak)</th>
                <th className="pb-3 font-semibold text-zinc-900">Cost/Hour</th>
                <th className="pb-3 font-semibold text-zinc-900">Success Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              <tr>
                <td className="py-3 text-zinc-600">Naive Retry (3 attempts)</td>
                <td className="py-3 text-zinc-600">1,240</td>
                <td className="py-3 text-zinc-600">$3,200</td>
                <td className="py-3 text-zinc-600">12%</td>
              </tr>
              <tr>
                <td className="py-3 text-zinc-600">Exponential Backoff</td>
                <td className="py-3 text-zinc-600">847</td>
                <td className="py-3 text-zinc-600">$2,400</td>
                <td className="py-3 text-zinc-600">8%</td>
              </tr>
              <tr>
                <td className="py-3 font-semibold text-zinc-900">Distributed Circuit Breaker</td>
                <td className="py-3 font-semibold text-zinc-900">45</td>
                <td className="py-3 font-semibold text-zinc-900">$180</td>
                <td className="py-3 font-semibold text-zinc-900">94%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Section: The Fix */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          The Fix: Distributed Circuit Breakers With Shared State
        </h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          We needed a way for agents to share failure context. When Agent_01
          decides the vector DB is unhealthy, Agent_02 through Agent_40 need
          to know immediately &mdash; not after wasting 6 retries each. This
          is the classic circuit breaker pattern, but adapted for
          distributed, stateless agents.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          The implementation has three states:{" "}
          <code className="bg-zinc-100 px-1.5 py-0.5 rounded text-zinc-800 text-[13px]">CLOSED</code>{" "}
          (normal operation),{" "}
          <code className="bg-zinc-100 px-1.5 py-0.5 rounded text-zinc-800 text-[13px]">OPEN</code>{" "}
          (failing fast), and{" "}
          <code className="bg-zinc-100 px-1.5 py-0.5 rounded text-zinc-800 text-[13px]">HALF_OPEN</code>{" "}
          (testing recovery). The critical difference from standard circuit
          breakers is that the state must be stored in a shared location
          accessible to all agents in the swarm.
        </p>
      </section>

      {/* Section: Shared State */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          How Do You Implement Shared State Without Adding Latency?
        </h2>

        <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
          <div className="text-[14px] text-amber-900 leading-relaxed">
            Redis with sub-millisecond latency and local caching. Check local
            state first, then shared state, update asynchronously.
          </div>
        </div>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          We use Redis with a 100ms TTL on local caches. Agents maintain an
          in-memory copy of circuit states, updated asynchronously via Redis
          pub/sub. When a breaker trips in Agent_01, it publishes to a
          channel. Agents_02-40 receive the update within 5-10ms without
          polling. The overhead is negligible compared to the 800ms+ latency
          of an unnecessary API retry.
        </p>
      </section>

      {/* Section: Production Implementation */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          Production Implementation: The CircuitBreaker Class
        </h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Here is the actual TypeScript implementation we use in production.
          It handles Redis failures gracefully &mdash; if the shared state is
          unavailable, agents fall back to local-only breakers, accepting the
          risk of duplicated retries over total system failure.
        </p>

        <CodeBlock>{`interface CircuitState {
  status: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  lastFailureTime: number;
  nextRetryTime: number;
}

class DistributedCircuitBreaker {
  private localState: Map<string, CircuitState> = new Map();
  private redis: Redis;
  private readonly THRESHOLD = 5;
  private readonly TIMEOUT = 30000; // 30s
  private readonly HALF_OPEN_TIMEOUT = 5000;

  async call<T>(
    serviceId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const state = await this.getState(serviceId);

    if (state.status === 'OPEN') {
      if (Date.now() < state.nextRetryTime) {
        throw new CircuitOpenError(
          \`Service \${serviceId} temporarily unavailable\`
        );
      }
      await this.setState(serviceId, {
        ...state,
        status: 'HALF_OPEN'
      });
    }

    try {
      const result = await operation();
      await this.onSuccess(serviceId);
      return result;
    } catch (error) {
      await this.onFailure(serviceId);
      throw error;
    }
  }

  private async onFailure(serviceId: string): Promise<void> {
    const current = await this.getState(serviceId);
    const failures = current.status === 'HALF_OPEN'
      ? this.THRESHOLD
      : current.failures + 1;

    if (failures >= this.THRESHOLD) {
      await this.setState(serviceId, {
        status: 'OPEN',
        failures,
        lastFailureTime: Date.now(),
        nextRetryTime: Date.now() + this.TIMEOUT
      });

      await this.redis.publish('circuit-events', JSON.stringify({
        serviceId,
        status: 'OPEN',
        timestamp: Date.now()
      }));
    } else {
      await this.setState(serviceId, {
        ...current,
        failures
      });
    }
  }

  private async getState(serviceId: string): Promise<CircuitState> {
    const local = this.localState.get(serviceId);
    if (local && Date.now() - local.lastFailureTime < 1000) {
      return local;
    }

    try {
      const remote = await this.redis.get(\`circuit:\${serviceId}\`);
      if (remote) {
        const parsed = JSON.parse(remote);
        this.localState.set(serviceId, parsed);
        return parsed;
      }
    } catch (e) {
      // Redis down - use local only
    }

    return this.localState.get(serviceId) || {
      status: 'CLOSED',
      failures: 0,
      lastFailureTime: 0,
      nextRetryTime: 0
    };
  }
}`}</CodeBlock>
      </section>

      {/* Section: Integration */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          Integration With the Agent Swarm Orchestrator
        </h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          The circuit breaker lives in the transport layer. When our
          ResearchAgent needs to query Pinecone, it does not call the
          Pinecone client directly. It calls the circuit-protected wrapper.
          This ensures that every external dependency &mdash; vector DBs, LLM
          APIs, search engines, whatever &mdash; is protected by the same
          consensus.
        </p>

        <CodeBlock>{`class ResearchAgent {
  private circuitBreaker: DistributedCircuitBreaker;
  private vectorDB: VectorDBClient;

  async embedAndStore(documents: string[]): Promise<void> {
    await this.circuitBreaker.call('pinecone-prod-us-east', async () => {
      const embeddings = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: documents
      });

      await this.vectorDB.upsert(embeddings.data);
    });
  }

  async queryKnowledgeBase(query: string): Promise<SearchResult[]> {
    return this.circuitBreaker.call('pinecone-prod-us-east', async () => {
      const vector = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: query
      });

      return this.vectorDB.query(vector.data[0].embedding);
    });
  }
}`}</CodeBlock>

        <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
          <div className="text-[14px] text-amber-900 leading-relaxed">
            <strong>Critical configuration detail:</strong> We scope circuit
            breakers by service ID (
            <code className="bg-amber-100 px-1 py-0.5 rounded text-amber-900 text-[13px]">
              pinecone-prod-us-east
            </code>
            ), not by agent instance. If Agent_01 trips the breaker for
            Pinecone, Agent_02 immediately knows not to try. This is the
            difference between local and distributed circuit breakers &mdash;
            most tutorials only show you the local version, which fails in
            multi-agent scenarios.
          </div>
        </div>
      </section>

      {/* Section: What Didn't Work */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          What We Tried That Absolutely Did Not Work
        </h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Before landing on distributed circuit breakers, we tried three
          approaches that failed in production. I am documenting these so you
          do not waste the three weeks we did.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          <strong className="text-zinc-900">Global rate limiting:</strong> We
          tried implementing a Redis-based rate limiter (X requests per
          minute). This prevented burning budget, but it masked the real
          problem. When the DB was slow but not down, agents would hit the
          rate limit, assume they were capped, and defer work unnecessarily.
          It created artificial scarcity. We went from &quot;too many
          requests&quot; to &quot;not enough requests&quot; and missed SLA
          windows.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          <strong className="text-zinc-900">Health check polling:</strong> We
          had a dedicated health check agent that would probe services every
          30 seconds and broadcast status. The problem was the thundering herd
          occurred within seconds of an outage, but the health check took 30
          seconds to detect it. By the time the broadcast went out, we had
          already burned hundreds of dollars. Reactive systems lose to fast
          failures.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          <strong className="text-zinc-900">Per-agent circuit breakers:</strong>{" "}
          This was the most insidious because it worked in staging with 3
          agents. In production with 40 agents, each agent would tolerate 5
          failures before opening. That meant we allowed 200 total failures
          before the swarm collectively stopped. At $0.03 per embedding call,
          that is $6 per outage per agent, times 40 agents, times multiple
          retry rounds. It muted the problem but did not solve it.
        </p>
      </section>

      {/* Section: Results */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          Results After 30 Days in Production
        </h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          We deployed the distributed circuit breaker on November 18th. Since
          then, we have had three partial outages of our vector database
          provider (two scheduled maintenance overruns, one actual
          degradation). Here is the data:
        </p>

        <ul className="mt-4 list-disc space-y-2 pl-6 text-[15px] text-zinc-600 leading-relaxed mb-6">
          <li>Total API calls during outages: 127 (down from 3,847)</li>
          <li>Average time to circuit open: 1.2 seconds</li>
          <li>Cost per incident: ~$3.81 (down from $2,400)</li>
          <li>
            Agent task completion rate during outages: 94% (agents gracefully
            degraded to cached data instead of failing)
          </li>
          <li>
            False positive rate (circuits opening during healthy periods):
            0.3%
          </li>
        </ul>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          The 0.3% false positive rate comes from network blips that trigger
          the 5-failure threshold faster than the HALF_OPEN recovery can
          detect health restoration. We accept this trade-off. The cost of
          0.3% of operations failing fast for 30 seconds is negligible
          compared to the cost of a genuine outage.
        </p>
      </section>

      {/* Section: When Not To Use */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          When Should You NOT Use This Pattern?
        </h2>

        <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
          <div className="text-[14px] text-amber-900 leading-relaxed">
            If you have fewer than 5 agents or idempotent, cheap operations.
            The complexity overhead isn&apos;t worth it for small swarms.
          </div>
        </div>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          If you are running a single agent, or a small swarm with cheap
          operations (sub-$0.001 per call), do not implement this. The Redis
          dependency and complexity overhead add failure modes. We only
          implemented distributed breakers after we crossed 20+ agents and
          started seeing $500+ monthly burn from retry storms. Before that,
          simple exponential backoff is fine.
        </p>
      </section>

      {/* Section: Deploy Monday */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          The Code to Deploy Monday Morning
        </h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          If you take one thing from this post, implement the CircuitBreaker
          class above. Wrap every external API call &mdash; OpenAI, Anthropic,
          your vector DB, your search index &mdash; in a shared circuit. Use
          Redis, S3 with TTLs, or even a PostgreSQL table if you have to. The
          storage backend matters less than the shared state itself.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Start with a simple threshold: 5 failures in 60 seconds opens the
          circuit for 30 seconds. Tune it based on your provider&apos;s SLA.
          For OpenAI, we use 10 failures (they are robust). For our
          self-hosted vector DB, we use 3 failures (it is fragile). The
          pattern is the same; the constants change.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Agent swarms are distributed systems. Stop treating them like
          monoliths with extra steps.
        </p>
      </section>
    </BlogPostLayout>
  );
}
