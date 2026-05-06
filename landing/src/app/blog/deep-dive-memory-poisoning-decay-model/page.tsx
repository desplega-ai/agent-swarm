import type { Metadata } from "next";
import { BlogPostLayout } from "@/components/blog-post-layout";

export const metadata: Metadata = {
  title:
    "The Decay Model: How We Defuse Memory Poisoning in an Agent Swarm | Agent Swarm",
  description:
    "Persistent memory without decay, provenance, and quarantine is shared mutable global state dressed in vector embeddings. The four primitives we treat as non-negotiable foundation.",
  keywords: [
    "agent-swarm",
    "AI agents",
    "agent memory",
    "memory poisoning",
    "memory decay",
    "vector embeddings",
    "semantic search",
    "database schema",
  ],
  authors: [{ name: "Agent Swarm Team", url: "https://agent-swarm.dev" }],
  openGraph: {
    title:
      "The Decay Model: How We Defuse Memory Poisoning in an Agent Swarm",
    description:
      "Four decay primitives that turn persistent agent memory from a liability into a learning system.",
    url: "https://agent-swarm.dev/blog/deep-dive-memory-poisoning-decay-model",
    siteName: "Agent Swarm",
    images: [
      {
        url: "https://agent-swarm.dev/images/deep-dive-memory-poisoning-decay-model.png",
        width: 1200,
        height: 630,
        alt: "Memory decay model for AI agent swarms",
      },
    ],
    type: "article",
    publishedTime: "2026-05-06T00:00:00Z",
    section: "Agent Swarm",
  },
  twitter: {
    card: "summary_large_image",
    title:
      "The Decay Model: How We Defuse Memory Poisoning in an Agent Swarm",
    description:
      "Four decay primitives that turn persistent agent memory from a liability into a learning system.",
    images: [
      "https://agent-swarm.dev/images/deep-dive-memory-poisoning-decay-model.png",
    ],
  },
  alternates: {
    canonical: "/blog/deep-dive-memory-poisoning-decay-model",
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
    "The Decay Model: How We Defuse Memory Poisoning in an Agent Swarm",
  description:
    "Four decay primitives that turn persistent agent memory from a liability into a learning system.",
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
    "@id":
      "https://agent-swarm.dev/blog/deep-dive-memory-poisoning-decay-model",
  },
  image:
    "https://agent-swarm.dev/images/deep-dive-memory-poisoning-decay-model.png",
};

