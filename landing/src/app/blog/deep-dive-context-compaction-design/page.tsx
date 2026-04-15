import type { Metadata } from "next";
import { BlogPostLayout } from "@/components/blog-post-layout";

export const metadata: Metadata = {
  title:
    "Stop Fighting Context Window Limits — Design for Compaction Instead | Agent Swarm",
  description:
    "Why chasing infinite context windows is wrong. Our agents perform better with intentional compaction. Here's the architecture that makes it work.",
  keywords: [
    "agent-swarm",
    "AI agents",
    "context windows",
    "context compaction",
    "agent architecture",
    "orchestration",
    "long-running agents",
  ],
  authors: [{ name: "Agent Swarm Team", url: "https://agent-swarm.dev" }],
  openGraph: {
    title:
      "Stop Fighting Context Window Limits — Design for Compaction Instead",
    description:
      "Why chasing infinite context windows is wrong. Our agents perform better with intentional compaction.",
    url: "https://agent-swarm.dev/blog/deep-dive-context-compaction-design",
    siteName: "Agent Swarm",
    images: [
      {
        url: "https://agent-swarm.dev/images/context-compaction-agent-design.png",
        width: 1200,
        height: 630,
        alt: "Context compaction architecture diagram showing PreCompact hook injection",
      },
    ],
    type: "article",
    publishedTime: "2025-01-21T00:00:00Z",
    section: "Agent Swarm",
  },
  twitter: {
    card: "summary_large_image",
    title:
      "Stop Fighting Context Window Limits — Design for Compaction Instead",
    description:
      "Why chasing infinite context windows is wrong. Our agents perform better with intentional compaction.",
    images: [
      "https://agent-swarm.dev/images/context-compaction-agent-design.png",
    ],
  },
  alternates: {
    canonical: "/blog/deep-dive-context-compaction-design",
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
    "Stop Fighting Context Window Limits — Design for Compaction Instead",
  description:
    "Why chasing infinite context windows is wrong. Our agents perform better with intentional compaction. Here's the architecture that makes it work.",
  datePublished: "2025-01-21T00:00:00Z",
  dateModified: "2025-01-21T00:00:00Z",
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
      "https://agent-swarm.dev/blog/deep-dive-context-compaction-design",
  },
  image:
    "https://agent-swarm.dev/images/context-compaction-agent-design.png",
};

