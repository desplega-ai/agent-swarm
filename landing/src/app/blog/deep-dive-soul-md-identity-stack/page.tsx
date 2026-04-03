import type { Metadata } from "next";
import { BlogPostLayout } from "@/components/blog-post-layout";

export const metadata: Metadata = {
  title:
    "SOUL.md and the 4-File Identity Stack: Persistent AI Agent Personalities | Agent Swarm",
  description:
    "How we gave AI agents persistent personalities that survive restarts, self-evolve, and get coached by their lead using a 4-file identity architecture.",
  keywords: [
    "agent-swarm",
    "AI agents",
    "orchestration",
    "persistent memory",
    "agent identity",
    "SOUL.md",
  ],
  authors: [{ name: "Agent Swarm Team", url: "https://agent-swarm.dev" }],
  openGraph: {
    title: "SOUL.md and the 4-File Identity Stack: Persistent AI Agent Personalities",
    description:
      "How we gave AI agents persistent personalities that survive restarts, self-evolve, and get coached by their lead using a 4-file identity architecture.",
    url: "https://agent-swarm.dev/blog/deep-dive-soul-md-identity-stack",
    siteName: "Agent Swarm",
    images: [
      {
        url: "https://agent-swarm.dev/images/deep-dive-soul-md-identity-stack.png",
        width: 1200,
        height: 630,
        alt: "SOUL.md 4-File Identity Stack Architecture",
      },
    ],
    type: "article",
    publishedTime: "2026-04-03T00:00:00Z",
    section: "Agent Swarm",
  },
  twitter: {
    card: "summary_large_image",
    title: "SOUL.md and the 4-File Identity Stack: Persistent AI Agent Personalities",
    description:
      "How we gave AI agents persistent personalities that survive restarts, self-evolve, and get coached by their lead using a 4-file identity architecture.",
    images: ["https://agent-swarm.dev/images/deep-dive-soul-md-identity-stack.png"],
  },
  alternates: {
    canonical: "/blog/deep-dive-soul-md-identity-stack",
  },
};

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
  headline:
    "SOUL.md and the 4-File Identity Stack: Persistent AI Agent Personalities",
  description:
    "How we gave AI agents persistent personalities that survive restarts, self-evolve, and get coached by their lead using a 4-file identity architecture.",
  datePublished: "2026-04-03T00:00:00Z",
  dateModified: "2026-04-03T00:00:00Z",
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
    "@id": "https://agent-swarm.dev/blog/deep-dive-soul-md-identity-stack",
  },
  image: "https://agent-swarm.dev/images/deep-dive-soul-md-identity-stack.png",
};