export default function MemoryPoisoningDecayModelPost() {
  return (
    <BlogPostLayout
      date="May 6, 2026"
      readTime="14 min read"
      title={
        <>
          The Decay Model:{" "}
          <span className="gradient-text">
            How We Defuse Memory Poisoning in an Agent Swarm
          </span>
        </>
      }
      description="Persistent memory without decay, provenance, and quarantine is shared mutable global state dressed in vector embeddings. The four primitives we treat as non-negotiable foundation."
      tags={[
        "agent memory",
        "memory poisoning",
        "memory decay",
        "vector embeddings",
        "semantic search",
        "agent-swarm",
      ]}
      jsonLd={jsonLd}
    >
      {/* Hero Image */}
      <div className="mb-10 rounded-xl overflow-hidden border border-zinc-200">
        <img
          src="/images/deep-dive-memory-poisoning-decay-model.png"
          alt="Memory decay model for AI agent swarms"
          className="w-full"
        />
      </div>

      {/* Intro */}
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The incident started with a single memory entry. A Researcher agent
        had successfully documented an external API endpoint during a task
        &mdash; correct at the time, useful for the swarm. Twenty-three days
        later, that endpoint was deprecated. Six different agents, over the
        course of a week, retrieved that memory via semantic search. Each
        failed in a different way. And because each failure looked like an
        isolated task error, the root cause hid in plain sight while the poison
        spread.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        How Does a Single Stale Memory Break an Entire Agent Swarm?
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        It breaks it silently. The first agent tried to call the deprecated
        endpoint, got a 404, and reported a &ldquo;connectivity issue.&rdquo;
        The second agent, working on a different task days later, retrieved the
        same memory and interpreted the error as &ldquo;temporary service
        outage,&rdquo; retrying three times before giving up. The third agent
        hallucinated a workaround based on the stale context. By the time we
        traced the pattern, the memory had been accessed eleven times across
        seven distinct tasks, each failure seemingly unrelated.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        This is memory poisoning: when persistent agent memory becomes toxic
        but remains semantically retrievable. Your vector database is not a
        knowledge base. It is a perishable inventory with no expiration dates,
        and you are treating it like a library.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Why Semantic Search Amplifies Instead of Mitigates
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We audited our own swarm after the incident and found a pattern that
        should terrify anyone using naive semantic retrieval. Over 90 days of
        operation, the median age of top-3 search results increased from 4
        days to 41 days. Worse, the share of results referencing deprecated
        tools, endpoints, or commands grew from under 5% to roughly 17%. This
        was not a sudden breakage &mdash; it was a slow-motion accuracy
        regression that no per-task metric caught.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The problem is fundamental. A vector embedding encodes topic and
        semantic similarity, not truth or freshness. A memory stating
        &ldquo;use API v1&rdquo; and one stating &ldquo;use API v2&rdquo;
        produce nearly identical embeddings if they discuss the same domain.
        Cosine similarity has no concept of staleness. And most memory
        frameworks compound this error with access-count boosting &mdash;
        memories that have been consulted frequently get ranked higher,
        creating a positive feedback loop where poisoned memories entrench
        themselves the more they mislead.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The cycle: a stale memory ranks high on semantic similarity (correct
        topic). An agent consults it, increasing accessCount. Access-count
        boosting raises its rank for future queries. More agents consult it,
        reinforcing the cycle. Task failures look unrelated because they
        occur in different contexts. The memory remains unquarantined because
        no single failure traces back clearly.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Infrastructure Gap Hiding in Your Schema
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        When we audited our{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          agent_memory
        </code>{" "}
        table &mdash; SQLite with 512-dim{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          text-embedding-3-small
        </code>{" "}
        and brute-force cosine similarity &mdash; we discovered an
        embarrassing gap. We had created{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          accessedAt
        </code>{" "}
        and{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          accessCount
        </code>{" "}
        columns. We tracked them diligently. But our retrieval query used pure
        cosine similarity, completely ignoring the decay primitives sitting
        unused in our own schema.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Mem0, Letta, LangGraph&rsquo;s memory layer, the various &ldquo;memory
        layer&rdquo; libraries on GitHub &mdash; they all have this shape.
        They store recency and access metadata but default to semantic-only
        retrieval. It is like installing a smoke detector but never connecting
        the battery.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Four Decay Primitives (Why None Work Alone)
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We now treat four primitives as non-negotiable foundation, not
        optional polish. None of them works alone; the combination is the
        architecture.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        1. Time-Based Exponential Decay
      </h3>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Every memory gets an effective relevance score calculated as{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          cosine_sim &times; exp(-age / half_life)
        </code>
        . One-size-fits-all half-lives do not work. We tune by source: ~14
        days for auto-generated task completions (these go stale fast), ~90
        days for manual entries (human-validated knowledge lasts longer), and
        indefinite for file indexes (code structure changes slowly).
      </p>

      <CodeBlock>{`// src/lib/memory/scoring.ts
type SourceType = 'task_completion' | 'manual' | 'file_index';

const SOURCE_HALF_LIVES: Record<SourceType, number> = {
  task_completion: 14,
  manual: 90,
  file_index: Infinity, // No decay for structural indices
};

export function calculateEffectiveRelevance(
  cosineSim: number,
  memoryAgeMs: number,
  sourceType: SourceType,
  quarantineMultiplier = 1.0,
): number {
  const halfLife = SOURCE_HALF_LIVES[sourceType];
  if (halfLife === Infinity) {
    return cosineSim * quarantineMultiplier;
  }
  const ageDays = memoryAgeMs / (1000 * 60 * 60 * 24);
  const decayFactor = Math.exp(-ageDays / halfLife);
  return cosineSim * decayFactor * quarantineMultiplier;
}`}</CodeBlock>

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
        . When a downstream task fails, we blame-attribute backwards: which
        memories did the failed agent consult, and which of those should be
        quarantined? Without this chain of custody, you are debugging in the
        dark.
      </p>

      <CodeBlock>{`-- migrations/002_add_provenance.sql
ALTER TABLE agent_memory ADD COLUMN source_task_id TEXT;
ALTER TABLE agent_memory ADD COLUMN source_agent TEXT NOT NULL;
ALTER TABLE agent_memory ADD COLUMN source_type TEXT NOT NULL
  CHECK (source_type IN ('task_completion', 'manual', 'file_index'));
ALTER TABLE agent_memory ADD COLUMN failure_count INTEGER DEFAULT 0;
ALTER TABLE agent_memory ADD COLUMN quarantine_until TIMESTAMP;

CREATE INDEX idx_memory_provenance
  ON agent_memory(source_task_id, source_agent);`}</CodeBlock>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        3. Failure-Driven Quarantine
      </h3>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        When a task fails after consulting a high-rank memory, that
        memory&rsquo;s similarity weight drops by 50% for a 30-day cooldown
        period. Two failures and it is hidden from search entirely pending
        human review. This creates negative feedback where toxic memories get
        isolated rather than reinforced.
      </p>

      <CodeBlock>{`// src/lib/memory/quarantine.ts
const DAY_MS = 24 * 60 * 60 * 1000;

export async function handleTaskFailure(
  taskId: string,
  consultedMemoryIds: string[],
): Promise<void> {
  for (const memoryId of consultedMemoryIds) {
    const memory = await db.getMemory(memoryId);
    if (!memory) continue;

    const newFailureCount = (memory.failure_count || 0) + 1;
    const cooldownDays = newFailureCount >= 2 ? 365 : 30;

    await db.updateMemory(memoryId, {
      quarantine_until: new Date(Date.now() + cooldownDays * DAY_MS),
      failure_count: newFailureCount,
    });
  }
}`}</CodeBlock>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        4. Embedding-Similarity Outlier Flagging
      </h3>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Memories whose embeddings drift far from their cluster centroid get
        flagged for manual review. This catches model drift, hallucinated
        content, or topic creep before they have a chance to mislead. We
        calculate centroid distance during the insertion batch and flag
        anything beyond 2.5 standard deviations.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Persistent Memory Has Reinvented Programming Language Problems
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The mental model shift that took us too long to internalize:
        persistent agent memory has reinvented all the problems that
        programming languages spent 50 years solving. Shared mutable state
        (need scoping). Unbounded retention (need garbage collection).
        Entrenched bad actors (need quarantine/sandbox). Opaque provenance
        (need version control).
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The right mental model is not &ldquo;a database the agent
        reads&rdquo; &mdash; it is a perishable inventory. Every memory has a
        freshness date, a confidence score that decays, a chain of custody,
        and a return policy. Treat it like a grocery store, not a library.
        You do not keep milk on the shelf because it was good when it
        arrived.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What Does Not Work (And Why)
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We tried naive solutions first. Simple time-based deletion
        (&ldquo;delete memories older than X days&rdquo;) destroys good
        knowledge &mdash; documentation, architectural decisions, stable API
        contracts. Pure failure tracking without provenance cannot attribute
        blame when multiple memories were consulted. Manual review does not
        scale past the threshold where one human can review every memory
        write, which happens faster than you think in a 7-agent swarm running
        24/7.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The worst approach is access-count boosting without decay. This
        actively accelerates poisoning by giving stale-but-popular memories
        permanent priority. It is the equivalent of optimizing for cache hits
        while ignoring cache invalidation.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Audit Script You Should Run Today
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        If you are running persistent memory, run this audit now. It surfaces
        the &ldquo;most poisonous memories&rdquo; in your store &mdash; old,
        frequently accessed, and associated with task failures or deprecated
        contexts.
      </p>

      <CodeBlock>{`// scripts/audit-memory-poisoning.ts
import { db } from '../src/be/db';

async function auditPoisonedMemories() {
  const dangerous = await db.query(\`
    SELECT
      id,
      content_preview,
      created_at,
      accessed_at,
      access_count,
      failure_count,
      source_type,
      julianday('now') - julianday(created_at) AS age_days
    FROM agent_memory
    WHERE
      julianday('now') - julianday(created_at) > 30
      AND access_count > 5
      AND (failure_count > 0 OR content_preview LIKE '%deprecated%')
    ORDER BY
      access_count * 1.0 / NULLIF(julianday('now') - julianday(accessed_at), 0) DESC,
      failure_count DESC
    LIMIT 10
  \`);

  console.table(dangerous);
}

auditPoisonedMemories();`}</CodeBlock>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Implementation Checklist
      </h2>

      <ul className="list-disc pl-6 text-[15px] text-zinc-600 leading-relaxed mb-6 space-y-2">
        <li>
          Add{" "}
          <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
            accessedAt
          </code>
          ,{" "}
          <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
            accessCount
          </code>
          ,{" "}
          <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
            failureCount
          </code>
          ,{" "}
          <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
            quarantineUntil
          </code>{" "}
          columns.
        </li>
        <li>Replace pure cosine similarity with decay-weighted scoring.</li>
        <li>
          Require{" "}
          <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
            sourceTaskId
          </code>{" "}
          and{" "}
          <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
            sourceType
          </code>{" "}
          on every memory write.
        </li>
        <li>
          Implement failure-driven quarantine in your task orchestrator.
        </li>
        <li>
          Set per-source half-lives (~14 d auto, ~90 d manual, indefinite for
          structural).
        </li>
        <li>Add outlier detection for embedding drift.</li>
        <li>Run the audit script weekly in CI.</li>
      </ul>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Uncomfortable Prediction
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The entire &ldquo;agentic memory&rdquo; thesis is currently broken at
        the foundation. The valuable lesson from running a multi-agent swarm
        is not that persistent memory is amazing &mdash; it is that
        persistent memory is necessary <em>and</em> dangerous. The dangerous
        part surfaces exactly when you scale past the threshold where one
        human can manually review every memory write.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Within 12 months, we will see memory-framework casualties. At least
        one well-funded &ldquo;agent memory layer&rdquo; startup will publicly
        post-mortem a customer cascade failure traced to memory poisoning. The
        industry will rapidly converge on decay+provenance+quarantine as
        table-stakes, the same way password hashing became table-stakes after
        the early 2010s breaches.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The teams shipping persistent memory without these primitives in 2026
        are doing the AI equivalent of storing passwords as MD5. They will
        work fine in demos. They will break catastrophically in production.
        And when they break, they will break silently, with the poison
        spreading through semantic similarity while the metrics look fine.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        If you have read &ldquo;agents that learn&rdquo; marketing copy and
        felt a vague unease you could not articulate, that unease is correct.
        Persistent memory without decay is not learning. It is accumulation.
        And accumulation without garbage collection is just slow poisoning.
      </p>
    </BlogPostLayout>
  );
}