export default function ContextCompactionDesignPost() {
  return (
    <BlogPostLayout
      date="January 21, 2025"
      readTime="12 min read"
      title={
        <>
          Stop Fighting Context Window Limits —{" "}
          <span className="gradient-text">
            Design for Compaction Instead
          </span>
        </>
      }
      description="Our agents started performing better after we stopped trying to avoid compaction and started treating it as a feature."
      tags={[
        "context compaction",
        "context windows",
        "agent architecture",
        "PreCompact hook",
        "long-running agents",
        "AI agents",
      ]}
      jsonLd={jsonLd}
    >
      {/* Hero Image */}
      <div className="mb-10 rounded-xl overflow-hidden border border-zinc-200">
        <img
          src="/images/context-compaction-agent-design.png"
          alt="Context compaction architecture diagram showing PreCompact hook injection"
          className="w-full"
        />
      </div>

      {/* Intro */}
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Six months ago, our agents were drowning. Not in errors&mdash;in context. We were running
        web automation tasks that could last 45 minutes, execute 3,000+ tool calls, and accumulate
        conversation histories that would make a novelist weep. The obvious answer was bigger
        context windows. So we paid for 200K tokens. Then our completion rates <em>dropped</em>.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        This is the story of why that happened, and how we built a system that treats context
        compaction as a first-class primitive instead of a failure mode to avoid.
      </p>

      {/* The Counterintuitive Discovery */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Counterintuitive Discovery
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Here&rsquo;s the pattern that broke our assumptions. We had an agent tasked with competitive
        analysis: scrape pricing from 150 competitor websites, normalize the data, and generate
        a comparison report. With our previous architecture, we tried desperately to keep the
        full conversation history intact. Summaries, hierarchical memory, selective eviction&mdash;we
        tried it all. The agent would still drift. Around minute 30, it would start asking
        clarifying questions we&rsquo;d answered in minute 2. By minute 40, it would regenerate
        the full progress report from scratch, unaware we&rsquo;d already built one.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The fix came from a place of resignation. We couldn&rsquo;t prevent compaction, so we decided
        to make it happen <em>well</em>. We built a{" "}
        <code className="bg-zinc-100 px-1.5 py-0.5 rounded text-[13px] text-zinc-800">PreCompact</code>{" "}
        hook that fires immediately before the context window truncates. Here&rsquo;s what it actually does:
      </p>

      <CodeBlock>{`// From src/core/hooks/lifecycle.ts
export interface CompactionContext {
  taskId: string;
  originalGoal: string;
  currentProgress: ProgressSnapshot;
  toolCallCount: number;
  compactCount: number;  // How many times we've compacted
}

export async function executePreCompact(
  agent: AgentInstance,
  ctx: CompactionContext
): Promise<InjectedMessage[]> {
  // This runs synchronously before truncation
  const reminder = await buildGoalReminder(ctx);

  return [
    {
      role: 'system',
      content: \`=== CONTEXT SYNCHRONIZATION ===
Original task (\${ctx.compactCount + 1} compaction cycles elapsed):
\${ctx.originalGoal}

Current progress (verified from persistent store):
- Completed: \${ctx.currentProgress.completedSteps.join(', ')}
- Current focus: \${ctx.currentProgress.currentStep}
- Remaining: \${ctx.currentProgress.remainingSteps}
- Data collected: \${ctx.currentProgress.keyFindings.length} items

=== END SYNCHRONIZATION ===\`,
      metadata: { type: 'precompact_sync', compactIndex: ctx.compactCount }
    }
  ];
}

// The injection happens atomically with compaction
export class ContextManager {
  async compactIfNeeded(agentId: string): Promise<CompactionResult> {
    const currentTokens = await this.getTokenCount(agentId);
    const threshold = this.config.compactionThreshold; // typically 85% of max

    if (currentTokens < threshold) return { compacted: false };

    // CRITICAL: Fetch state BEFORE truncation
    const taskState = await this.fetchCurrentTaskState(agentId);
    const preCompactMessages = await executePreCompact(agentId, taskState);

    // Inject, then truncate everything before our sync message
    await this.injectMessages(agentId, preCompactMessages);
    const newHistory = await this.truncatePreservingTail(
      agentId, preCompactMessages.length
    );

    return {
      compacted: true,
      preCompactTokens: currentTokens,
      postCompactTokens: await this.getTokenCount(agentId),
      syncMessageCount: preCompactMessages.length
    };
  }
}`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The results were immediate and confusing. Tasks that previously failed at 67% completion
        (our old metric) suddenly started finishing. But here&rsquo;s what was strange: the agents weren&rsquo;t
        just surviving compaction. They were <em>snapping back to coherence</em>&mdash;like someone shaking
        you awake when you&rsquo;ve been staring blankly at a screen for too long.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We realized we&rsquo;d accidentally built a synchronization checkpoint. Every compaction event
        became a forced re-read of the original goal and current progress. The agent couldn&rsquo;t drift
        for more than ~15 minutes (our compaction interval at current token rates) without getting
        yanked back to first principles.
      </p>

      {/* Why Bigger Context Windows Made Everything Worse */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Why Bigger Context Windows Made Everything Worse
      </h2>

      <blockquote className="my-6 border-l-4 border-amber-500 pl-4 italic text-zinc-500">
        &ldquo;Context fatigue is real. With 200K tokens of accumulated conversation, our agents
        started behaving like someone trying to work while carrying a backpack full of every
        conversation they&rsquo;d ever had.&rdquo;
      </blockquote>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        When we upgraded to 200K token windows, we expected linear improvement. Instead we got
        three pathologies that only manifested at scale:
      </p>

      <ul className="list-disc pl-6 space-y-2 text-[15px] text-zinc-600 leading-relaxed mb-6">
        <li>
          <strong className="text-zinc-800">Stale reference poisoning:</strong> The agent would cite tool outputs from
          call #47 in the context of call #2,400. The information was technically in the window,
          but it was 43 minutes and 2,353 tool calls stale. The agent couldn&rsquo;t distinguish recent
          from ancient.
        </li>
        <li>
          <strong className="text-zinc-800">Work repetition:</strong> Without compaction forcing a progress review,
          agents would re-derive solutions they&rsquo;d already found. We saw pricing analysis agents
          regenerate comparison matrices three times in a single session, each time convinced
          they were doing it for the first time.
        </li>
        <li>
          <strong className="text-zinc-800">Objective dissolution:</strong> The original goal&mdash;literally the first
          system message&mdash;would get buried under 800 lines of tool output. The agent would
          start improvising sub-tasks that felt related but didn&rsquo;t serve the actual objective.
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The paradox: giving the agent more memory made it forget <em>what mattered</em>.
        Compaction, by brutally truncating everything except our injected synchronization
        message, forced the agent to carry only what was essential.
      </p>

      {/* What Doesn't Work: Summary-Based Memory */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What Doesn&rsquo;t Work: Summary-Based Memory
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Before arriving at the PreCompact hook, we tried the obvious approach: incremental
        summarization. Every N tokens, summarize the conversation so far and replace the raw
        history with the summary. It sounds elegant. It was disastrous.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The problem is lossiness without intent. A summary of 10,000 tokens of tool output
        necessarily discards information. But which information? The summarizer (usually the
        same LLM) doesn&rsquo;t know what will be relevant downstream. We saw agents lose track of
        specific error codes because the summary deemed them &ldquo;implementation details.&rdquo; We
        saw agents repeat failed approaches because the summary said &ldquo;attempted X&rdquo; but not
        &ldquo;attempted X and it failed with error Y.&rdquo;
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Summary-based memory is compression without a format. The PreCompact approach is
        different: it&rsquo;s lossy by design, but the <em>structure</em> of what survives is
        guaranteed. Original goal: preserved. Current progress: preserved. Key findings:
        preserved. Everything else? If it&rsquo;s important, it should be in external state, not
        floating in context history.
      </p>

      {/* The Compaction-Aware Architecture */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Compaction-Aware Architecture
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Three patterns from our production system that make this reliable:
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        Pattern 1: Goal Injection Structure
      </h3>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The PreCompact hook fetches from two sources: the task definition (immutable) and
        the progress store (mutable). This distinction matters. The original goal never
        changes. Current progress updates frequently through explicit{" "}
        <code className="bg-zinc-100 px-1.5 py-0.5 rounded text-[13px] text-zinc-800">storeProgress</code>{" "}
        tool calls:
      </p>

      <CodeBlock>{`// From src/tools/progress.ts
export const storeProgress = defineTool({
  name: 'storeProgress',
  description: 'Atomically persist progress to survive compaction',
  parameters: z.object({
    completedSteps: z.array(z.string()),
    currentStep: z.string(),
    remainingSteps: z.array(z.string()),
    keyFindings: z.array(z.object({
      key: z.string(),
      value: z.string(),
      source: z.string() // Which tool call produced this
    })),
    checkpointId: z.string().optional()
  }),
  handler: async (params, ctx) => {
    await ctx.db.taskProgress.upsert({
      where: { taskId: ctx.taskId },
      update: {
        ...params,
        updatedAt: new Date(),
        compactCount: ctx.currentCompactCount
      },
      create: {
        taskId: ctx.taskId,
        ...params,
        compactCount: 0
      }
    });
    return { stored: true, checkpointId: params.checkpointId };
  }
});`}</CodeBlock>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        Pattern 2: Context Snapshots
      </h3>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We track every compaction event in a dedicated table. This isn&rsquo;t for debugging&mdash;it&rsquo;s
        for the task scheduler to make routing decisions:
      </p>

      <CodeBlock>{`-- From prisma/schema.prisma
model TaskContextSnapshot {
  id            String   @id @default(cuid())
  taskId        String

  // Compaction metrics
  compactCount  Int      // How many times this task has compacted
  preCompactTokens  Int    // Tokens before this compaction
  postCompactTokens Int    // Tokens after (should be ~20% of max)
  peakContextPercent Float // Highest % of context used during this cycle

  // Recovery data
  syncMessageLength Int   // Characters in our injected sync
  progressCheckpoints Json // Array of checkpointIds from storeProgress

  // Timing
  compactedAt   DateTime @default(now())

  @@index([taskId, compactCount])
  @@index([peakContextPercent]) // For identifying undertasked agents
}

// Usage: tasks with compactCount=0 and peakContextPercent<30%
// are flagged as "undertasked"—they could do more work per cycle`}</CodeBlock>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        Pattern 3: Unthrottled Compaction Logging
      </h3>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Regular context readings are throttled (we poll every 5 seconds during busy periods).
        But compaction events are logged synchronously, unthrottled, with full pre/post state.
        You cannot afford to miss a compaction&mdash;it means your external state and context state
        have desynchronized.
      </p>

      <CodeBlock>{`// From src/core/logging/telemetry.ts
export async function logCompactionEvent(
  agentId: string,
  result: CompactionResult
): Promise<void> {
  // NEVER throttle this. Use synchronous write path.
  const event: CompactionTelemetry = {
    type: 'compaction',
    agentId,
    timestamp: Date.now(),
    preCompactTokens: result.preCompactTokens,
    postCompactTokens: result.postCompactTokens,
    tokenReduction: result.preCompactTokens - result.postCompactTokens,
    syncMessage: result.injectedMessages
  };

  // Direct write to telemetry, bypasses normal batching
  await telemetry.writeImmediate(event);

  // Also update the task-level aggregate
  await updateTaskCompactionMetrics(agentId, event);
}`}</CodeBlock>

      {/* What The Data Actually Shows */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What The Data Actually Shows
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We categorize task outcomes by compaction behavior. Here&rsquo;s what we found running
        ~12,000 tasks over three weeks:
      </p>

      <div className="my-6 rounded-xl border border-zinc-200 overflow-hidden">
        <table className="w-full text-[14px]">
          <thead className="bg-zinc-50">
            <tr>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">Compaction Profile</th>
              <th className="py-3 px-4 text-right font-semibold text-zinc-700">Task Count</th>
              <th className="py-3 px-4 text-right font-semibold text-zinc-700">Completion Rate</th>
              <th className="py-3 px-4 text-right font-semibold text-zinc-700">Avg Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            <tr>
              <td className="py-3 px-4 text-zinc-600">Zero compactions</td>
              <td className="py-3 px-4 text-right text-zinc-600">2,847</td>
              <td className="py-3 px-4 text-right text-zinc-600">61%</td>
              <td className="py-3 px-4 text-right text-zinc-600">8.3 min</td>
            </tr>
            <tr className="bg-amber-50/50">
              <td className="py-3 px-4 font-semibold text-amber-800">1-2 compactions</td>
              <td className="py-3 px-4 text-right font-semibold text-amber-800">4,193</td>
              <td className="py-3 px-4 text-right font-semibold text-amber-800">84%</td>
              <td className="py-3 px-4 text-right text-amber-800">23.7 min</td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600">3-4 compactions</td>
              <td className="py-3 px-4 text-right text-zinc-600">3,956</td>
              <td className="py-3 px-4 text-right text-zinc-600">79%</td>
              <td className="py-3 px-4 text-right text-zinc-600">41.2 min</td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-red-600">5+ compactions</td>
              <td className="py-3 px-4 text-right text-red-600">1,004</td>
              <td className="py-3 px-4 text-right text-red-600">54%</td>
              <td className="py-3 px-4 text-right text-red-600">67.8 min</td>
            </tr>
          </tbody>
        </table>
        <p className="px-4 py-2 text-[12px] text-zinc-400 bg-zinc-50 border-t border-zinc-100">
          Completion = task finished with validateable output. Does not include tasks killed
          by timeout or circuit breaker.
        </p>
      </div>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The sweet spot is obvious: 1-2 compactions. These are tasks large enough to need
        meaningful work, but bounded enough to maintain coherence. Zero-compaction tasks
        often fail because they&rsquo;re actually too small&mdash;agents get undertasked and start
        inventing scope. Five-plus compaction tasks fail because the complexity exceeds
        what can be tracked across that many synchronization points.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        This data changed how we design tasks. Instead of asking &ldquo;can this fit in context?&rdquo;
        we ask &ldquo;will this complete in 2-3 compaction cycles?&rdquo; If the answer is no, we
        decompose. The context window becomes a design constraint, not a resource to maximize.
      </p>

      {/* How do I structure prompts for compaction? */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        How Do I Structure Prompts for Compaction?
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Keep your store-progress calls frequent. They survive compaction as API-side state.
        Use structured output schemas so downstream consumers don&rsquo;t depend on
        context-window-resident information. Design tasks to be completable in 2-3
        compaction cycles.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Specifically: your agent should call{" "}
        <code className="bg-zinc-100 px-1.5 py-0.5 rounded text-[13px] text-zinc-800">storeProgress</code>{" "}
        after every significant state change&mdash;not just at the end. We recommend at minimum:
        after each major tool category (data collection &rarr; analysis &rarr; synthesis), after any
        error recovery, and before any operation that might trigger multiple tool calls.
      </p>

      <CodeBlock>{`// Anti-pattern: Storing everything at the end
async function badApproach(): Promise<Result> {
  const data = await collectData();      // 500 tool calls
  const analyzed = await analyze(data);   // 200 tool calls
  const report = await generate(analyzed); // 100 tool calls

  // Only store at the end!
  await storeProgress({
    completedSteps: ['collect', 'analyze', 'generate'],
    ...
  });
  return report;
}

// Pattern: Checkpointing throughout
async function goodApproach(): Promise<Result> {
  const data = await collectData();
  await storeProgress({
    completedSteps: ['collect'],
    currentStep: 'analyze',
    keyFindings: extractFindings(data)
  });

  const analyzed = await analyze(data);
  await storeProgress({
    completedSteps: ['collect', 'analyze'],
    currentStep: 'generate',
    keyFindings: [...previous, ...extractAnalysis(analyzed)]
  });

  // If compaction happens here, we resume with full knowledge
  const report = await generate(analyzed);
  await storeProgress({ completedSteps: ['collect', 'analyze', 'generate'] });

  return report;
}`}</CodeBlock>

      {/* The Prediction */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Prediction
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Within 18 months, &ldquo;compaction-first&rdquo; agent design will be as standard as &ldquo;mobile-first&rdquo;
        web design was in 2015. Not because it&rsquo;s elegant&mdash;because the economics are inexorable.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Infinite context sounds like a solution until you do the math. At current rates,
        200K tokens costs roughly $1-2 per request. For an agent running continuously
        with 4K token output per step, that&rsquo;s $1-2 every 50 steps. A 3,000-step task
        (not unusual for our workloads) becomes $60-120 in context costs alone. And that&rsquo;s
        assuming you <em>want</em> all that context&mdash;which, as we&rsquo;ve shown, you don&rsquo;t.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The alternative: compact aggressively, store in external state (DynamoDB, Postgres,
        whatever&mdash;costs pennies per million operations), and pay for tokens you actually
        use. With 32K effective context and strategic compaction, the same 3,000-step
        task costs under $5.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The technical argument is simpler: agents work better when they&rsquo;re forced to
        re-synchronize periodically. The financial argument is overwhelming. The only
        reason we&rsquo;re not all designing this way is inertia&mdash;we&rsquo;re still thinking of context
        as memory to preserve rather than a working set to curate.
      </p>

      {/* Start With One Hook */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Start With One Hook
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        If you&rsquo;re building long-running agents, don&rsquo;t wait for your context limit to bite.
        Implement a PreCompact hook today. It costs nothing if you&rsquo;re not hitting limits
        yet, and it transforms a future emergency into a controlled synchronization point.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The code above is real&mdash;it&rsquo;s running in production, handling tasks that run for
        hours and call thousands of tools. The patterns work because they acknowledge
        something fundamental: context windows aren&rsquo;t memory. They&rsquo;re attention. And
        attention, by nature, must be focused.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Stop fighting the limit. Design for it.
      </p>
    </BlogPostLayout>
  );
}
