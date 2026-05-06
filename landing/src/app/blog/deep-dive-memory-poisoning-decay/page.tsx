import type { Metadata } from "next";
import { BlogPostLayout } from "@/components/blog-post-layout";
import { Figure } from "@/components/figure";

export const metadata: Metadata = {
  title:
    "Memory Poisoning: Why Persistent Agent Memory Is a Time Bomb | Agent Swarm",
  description:
    "Persistent memory without decay, provenance, and quarantine is not a learning system. It is shared mutable global state dressed in vector embeddings.",
  keywords: [
    "agent-swarm",
    "AI agents",
    "agent memory",
    "memory poisoning",
    "vector embeddings",
    "vector search",
    "AI orchestration",
    "temporal decay",
  ],
  authors: [{ name: "Agent Swarm Team", url: "https://agent-swarm.dev" }],
  openGraph: {
    title: "Memory Poisoning: Why Persistent Agent Memory Is a Time Bomb",
    description:
      "Persistent memory without decay, provenance, and quarantine is not a learning system. It is shared mutable global state dressed in vector embeddings.",
    url: "https://agent-swarm.dev/blog/deep-dive-memory-poisoning-decay",
    siteName: "Agent Swarm",
    images: [
      {
        url: "https://agent-swarm.dev/images/deep-dive-memory-poisoning-decay.png",
        width: 1200,
        height: 630,
        alt: "Memory Poisoning in Agent Systems",
      },
    ],
    type: "article",
    publishedTime: "2026-05-06T00:00:00Z",
    section: "Agent Swarm",
  },
  twitter: {
    card: "summary_large_image",
    title: "Memory Poisoning: Why Persistent Agent Memory Is a Time Bomb",
    description:
      "Persistent memory without decay, provenance, and quarantine is not a learning system. It is shared mutable global state dressed in vector embeddings.",
    images: [
      "https://agent-swarm.dev/images/deep-dive-memory-poisoning-decay.png",
    ],
  },
  alternates: {
    canonical: "/blog/deep-dive-memory-poisoning-decay",
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
  headline: "Memory Poisoning: Why Persistent Agent Memory Is a Time Bomb",
  description:
    "Persistent memory without decay, provenance, and quarantine is not a learning system. It is shared mutable global state dressed in vector embeddings.",
  datePublished: "2026-05-06T00:00:00Z",
  dateModified: "2026-05-06T00:00:00Z",
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
    "@id": "https://agent-swarm.dev/blog/deep-dive-memory-poisoning-decay",
  },
  image:
    "https://agent-swarm.dev/images/deep-dive-memory-poisoning-decay.png",
};

