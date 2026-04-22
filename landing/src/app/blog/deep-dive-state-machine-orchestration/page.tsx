import type { Metadata } from "next";
import { BlogPostLayout } from "@/components/blog-post-layout";

export const metadata: Metadata = {
  title:
    "Why We Ditched DAGs for State Machines in Agent Orchestration | Agent Swarm",
  description:
    "How agent-swarm.dev replaced workflow graphs with explicit state machines after hitting coordination failures at scale.",
  keywords: [
    "agent-swarm",
    "AI agents",
    "orchestration",
    "state machine",
    "workflow engine",
    "distributed systems",
    "DAG",
  ],
  authors: [{ name: "Agent Swarm Team", url: "https://agent-swarm.dev" }],
  openGraph: {
    title:
      "Why We Ditched DAGs for State Machines in Agent Orchestration",
    description:
      "How agent-swarm.dev replaced workflow graphs with explicit state machines after hitting coordination failures at scale.",
    url: "https://agent-swarm.dev/blog/deep-dive-state-machine-orchestration",
    siteName: "Agent Swarm",
    images: [
      {
        url: "https://agent-swarm.dev/images/deep-dive-state-machine-orchestration.png",
        width: 1200,
        height: 630,
        alt: "State machine diagram showing explicit transitions between agent states",
      },
    ],
    type: "article",
    publishedTime: "2026-04-22T00:00:00Z",
    section: "Agent Swarm",
  },
  twitter: {
    card: "summary_large_image",
    title: "Why We Ditched DAGs for State Machines in Agent Orchestration",
    description:
      "How agent-swarm.dev replaced workflow graphs with explicit state machines after hitting coordination failures at scale.",
    images: [
      "https://agent-swarm.dev/images/deep-dive-state-machine-orchestration.png",
    ],
  },
  alternates: {
    canonical: "/blog/deep-dive-state-machine-orchestration",
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
    "Why We Ditched DAGs for State Machines in Agent Orchestration",
  description:
    "How agent-swarm.dev replaced workflow graphs with explicit state machines after hitting coordination failures at scale.",
  datePublished: "2026-04-22T00:00:00Z",
  dateModified: "2026-04-22T00:00:00Z",
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
      "https://agent-swarm.dev/blog/deep-dive-state-machine-orchestration",
  },
  image:
    "https://agent-swarm.dev/images/deep-dive-state-machine-orchestration.png",
};