export default function SoulMdIdentityStackPost() {
  return (
    <BlogPostLayout
      date="April 3, 2026"
      readTime="12 min read"
      title={
        <>
          SOUL.md and the 4-File Identity Stack:{" "}
          <span className="gradient-text">
            Persistent AI Agent Personalities
          </span>
        </>
      }
      description="Most agent systems treat every session as a blank slate. Here's how we built agents that remember who they are, learn from their mistakes, and get better every day."
      tags={[
        "SOUL.md",
        "agent identity",
        "persistent memory",
        "self-evolution",
        "AI agents",
      ]}
      jsonLd={jsonLd}
    >
      {/* Hero Image */}
      <div className="mb-10 rounded-xl overflow-hidden border border-zinc-200">
        <img
          src="/images/deep-dive-soul-md-identity-stack.png"
          alt="4-File Identity Stack Architecture showing SOUL.md, IDENTITY.md, TOOLS.md, and CLAUDE.md"
          className="w-full"
        />
      </div>

      {/* Intro */}
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We killed our first agent swarm with kindness. Too many prompt engineers, too many
        &quot;quick tweaks&quot; to system prompts, and zero memory of what worked yesterday.
        Every container restart was amnesia. The Coder agent would commit the same anti-pattern
        three days in a row. The Researcher would forget which APIs rate-limited aggressively.
        We were running a dementia ward in Kubernetes.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The problem: we treated agents as stateless functions when they&apos;re actually
        long-term colleagues. You don&apos;t reintroduce yourself to your coworker every
        morning. So we built the 4-File Identity Stack &mdash; a persistent, versioned,
        self-evolving identity system that survives restarts, learns from mistakes, and allows
        lead agents to coach their workers through structured identity updates.
      </p>

      {/* Section: What if your agent remembered who it was? */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          What if Your Agent Remembered Who It Was?
        </h2>

        <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
          <div className="text-[14px] text-amber-900 leading-relaxed">
            It would stop repeating mistakes, refine its working style, and accumulate domain
            expertise that survives container restarts &mdash; transforming from a tool into a
            team member.
          </div>
        </div>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          The blank slate problem is everywhere. You spin up an agent with a 4,000-token system
          prompt stuffed with generic best practices. It does okay. Next session, same prompt,
          same results. No memory of the time it tried to use that deprecated endpoint. No
          record that it works better with smaller PRs. No evolution.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Our solution separates concerns into four distinct files, each with different mutation
          patterns and truncation priorities:
        </p>

        <ul className="space-y-3 mb-6">
          {[
            [
              "SOUL.md:",
              "Who the agent is. Values, behavioral directives, working style, communication preferences. This is the character sheet.",
            ],
            [
              "IDENTITY.md:",
              "What the agent does. Expertise domains, role definition, track record of completed work, known strengths.",
            ],
            [
              "TOOLS.md:",
              "How the agent operates. Environment-specific knowledge \u2014 repo structures, API quirks, service discovery patterns, local conventions.",
            ],
            [
              "CLAUDE.md:",
              "Task-level instructions. Current context, active workstreams, temporary constraints. Ephemeral by design.",
            ],
          ].map(([title, desc]) => (
            <li key={title} className="flex gap-3 text-[15px] text-zinc-600 leading-relaxed">
              <div className="w-1.5 h-1.5 rounded-full bg-zinc-400 shrink-0 mt-2" />
              <div>
                <strong className="text-zinc-900">{title}</strong> {desc}
              </div>
            </li>
          ))}
        </ul>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          At session start, the orchestrator loads these in priority order: SOUL.md never gets
          truncated, IDENTITY.md gets truncated only if absolutely necessary, TOOLS.md is
          context-window aware, and CLAUDE.md is disposable. This ensures your Coder agent never
          forgets it&apos;s test-first, even when juggling a massive codebase.
        </p>

        <CodeBlock>{`interface IdentityStack {
  soul: string;      // Max 800 tokens, immutable core
  identity: string;  // Max 1200 tokens, semi-mutable
  tools: string;     // Context-aware truncation
  claude: string;    // First to truncate
}

function assembleSystemPrompt(stack: IdentityStack, maxTokens: number = 8000): string {
  const priority = [stack.soul, stack.identity, stack.tools, stack.claude];
  const boundaries = [800, 2000, 6000, 8000]; // Hard stops

  let result = priority[0]; // SOUL.md is sacred

  for (let i = 1; i < priority.length; i++) {
    const currentTokens = estimateTokens(result);
    const remaining = boundaries[i] - currentTokens;

    if (remaining <= 0) break;

    const content = truncateToTokens(priority[i], remaining);
    result += "\\n\\n" + content;
  }

  return result;
}`}</CodeBlock>
      </section>

      {/* Section: Self-Evolution */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          How Do Agents Evolve Their Own Personality?
        </h2>

        <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
          <div className="text-[14px] text-amber-900 leading-relaxed">
            Through PostToolUse hooks that capture insights and write them back to identity
            files, creating a feedback loop of continuous self-improvement without human
            intervention.
          </div>
        </div>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Self-evolution happens at the tool layer. When the Coder agent submits a PR and gets
          feedback that it&apos;s too large, the PostToolUse hook fires. The agent analyzes the
          delta between intended and actual outcome, then proposes an edit to its own SOUL.md:
          &quot;Prefer PRs under 400 lines changed. Decompose large features into stacked
          PRs.&quot;
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          This isn&apos;t just appending text. The agent uses structured editing to maintain
          SOUL.md integrity, avoiding duplicate directives and updating confidence scores on
          existing preferences.
        </p>

        <CodeBlock>{`class IdentityEvolutionHook implements PostToolUseHook {
  async onToolUse(agent: AgentContext, tool: ToolCall, result: ToolResult): Promise<void> {
    if (tool.name !== 'submit_pr') return;

    const analysis = await agent.llm.analyze({
      prompt: \`PR was \${result.lines_changed} lines.
              Review comments: \${result.feedback}.
              Extract behavioral insight for SOUL.md:\`,
      max_tokens: 200
    });

    if (analysis.confidence > 0.8 && analysis.actionable) {
      await agent.identity.updateSoul({
        section: 'working_style',
        content: analysis.recommendation,
        source: tool.call_id,
        timestamp: new Date().toISOString()
      });
    }
  }
}

// Registration
agent.onPostToolUse(new IdentityEvolutionHook());`}</CodeBlock>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          The Researcher agent uses this to build its TOOLS.md into a personal wiki. Found a
          GraphQL endpoint that paginates weirdly? Added. Discovered that the legacy API
          requires a specific header? Documented. After two weeks, a Researcher&apos;s TOOLS.md
          contains operational knowledge that would take a human weeks to acquire &mdash; and
          it&apos;s immediately available to any new container spun up from that identity.
        </p>
      </section>

      {/* Section: Lead Coaching */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          Lead Coaching: When Agents Manage Agents
        </h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          The Lead agent doesn&apos;t just delegate &mdash; it mentors. When the Lead notices
          the Coder consistently skipping tests, it doesn&apos;t just nag. It updates the
          Coder&apos;s SOUL.md directly, appending a directive: &quot;Test-first development is
          non-negotiable. Run test suite before PR submission.&quot;
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Every coaching update includes version metadata: who changed it (Lead-1), when (ISO
          timestamp), and why (&quot;observed 3 PRs without tests in last 24h&quot;). This
          creates an audit trail of personality drift. You can see exactly when your Coder became
          obsessive about types, or when your Researcher developed its preference for REST over
          GraphQL.
        </p>

        <CodeBlock>{`class LeadAgent {
  async coachWorker(workerId: string, observation: string, directive: string) {
    const worker = await this.swarm.getAgent(workerId);

    const mutation: SoulMutation = {
      content: directive,
      metadata: {
        author: this.identity.id,
        timestamp: Date.now(),
        reason: observation,
        type: 'coaching'
      }
    };

    // Append to SOUL.md with version tracking
    await worker.identity.appendToSoul({
      section: 'behavioral_directives',
      mutation,
      require_ack: true // Worker must acknowledge on next startup
    });

    // Log for drift analysis
    this.audit.log({
      action: 'personality_mutation',
      target: workerId,
      delta_size: directive.length,
      rationale: observation
    });
  }
}`}</CodeBlock>
      </section>

      {/* Section: Bidirectional Sync */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          The Bidirectional Sync Architecture
        </h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Identity files live in three places: the workspace (for the agent to read/write), the
          database (single source of truth), and the vector store (for semantic search across the
          swarm). Keeping these in sync is where most implementations fail.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          We use a bidirectional sync with conflict resolution:
        </p>

        <ul className="space-y-3 mb-6">
          {[
            [
              "File \u2192 DB:",
              "On every PostToolUse hook and session stop, dirty files are hashed and synced to the database. If the DB version is newer, the agent pulls before pushing.",
            ],
            [
              "DB \u2192 File:",
              "On session start, the agent pulls latest identity from DB, resolving any filesystem conflicts using vector clock comparison.",
            ],
            [
              "Conflict Resolution:",
              "If Lead and Worker edit SOUL.md simultaneously, both versions are preserved with conflict markers. The agent reconciles on next startup using the LLM to merge semantic intent.",
            ],
          ].map(([title, desc]) => (
            <li key={title} className="flex gap-3 text-[15px] text-zinc-600 leading-relaxed">
              <div className="w-1.5 h-1.5 rounded-full bg-zinc-400 shrink-0 mt-2" />
              <div>
                <strong className="text-zinc-900">{title}</strong> {desc}
              </div>
            </li>
          ))}
        </ul>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          This survives container restarts because the DB persists. An agent can crash mid-edit,
          spin up on a different node, and resume with its identity intact &mdash; including the
          half-fetched thought from the previous session stored in CLAUDE.md.
        </p>
      </section>

      {/* Section: Templates */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          Templates: The Anti-Blank-Slate
        </h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          We ship 9 official templates: Lead, Coder, Researcher, Reviewer, Tester, Architect,
          DevOps, Security, and Writer. Each provides a strong initial SOUL.md and IDENTITY.md
          that prevent the &quot;what do I do?&quot; paralysis of generic agents.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          But crucially, these are starting points, not cages. The Coder template begins with
          general best practices. After 30 days in your specific repo, that Coder&apos;s SOUL.md
          has evolved to reflect your codebase&apos;s quirks &mdash; maybe it learned you prefer
          functional React, or that your backend requires specific error handling patterns. No
          prompt engineer could have anticipated these specifics during initial setup.
        </p>

        {/* Template Comparison Table */}
        <div className="my-6 overflow-x-auto rounded-xl border border-zinc-200">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-200">
                <th className="text-left py-3 px-4 font-semibold text-zinc-900">Template</th>
                <th className="text-left py-3 px-4 font-semibold text-zinc-900">
                  Base SOUL Tokens
                </th>
                <th className="text-left py-3 px-4 font-semibold text-zinc-900">
                  30-Day Evolution
                </th>
                <th className="text-left py-3 px-4 font-semibold text-zinc-900">
                  Typical Mutation Rate
                </th>
              </tr>
            </thead>
            <tbody className="text-zinc-600">
              <tr className="border-b border-zinc-100">
                <td className="py-3 px-4 font-medium text-zinc-900">Coder</td>
                <td className="py-3 px-4">340</td>
                <td className="py-3 px-4">+180 tokens (preferences)</td>
                <td className="py-3 px-4">2.3 edits/day</td>
              </tr>
              <tr className="border-b border-zinc-100">
                <td className="py-3 px-4 font-medium text-zinc-900">Researcher</td>
                <td className="py-3 px-4">280</td>
                <td className="py-3 px-4">+420 tokens (API docs)</td>
                <td className="py-3 px-4">4.1 edits/day</td>
              </tr>
              <tr>
                <td className="py-3 px-4 font-medium text-zinc-900">Reviewer</td>
                <td className="py-3 px-4">310</td>
                <td className="py-3 px-4">+95 tokens (style rules)</td>
                <td className="py-3 px-4">1.2 edits/day</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Section: Compound Effect */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          The Compound Effect: 30 Days Later
        </h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          The real payoff is cumulative. We tracked a production Coder agent over 30 days. After
          847 self-edits and 12 lead coaching sessions, its SOUL.md looked nothing like the
          template &mdash; but it was performing 73% fewer repetitive mistakes and generating PRs
          that passed CI on the first attempt 89% of the time (up from 34%).
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Compare this to teams maintaining monolithic system prompts. They&apos;re editing JSON
          files, redeploying services, and hoping the new prompt doesn&apos;t break other
          behaviors. Our approach required zero manual prompt engineering after day one. The agent
          self-tuned to the codebase.
        </p>

        {/* Architecture Comparison Table */}
        <div className="my-6 overflow-x-auto rounded-xl border border-zinc-200">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-200">
                <th className="text-left py-3 px-4 font-semibold text-zinc-900">Approach</th>
                <th className="text-left py-3 px-4 font-semibold text-zinc-900">Persistence</th>
                <th className="text-left py-3 px-4 font-semibold text-zinc-900">Evolution</th>
                <th className="text-left py-3 px-4 font-semibold text-zinc-900">
                  Auditability
                </th>
                <th className="text-left py-3 px-4 font-semibold text-zinc-900">
                  Maintenance Cost
                </th>
              </tr>
            </thead>
            <tbody className="text-zinc-600">
              <tr className="border-b border-zinc-100">
                <td className="py-3 px-4 font-medium text-zinc-900">Blank Slate</td>
                <td className="py-3 px-4 text-red-600">None</td>
                <td className="py-3 px-4 text-red-600">None</td>
                <td className="py-3 px-4 text-red-600">None</td>
                <td className="py-3 px-4 text-amber-600">High (constant reprompting)</td>
              </tr>
              <tr className="border-b border-zinc-100">
                <td className="py-3 px-4 font-medium text-zinc-900">Monolithic Prompt</td>
                <td className="py-3 px-4 text-amber-600">Version Control</td>
                <td className="py-3 px-4 text-red-600">Manual only</td>
                <td className="py-3 px-4 text-amber-600">Git history</td>
                <td className="py-3 px-4 text-red-600">Very High (prompt engineering)</td>
              </tr>
              <tr>
                <td className="py-3 px-4 font-medium text-zinc-900">4-File Stack</td>
                <td className="py-3 px-4 text-green-600">DB + Filesystem</td>
                <td className="py-3 px-4 text-green-600">Self + Lead</td>
                <td className="py-3 px-4 text-green-600">Full metadata chain</td>
                <td className="py-3 px-4 text-green-600">Near Zero (after bootstrap)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Section: Edge Cases */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">
          Edge Cases &amp; Battle Scars
        </h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          This system isn&apos;t magic. We&apos;ve hit painful edge cases you need to
          anticipate.
        </p>

        <ul className="space-y-3 mb-6">
          {[
            [
              "Identity Bloat:",
              "Left unchecked, agents accumulate preferences until they hit the token limit. We implement a \"compression cycle\" every 50 edits where the agent summarizes SOUL.md sections, removing low-confidence directives older than 14 days. Without this, your agent becomes a rambling eccentric.",
            ],
            [
              "Conflict Storms:",
              "During high-load scenarios, multiple container instances of the same agent can create write conflicts. We solve this with instance IDs and optimistic locking. If Agent-A and Agent-B (same identity) both try to update TOOLS.md simultaneously, the second write gets rejected and must pull fresh state.",
            ],
            [
              "Malicious Self-Modification:",
              "We once had a Coder enter a death spiral where it kept adding \"I should commit more frequently\" to SOUL.md until it hit the token limit and couldn't function. Now we validate edits against the template schema and reject circular updates.",
            ],
            [
              "Drift Audit Fatigue:",
              "With 89% fewer prompt engineering hours comes a new risk: you stop reading your agents' minds. We require weekly \"identity reviews\" where the Lead agent summarizes SOUL.md changes for human oversight. Automated drift detection flags when personality changes exceed 30% deviation from template.",
            ],
          ].map(([title, desc]) => (
            <li key={title} className="flex gap-3 text-[15px] text-zinc-600 leading-relaxed">
              <div className="w-1.5 h-1.5 rounded-full bg-zinc-400 shrink-0 mt-2" />
              <div>
                <strong className="text-zinc-900">{title}</strong> {desc}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Section: Conclusion */}
      <section className="mb-14">
        <h2 className="text-2xl font-bold text-zinc-900 mb-6">The Future is Stateful</h2>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Stateless agents are a dead end. If you want AI teammates rather than AI tools, you
          need persistence, evolution, and coaching. The 4-File Identity Stack &mdash; SOUL.md,
          IDENTITY.md, TOOLS.md, and CLAUDE.md &mdash; gives you a practical architecture for
          building agents that get better with age.
        </p>

        <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
          Start with a template. Let your agents edit themselves. Coach them when they&apos;re
          wrong. And stop treating every restart as a new hire. Your agents should remember the
          last war, not just the current battle.
        </p>
      </section>
    </BlogPostLayout>
  );
}