export default function MemoryPoisoningDecayPost() {
  return (
    <BlogPostLayout
      date="May 6, 2026"
      readTime="13 min read"
      title={
        <>
          Memory Poisoning:{" "}
          <span className="gradient-text">
            Why Persistent Agent Memory Is a Time Bomb
          </span>
        </>
      }
      description="Persistent memory without decay, provenance, and quarantine is not a learning system. It is shared mutable global state dressed in vector embeddings, and at swarm scale it produces failures that hide in plain sight."
      tags={[
        "agent memory",
        "memory poisoning",
        "vector search",
        "AI orchestration",
        "temporal decay",
        "agent-swarm",
      ]}
      jsonLd={jsonLd}
    >
      {/* Hero Image */}
      <Figure
        src="/images/deep-dive-memory-poisoning-decay.png"
        alt="Cartoon dog sitting calmly in a burning room saying 'this is fine' — a metaphor for an agent confidently consulting poisoned memory"
        caption="Your agent retrieving a 23-day-old API endpoint at top-1 cosine similarity."
      />

      {/* Intro */}
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        It started with a Researcher agent documenting an external API endpoint.
        The endpoint worked perfectly when written to memory&mdash;a standard
        task completion note stored in our SQLite-backed vector store with a
        512-dim text-embedding-3-small vector. Twenty-three days later, the
        third-party provider deprecated the endpoint without warning.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Six different agents subsequently retrieved that memory over the course
        of a week. Each agent was working on unrelated tasks: one fetching
        market data, another updating a dashboard, another running a compliance
        check. But they all issued queries semantically related to that
        API&mdash;&ldquo;fetch user metrics,&rdquo; &ldquo;update
        analytics,&rdquo; &ldquo;pull quarterly data.&rdquo; And because the
        memory contained the exact endpoint description, it ranked top-1 in
        cosine similarity every time.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The failure modes were different for each agent. The dashboard agent
        threw a 404 and retried until timeout. The compliance agent got a 200
        with a different payload shape and silently parsed garbage. The market
        data agent hit a redirect loop. Because each failure looked
        task-specific, we spent days debugging network policies, retry logic,
        and prompt engineering before tracing the common factor: they had all
        consulted the same 23-day-old memory.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Compounding Cost
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Direct cost: 47 hours of engineering time, 1,200+ wasted API calls, and
        corrupted output in three client-facing reports. Meta-cost: we stopped
        trusting memory recall. For two weeks afterward, every agent log
        showing &ldquo;retrieved from long-term memory&rdquo; triggered a
        manual verification. The system had taught us to distrust it.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Why Semantic Search Amplifies Poisoning Instead of Mitigating It
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Here is the uncomfortable truth about vector embeddings: they encode{" "}
        <em>topic</em>, not <em>truth</em>. A memory describing a working
        endpoint and a memory describing a broken endpoint produce vectors with
        nearly identical cosine similarity to a query about that endpoint. The
        embedding model does not know the endpoint was deprecated. It only
        knows that both memories discuss the same HTTP methods and URL
        patterns.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Worse, most memory implementations&mdash;including ours
        initially&mdash;use access-count boosting as a relevance signal.
        Frequently accessed memories rank higher. This creates a positive
        feedback loop: once a poisoned memory is consulted once, it rises in
        rank, gets consulted more, and entrenches itself. We audited our
        swarm&rsquo;s behavior over 90 days and found the median age of top-3
        search results increased from 4 days to 41 days, while the share
        referencing deprecated tools grew from under 5% to roughly 17%.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        This is a slow-motion accuracy regression that no per-task metric
        catches. Individual tasks complete successfully&mdash;they just
        complete with increasing frequency of stale data. It is like rot in a
        wooden foundation: invisible until the floor collapses.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Infrastructure Gap You Probably Have
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We audited our{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          agent_memory
        </code>{" "}
        schema (SQLite + 512-dim vectors via{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          text-embedding-3-small
        </code>
        ) and found we had created{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          accessedAt
        </code>{" "}
        and{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          accessCount
        </code>{" "}
        columns in our migration (
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          migrations/001_initial.sql
        </code>
        ). We were updating them on every read. But our retrieval logic in{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          src/be/db.ts
        </code>{" "}
        was pure cosine similarity&mdash;brute force, unweighted, oblivious to
        the temporal metadata sitting right there in the same row.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        This pattern repeats across the ecosystem. Mem0, Letta, LangGraph&rsquo;s
        persistent memory layers, the various &ldquo;memory layer&rdquo;
        libraries on GitHub&mdash;they store recency and access metadata but
        default to semantic retrieval. The decay primitives are sitting unused
        like fire extinguishers in a house where nobody knows how to pull the
        pin.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Four Decay Primitives (And Why None Work Alone)
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We now treat four primitives as a non-negotiable unit. Shipping any one
        without the others creates a different failure mode.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        1. Time-Based Exponential Decay
      </h3>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Every memory has a half-life. At retrieval time, we calculate effective
        relevance as:
      </p>

      <CodeBlock>{`effective_score = cosine_sim × exp(-age / half_life) × quarantine_factor`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We tune half-lives per source: ~14 days for task completions
        (volatile), ~90 days for manual entries (curated), indefinite for file
        indices (stable unless the file changes). Without this, you keep
        retrieving six-month-old API documentation that &ldquo;feels&rdquo;
        relevant because it mentions the right nouns.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        2. Provenance Tagging
      </h3>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Every memory carries{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          sourceTaskId
        </code>
        ,{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          sourceAgent
        </code>
        , and{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          sourceType
        </code>
        . When a downstream task fails, we backward-trace: which memories did
        this agent consult, and which of those should be quarantined? Without
        provenance, you cannot attribute failure to memory. You are debugging
        blind.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        3. Failure-Driven Quarantine
      </h3>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        When a task fails after consulting a top-ranked memory, that
        memory&rsquo;s similarity weight drops 50% for 30 days. Two failures
        and it is hidden from search entirely, pending human review. This is
        your immune system. Without it, poisoned memories that
        &ldquo;look&rdquo; correct by embedding standards persist
        indefinitely.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        4. Embedding Outlier Detection
      </h3>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Memories whose embeddings drift far from their cluster
        centroid&mdash;detected via Mahalanobis distance on the 512-dim
        space&mdash;get flagged. These are likely hallucinated content, model
        drift artifacts, or topic-creep (a memory that started as API docs but
        the agent appended unrelated thoughts). We quarantine automatically if
        distance exceeds 3&sigma;.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Why the Unit Matters
      </h2>

      <ul className="list-disc pl-6 space-y-2 text-[15px] text-zinc-600 leading-relaxed mb-6">
        <li>Time-decay alone deletes good old knowledge that is still valid.</li>
        <li>Provenance alone does not help until something fails.</li>
        <li>Quarantine alone fires too late for the first victim.</li>
        <li>Outlier detection misses correct-looking-but-stale memories.</li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The combination is the architecture. Any subset is a liability.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What Persistent Memory Really Is
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Persistent agent memory has reinvented all the problems that
        programming languages spent fifty years solving. Shared mutable state?
        You have it&mdash;every agent reads and writes the same vector space.
        Unbounded retention? Check&mdash;memories accumulate until your
        database chokes. Entrenched bad actors? Absolutely&mdash;poisoned
        memories that rank high. Opaque provenance? By default, yes&mdash;you
        do not know which task wrote what.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The right mental model is not &ldquo;a database the agent reads.&rdquo;
        It is a <em>perishable inventory</em>. Every memory has a freshness
        date, a confidence score that decays, a chain of custody, and a return
        policy. Treat it like a grocery store, not a library. Librarians
        preserve; grocers rotate stock before it spoils.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Implementation: Schema and Scoring
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Here is the schema diff we wish we had shipped on day one. The columns
        below are the minimum viable decay infrastructure:
      </p>

      <CodeBlock>{`-- migrations/002_add_decay_columns.sql
ALTER TABLE agent_memory ADD COLUMN createdAt INTEGER NOT NULL DEFAULT (unixepoch());
ALTER TABLE agent_memory ADD COLUMN accessedAt INTEGER;
ALTER TABLE agent_memory ADD COLUMN accessCount INTEGER DEFAULT 0;
ALTER TABLE agent_memory ADD COLUMN sourceTaskId TEXT;
ALTER TABLE agent_memory ADD COLUMN quarantineUntil INTEGER; -- unixepoch, NULL = not quarantined
ALTER TABLE agent_memory ADD COLUMN failureCount INTEGER DEFAULT 0;
ALTER TABLE agent_memory ADD COLUMN halfLifeDays REAL DEFAULT 14.0; -- tunable per source

-- Index for fast decay calculations
CREATE INDEX idx_memory_temporal ON agent_memory(createdAt, quarantineUntil);`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        And the retrieval logic we now use in{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          src/be/db.ts
        </code>
        :
      </p>

      <CodeBlock>{`function calculateEffectiveScore(
  cosineSim: number,
  createdAt: number,
  halfLifeDays: number,
  failureCount: number,
  quarantineUntil: number | null
): number {
  const now = Date.now() / 1000;

  // Check quarantine
  if (quarantineUntil && now < quarantineUntil) return 0;
  if (failureCount >= 2) return 0; // Hard quarantine

  // Time decay
  const ageDays = (now - createdAt) / 86400;
  const decayFactor = Math.exp(-ageDays / halfLifeDays);

  // Failure penalty (soft quarantine)
  const failurePenalty = Math.pow(0.5, failureCount);

  return cosineSim * decayFactor * failurePenalty;
}

// In the retrieval query, we sort by effective_score, not raw cosine_sim`}</CodeBlock>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Audit Script You Should Run Today
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We wrote a diagnostic script that surfaces the &ldquo;most
        poisonous&rdquo; memories currently in your store&mdash;those that are
        old, frequently accessed, and likely to be wrong. Run this on any
        swarm using an{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          agent_memory
        </code>{" "}
        schema:
      </p>

      <CodeBlock>{`-- audit_poisoned_memories.sql
SELECT
  id,
  content_preview,
  createdAt,
  (unixepoch() - createdAt) / 86400 as age_days,
  accessCount,
  sourceType,
  failureCount,
  -- "Poison score": old, accessed often, never failed (so not yet quarantined)
  (accessCount * (unixepoch() - createdAt) / 86400) / (failureCount + 1) as poison_score
FROM agent_memory
WHERE quarantineUntil IS NULL
  AND failureCount < 2
  AND accessCount > 5
  AND (unixepoch() - createdAt) / 86400 > 30
ORDER BY poison_score DESC
LIMIT 10;`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        If the median age of your top-10 results here is over 60 days and they
        concern APIs, endpoints, or third-party services, you are sitting on a
        time bomb.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What Does Not Work (And Why)
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We tried simpler fixes before building the full decay system. They
        failed.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>Manual review queues:</strong> At swarm scale, agents generate
        hundreds of memories daily. Human review becomes a bottleneck, and
        reviewers miss stale technical details just as easily as agents do.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>Hard expiration dates:</strong> Deleting memories after 30 days
        loses valuable long-term context. Some knowledge&mdash;architectural
        decisions, stable business logic&mdash;should persist. Blanket
        expiration destroys signal with noise.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>Confidence thresholds in the LLM:</strong> Asking the agent
        &ldquo;are you sure this memory is accurate&rdquo; is useless. The
        agent has no ground truth. It will confidently confirm that the
        deprecated endpoint is correct because the memory says it worked last
        time.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Prediction
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The entire &ldquo;agentic memory&rdquo; thesis is currently broken at
        the foundation. The valuable lesson from running a 7-agent swarm for
        90+ days is not that persistent memory is amazing; it is that
        persistent memory is necessary <em>and</em> dangerous, and the
        dangerous part surfaces exactly when teams scale past the threshold
        where one human can manually review every memory write.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Within 12 months, we predict at least one well-funded &ldquo;agent
        memory layer&rdquo; startup will publicly post-mortem a customer
        cascade failure traced to memory poisoning. The industry will rapidly
        converge on decay+provenance+quarantine as table-stakes&mdash;the same
        way password hashing became mandatory after the early 2010s breaches.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Teams shipping persistent memory without these primitives in 2026 are
        doing the AI equivalent of storing passwords as MD5. It works, until it
        catastrophically does not.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What You Can Do Today
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Regardless of your stack:
      </p>

      <ul className="list-disc pl-6 space-y-2 text-[15px] text-zinc-600 leading-relaxed mb-6">
        <li>
          Audit your memory schema for unused recency/access columns and start
          scoring with them.
        </li>
        <li>
          Instrument the age distribution of your top-K results over time.
          Watch for the slow climb.
        </li>
        <li>
          Require provenance metadata at write time: which task, which agent,
          which source. Failure attribution is impossible without this.
        </li>
        <li>
          Wire your task-failure handler to backward-trace memory consultations
          and apply quarantine penalties.
        </li>
        <li>
          Set a per-source half-life and refuse to store memories with no decay
          policy. Volatile data must decay faster than stable knowledge.
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        If your agents have started behaving subtly worse over time without any
        obvious cause, or if you are about to ship persistent memory in your
        own framework, treat this as the foundation&mdash;not the polish. The
        unease you felt reading &ldquo;agents that learn&rdquo; marketing copy
        was correct. Now you know why.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">FAQ</h2>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        What is memory poisoning in AI agent systems?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Memory poisoning occurs when stale, incorrect, or deprecated
        information stored in an agent&rsquo;s long-term memory gets retrieved
        via semantic search and used in downstream tasks, causing cascading
        failures that are difficult to trace because the memory appears
        relevant by embedding similarity but is factually wrong or outdated.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        Why does semantic similarity fail to filter out bad memories?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Embeddings encode topical relevance, not truth or freshness. A
        wrong-but-relevant memory and a right-but-relevant memory have nearly
        identical cosine similarity scores. Without temporal decay or
        provenance tracking, semantic search has no mechanism to distinguish
        between current and stale information.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        What are the four decay primitives for safe agent memory?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Time-based exponential decay (reducing relevance scores as memories
        age), provenance tagging (tracking which task created each memory),
        failure-driven quarantine (penalizing memories consulted before task
        failures), and embedding outlier detection (flagging memories that
        drift from cluster centroids). Used together, they prevent memory
        poisoning.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        How do you implement memory decay in a vector database?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Store metadata columns for{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          createdAt
        </code>
        ,{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          accessedAt
        </code>
        ,{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          accessCount
        </code>
        , and{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          sourceTaskId
        </code>
        . At retrieval time, calculate effective relevance as cosine_similarity
        &times; exp(-age/half_life) &times; quarantine_multiplier. Tune
        half_lives per memory source&mdash;shorter for volatile API
        documentation, longer for stable architectural decisions.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        When should an agent memory be quarantined?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        When a task fails after consulting a memory that ranked in the top-K
        results, apply a 50% similarity penalty for 30 days. If a memory is
        associated with two distinct task failures, remove it from search
        entirely pending human review. This prevents entrenched poisoned
        memories from causing recurring failures.
      </p>
    </BlogPostLayout>
  );
}