export default function StateMachineOrchestrationPost() {
  return (
    <BlogPostLayout
      date="April 22, 2026"
      readTime="14 min read"
      title={
        <>
          Why We Ditched DAGs for{" "}
          <span className="gradient-text">
            State Machines in Agent Orchestration
          </span>
        </>
      }
      description="We thought DAGs would give us deterministic execution. Instead, they gave us distributed deadlocks at 3 AM."
      tags={[
        "state machine",
        "orchestration",
        "workflow engine",
        "DAG",
        "distributed systems",
        "AI agents",
      ]}
      jsonLd={jsonLd}
    >
      {/* Hero Image */}
      <div className="mb-10 rounded-xl overflow-hidden border border-zinc-200">
        <img
          src="/images/deep-dive-state-machine-orchestration.png"
          alt="State machine diagram showing explicit transitions between agent states"
          className="w-full"
        />
      </div>

      {/* Intro */}
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Our first version of agent-swarm used a DAG-based workflow engine. It
        was beautiful on paper: nodes for agents, edges for data flow,
        topological sorting guaranteeing execution order. We shipped it to
        production in June. By July, we had built a cron job that restarted
        stuck workflows at 2 AM.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The problem wasn&rsquo;t the DAGs. It was that agents aren&rsquo;t
        functions. They fail in ways that violate the DAG&rsquo;s core
        assumption: that a failed node is either retryable or terminal. When
        Agent A produces technically valid but semantically ambiguous output,
        Agent B doesn&rsquo;t fail&mdash;it proceeds confidently down the wrong
        path. Then Agent C builds on that. By the time you notice,
        you&rsquo;re three hops deep in garbage.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We rebuilt around explicit state machines. Not because they&rsquo;re
        theoretically cleaner. Because they let us express something DAGs
        can&rsquo;t:{" "}
        <em>the system knows it&rsquo;s confused and needs to ask for help.</em>
      </p>

      {/* Section: What Actually Breaks */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What Actually Breaks in Production DAGs
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        DAG-based orchestrators (Prefect, Airflow, Temporal&rsquo;s async
        workflows) assume failure modes are known. A node throws an exception,
        you catch it, you retry with exponential backoff. This works for
        deterministic compute. It fails for LLM agents because:
      </p>

      <ul className="space-y-2 text-[15px] text-zinc-600 leading-relaxed pl-6 list-disc mb-6">
        <li>
          <strong>Semantic drift</strong>: Output passes schema validation but
          shifts meaning. The &ldquo;summary&rdquo; node starts emitting bullet
          points. Downstream agents weren&rsquo;t built for bullets.
        </li>
        <li>
          <strong>Negotiation deadlocks</strong>: Agent A needs clarification
          from Agent B, which needs context from Agent A. DAGs have no
          primitive for &ldquo;pause and discuss.&rdquo;
        </li>
        <li>
          <strong>Silent degradation</strong>: Confidence scores drop below
          thresholds but stay above failure thresholds. The system gets worse
          without failing.
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        In our experience, these showed up as tasks stuck in &ldquo;running&rdquo;
        for 45 minutes, or workflows completing with outputs that didn&rsquo;t
        match the input&rsquo;s intent. The DAG was happy. The result was
        useless.
      </p>

      {/* Section: Our State Machine Design */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Our State Machine Design
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We moved to a hierarchical state machine where each agent has explicit
        states: <code>idle &rarr; preparing &rarr; executing &rarr; validating
        &rarr; committing | negotiating | failed</code>. The key is that{" "}
        <code>negotiating</code> is a first-class state, not an error handler.
      </p>

      <CodeBlock>{`// From /packages/core/src/state-machine/agent-state.ts
export type AgentState =
  | { type: 'idle'; context: AgentContext }
  | { type: 'preparing'; context: AgentContext; intent: TaskIntent }
  | { type: 'executing'; context: AgentContext; startTime: ISO8601 }
  | { type: 'validating'; context: AgentContext; candidate: CandidateOutput }
  | { type: 'negotiating'; context: AgentContext; dispute: DisputeRecord; partners: AgentId[] }
  | { type: 'committing'; context: AgentContext; output: CommittedOutput }
  | { type: 'failed'; context: AgentContext; reason: FailureReason; retryable: boolean };

// Guard functions enforce valid transitions
const validTransitions: Record<AgentState['type'], AgentState['type'][]> = {
  idle: ['preparing'],
  preparing: ['executing', 'failed'],
  executing: ['validating', 'failed'],
  validating: ['committing', 'negotiating', 'failed'],
  negotiating: ['executing', 'committing', 'failed'],
  committing: ['idle'], // completes the cycle
  failed: ['preparing', 'idle'], // retry or abort
};`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The <code>negotiating</code> state is where agents resolve ambiguity.
        Instead of retrying silently, they enter explicit coordination. The
        state machine tracks which agents are involved, what the dispute is
        about (through <code>DisputeRecord</code>), and how long they&rsquo;ve
        been stuck.
      </p>

      {/* Callout: Why explicit negotiation beats implicit retries */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Why Does Explicit Negotiation Beat Implicit Retries?
      </h2>

      <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
        <div className="text-[14px] text-amber-900 leading-relaxed">
          It surfaces cross-agent dependencies that DAGs hide. When our
          validation agent rejects output, we now capture why. If it&rsquo;s a
          schema error, we retry. If it&rsquo;s semantic disagreement, we
          negotiate. The difference was removing 70%+ of our &ldquo;stuck&rdquo;
          tasks within two weeks of shipping.
        </div>
      </div>

      {/* Section: The Pattern */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Pattern: Coordinated Validation with Dispute Resolution
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Here&rsquo;s a real workflow from our codebase: multi-agent document
        analysis where a retriever, synthesizer, and fact-checker must agree
        before committing. The DAG version would chain them linearly. The state
        machine version lets them iterate.
      </p>

      <CodeBlock>{`// From /packages/workflows/src/document-analysis/coordination.ts
async function coordinatedAnalysis(
  stateMachine: StateMachineService,
  document: Document,
  agentPool: AgentPool
): Promise<AnalysisResult> {
  // All three agents start in parallel, same initial context
  const retriever = await agentPool.acquire('retriever');
  const synthesizer = await agentPool.acquire('synthesizer');
  const factChecker = await agentPool.acquire('fact-checker');

  const sharedContext = await buildSharedContext(document);

  // Each agent enters executing independently
  const retrieverPromise = stateMachine.transition(retriever.id, {
    from: 'idle',
    to: 'executing',
    context: sharedContext,
  });

  const synthesizerPromise = stateMachine.transition(synthesizer.id, {
    from: 'idle',
    to: 'executing',
    context: sharedContext,
  });

  // Fact checker waits for initial outputs, then validates
  const [retrieverOutput, synthesisOutput] = await Promise.all([
    retrieverPromise, synthesizerPromise
  ]);

  // Explicit validation gate with possible negotiation
  const validation = await stateMachine.transition(factChecker.id, {
    from: 'idle',
    to: 'validating',
    context: {
      ...sharedContext,
      retrieverOutput,
      synthesisOutput,
    },
  });

  // If validation disputes, enter negotiation
  if (validation.type === 'validating' && validation.candidate.confidence < CONFIDENCE_THRESHOLD) {
    const dispute = await stateMachine.transition(factChecker.id, {
      from: 'validating',
      to: 'negotiating',
      dispute: {
        issue: 'confidence_too_low',
        details: validation.candidate.concerns,
        proposedResolution: null,
      },
      partners: [retriever.id, synthesizer.id],
    });

    // Negotiation protocol: agents propose resolutions, vote, retry
    const resolution = await runNegotiationProtocol(dispute, {
      maxRounds: 3,
      timeoutMs: 30000,
    });

    if (resolution.accepted) {
      return commitWithResolution(stateMachine, factChecker, resolution);
    }
    return escalateToHuman(stateMachine, factChecker, dispute);
  }

  // Clean commit path
  return commitOutput(stateMachine, factChecker, validation.candidate);
}`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The critical difference: <code>runNegotiationProtocol</code> is a
        first-class citizen. It has timeouts, round limits, and explicit voting.
        In our DAG version, this was a retry loop with a comment saying
        &ldquo;TODO: better coordination.&rdquo; The retry loop would spin for
        10 minutes before timing out. The negotiation protocol typically
        resolves in under 5 seconds or escalates immediately.
      </p>

      {/* Section: What We Tried */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What We Tried That Didn&rsquo;t Work
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Before settling on this design, we experimented with several approaches
        that seemed reasonable but collapsed under load.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>Event sourcing with CQRS.</strong> We tried persisting every
        state change as events, with separate read models for querying. The
        write amplification was worse than expected&mdash;every LLM token
        generation produced state updates, and our event store grew 20GB daily.
        More critically, rebuilding state from events for debugging was too
        slow when operators needed answers in seconds, not minutes.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>Persistent actor models (Akka-style).</strong> We liked the
        idea of agents as actors with mailboxes. But message passing between
        LLM agents is too coarse-grained. An agent needs structured access to
        another&rsquo;s context, not just async messages. We ended up with
        actor wrappers around state machines, which added overhead without
        benefit.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        <strong>Temporal-style durable execution.</strong> We actually wanted
        this to work. But Temporal&rsquo;s determinism requires deterministic
        operations. LLM inference is fundamentally non-deterministic&mdash;same
        prompt, different outputs. Temporal&rsquo;s replay-based recovery broke
        constantly. We would have needed to wrap every LLM call in
        deterministic stubs, which defeats the point of using agents instead of
        code.
      </p>

      {/* Section: Operational Wins */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Operational Wins: What Changed Day-To-Day
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The state machine isn&rsquo;t just cleaner code. It&rsquo;s changed how
        we operate the system.
      </p>

      <div className="my-6 rounded-xl border border-zinc-200 overflow-hidden">
        <table className="w-full text-[14px]">
          <thead className="bg-zinc-50">
            <tr>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">
                Before (DAGs)
              </th>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">
                After (State Machines)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            <tr>
              <td className="py-3 px-4 text-zinc-600 align-top">
                &ldquo;Task running 45min&rdquo;&mdash;why? Unknown.
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top">
                &ldquo;Agent in negotiating state, round 2 of 3, waiting for
                synthesizer response&rdquo;
              </td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600 align-top">
                Kill stuck workflows, lose partial progress
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top">
                Checkpoint at every state transition, resume from any point
              </td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600 align-top">
                Retry storms when downstream agents disagree
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top">
                Explicit negotiation limits, human escalation after 3 rounds
              </td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600 align-top">
                Schema errors caught late
              </td>
              <td className="py-3 px-4 text-zinc-600 align-top">
                Validation gates at every transition, semantic and syntactic
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The observability change alone justified the migration. Our PagerDuty
        alerts shifted from &ldquo;something is stuck somewhere&rdquo; to
        &ldquo;Agent X in Workflow Y needs human judgment on semantic conflict
        Z.&rdquo; Mean time to resolution for stuck workflows dropped from 45
        minutes to under 5 minutes.
      </p>

      {/* Section: Versioned Checkpoints */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Implementation Detail: Versioned Checkpoints
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        One pattern we learned from database systems: checkpoints must be
        versioned and immutable. We don&rsquo;t update state in place. Every
        transition produces a new checkpoint, old ones are retained for replay
        and debugging.
      </p>

      <CodeBlock>{`// From /packages/core/src/checkpoint/store.ts
interface Checkpoint {
  id: CheckpointId;           // ULID, sortable
  agentId: AgentId;
  workflowId: WorkflowId;
  sequenceNumber: number;     // strictly increasing
  state: AgentState;          // full state at this point
  parentCheckpoint: CheckpointId | null;
  createdAt: ISO8601;
  // Critical: LLM outputs that led here, for reproducibility
  trace: {
    prompt: string;
    completion: string;
    modelVersion: string;
    temperature: number;
  }[];
}

async function transitionWithCheckpoint(
  store: CheckpointStore,
  agentId: AgentId,
  targetState: AgentState['type'],
  params: TransitionParams
): Promise<Checkpoint> {
  const current = await store.getLatest(agentId);

  // Optimistic concurrency — detect stale states
  if (current.state.type !== params.from) {
    throw new StaleStateError(
      \`Expected state \${params.from}, found \${current.state.type}\`
    );
  }

  // Execute transition, capture new state
  const newState = await applyGuard(current.state, targetState, params);

  // Persist before acknowledging
  const checkpoint = await store.append({
    agentId,
    state: newState,
    sequenceNumber: current.sequenceNumber + 1,
    parentCheckpoint: current.id,
    trace: captureTrace(),
  });

  // Publish event for observers (metrics, alerting)
  await publishTransitionEvent(checkpoint);

  return checkpoint;
}`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The optimistic concurrency check caught race conditions we didn&rsquo;t
        know existed. When two controllers tried to move the same agent
        (happened during network partitions), we&rsquo;d get explicit errors
        instead of silently corrupted state. The <code>StaleStateError</code>{" "}
        became our most informative exception&mdash;it told us exactly what the
        system expected vs. what it found.
      </p>

      {/* Section: Migration Path */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Migration Path: Incremental, Not Revolutionary
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We didn&rsquo;t rebuild everything at once. The migration took six
        weeks with zero downtime. Here&rsquo;s the sequence that worked:
      </p>

      <ul className="space-y-2 text-[15px] text-zinc-600 leading-relaxed pl-6 list-disc mb-6">
        <li>
          <strong>Week 1-2:</strong> Wrapped existing DAG tasks as state
          machine actions. The DAG still orchestrated, but individual
          &ldquo;nodes&rdquo; were now state machines with single states.
        </li>
        <li>
          <strong>Week 3-4:</strong> Migrated one hot path workflow (document
          analysis) to full state machine coordination. Ran shadow mode: state
          machine outputs vs. DAG outputs, compared results.
        </li>
        <li>
          <strong>Week 5:</strong> Fixed divergence issues. Mostly around
          timing&mdash;state machines were more patient, DAGs had aggressive
          timeouts.
        </li>
        <li>
          <strong>Week 6:</strong> Cut over remaining workflows. Kept DAG
          engine running for rollback, disabled after 48 hours stable.
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The shadow mode comparison was essential. We found cases where the DAG
        was &ldquo;correct&rdquo; by accident&mdash;race conditions that
        happened to resolve favorably. The state machine exposed these as
        explicit negotiation rounds, which initially looked like regressions.
        They weren&rsquo;t. They were bugs we&rsquo;d been unaware of.
      </p>

      {/* Section: Recommendations */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Recommendations We Stand Behind
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        After running this in production for several months, here are specific,
        opinionated recommendations:
      </p>

      <ol className="space-y-2 text-[15px] text-zinc-600 leading-relaxed pl-6 list-decimal mb-6">
        <li>
          <strong>Never let agents retry without knowing why.</strong> Explicit
          states force you to categorize failure modes. If you can&rsquo;t
          categorize it, you can&rsquo;t handle it.
        </li>
        <li>
          <strong>Negotiation needs budgets.</strong> Unlimited negotiation is
          just a distributed deadlock. Cap rounds, cap time, escalate to
          humans. We use 3 rounds / 30 seconds.
        </li>
        <li>
          <strong>Checkpoints before external calls.</strong> Every LLM
          inference, every database write&mdash;checkpoint first. Recovery
          without data loss is possible.
        </li>
        <li>
          <strong>State machines compose, but shallowly.</strong> We tried
          5-level hierarchies. Debugging them was worse than flat machines. Now
          we go 2-3 levels deep maximum.
        </li>
        <li>
          <strong>Keep the DAG for data flow, not agent coordination.</strong>{" "}
          We still use DAG-like structures for batch processing where agents
          don&rsquo;t negotiate. Don&rsquo;t throw away old tools&mdash;just
          use them where they fit.
        </li>
      </ol>

      {/* Section: What you can build this week */}
      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What You Can Build This Week
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        You don&rsquo;t need our full framework to start. Here&rsquo;s a
        minimal state machine you can add to an existing agent system:
      </p>

      <CodeBlock>{`// Drop-in state machine for existing agents
export class MinimalAgentStateMachine {
  private state: 'idle' | 'working' | 'validating' | 'stuck' = 'idle';
  private checkpoint: unknown = null;

  async execute<T>(
    agent: (input: unknown, checkpoint: unknown) => Promise<T>,
    input: unknown,
    validator: (output: T) => { valid: boolean; reason?: string }
  ): Promise<T> {
    // Transition: idle → working
    this.state = 'working';
    this.checkpoint = input;

    try {
      const output = await agent(input, this.checkpoint);

      // Transition: working → validating
      this.state = 'validating';
      const validation = validator(output);

      if (validation.valid) {
        this.state = 'idle';
        return output;
      }

      // Transition: validating → stuck (negotiation needed)
      this.state = 'stuck';
      throw new AgentValidationError(validation.reason, output);

    } catch (error) {
      // All failures go through stuck state
      this.state = 'stuck';
      throw error;
    }
  }

  getCurrentState() {
    return {
      state: this.state,
      hasCheckpoint: this.checkpoint !== null,
    };
  }

  // Recovery: resume from checkpoint with new parameters
  async resume(agent: Function, newInput: unknown) {
    if (this.state !== 'stuck') {
      throw new Error('Can only resume from stuck state');
    }
    return this.execute(agent, newInput, (_x) => ({ valid: true }));
  }
}`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        This fits in one file. It gives you three things your DAG probably
        doesn&rsquo;t: explicit validation gates, stuck-state detection, and
        resumability. Add metrics on <code>state</code> transitions and
        you&rsquo;ll see your system&rsquo;s behavior more clearly than any
        execution graph.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The state machine isn&rsquo;t a theoretical improvement. It&rsquo;s the
        difference between &ldquo;the system is doing something weird&rdquo;
        and &ldquo;Agent 7 needs help with semantic validation of claim
        X.&rdquo; That specificity translates directly to uptime, debuggability,
        and sleep.
      </p>
    </BlogPostLayout>
  );
}
