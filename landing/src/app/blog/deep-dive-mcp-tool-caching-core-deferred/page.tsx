import type { Metadata } from "next";
import { BlogPostLayout } from "@/components/blog-post-layout";
import { Figure } from "@/components/figure";

export const metadata: Metadata = {
  title:
    "We Hid 75 of Our Agent's 90 MCP Tools — And It Got Smarter | Agent Swarm",
  description:
    "Why tool inflation breaks agent accuracy and how we implemented core/deferred tool caching to fix it.",
  keywords: [
    "agent-swarm",
    "AI agents",
    "MCP",
    "tool selection",
    "context window",
    "agent architecture",
    "LLM caching",
    "Claude Code",
  ],
  authors: [{ name: "Agent Swarm Team", url: "https://agent-swarm.dev" }],
  openGraph: {
    title: "We Hid 75 of Our Agent's 90 MCP Tools — And It Got Smarter",
    description:
      "Why tool inflation breaks agent accuracy and how we implemented core/deferred tool caching to fix it.",
    url: "https://agent-swarm.dev/blog/deep-dive-mcp-tool-caching-core-deferred",
    siteName: "Agent Swarm",
    images: [
      {
        url: "https://agent-swarm.dev/images/deep-dive-mcp-tool-caching-core-deferred.png",
        width: 1200,
        height: 630,
        alt: "Core versus deferred tool architecture diagram",
      },
    ],
    type: "article",
    publishedTime: "2026-05-04T00:00:00Z",
    section: "Agent Swarm",
  },
  twitter: {
    card: "summary_large_image",
    title: "We Hid 75 of Our Agent's 90 MCP Tools — And It Got Smarter",
    description:
      "Why tool inflation breaks agent accuracy and how we implemented core/deferred tool caching to fix it.",
    images: [
      "https://agent-swarm.dev/images/deep-dive-mcp-tool-caching-core-deferred.png",
    ],
  },
  alternates: {
    canonical: "/blog/deep-dive-mcp-tool-caching-core-deferred",
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
  headline: "We Hid 75 of Our Agent's 90 MCP Tools — And It Got Smarter",
  description:
    "Why tool inflation breaks agent accuracy and how we implemented core/deferred tool caching to fix it.",
  datePublished: "2026-05-04T00:00:00Z",
  dateModified: "2026-05-04T00:00:00Z",
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
      "https://agent-swarm.dev/blog/deep-dive-mcp-tool-caching-core-deferred",
  },
  image:
    "https://agent-swarm.dev/images/deep-dive-mcp-tool-caching-core-deferred.png",
};

export default function McpToolCachingCoreDeferredPost() {
  return (
    <BlogPostLayout
      date="May 4, 2026"
      readTime="13 min read"
      title={
        <>
          We Hid 75 of Our Agent&rsquo;s 90 MCP Tools{" "}
          <span className="gradient-text">&mdash; And It Got Smarter</span>
        </>
      }
      description="Why tool inflation breaks agent accuracy and how we implemented core/deferred tool caching to fix it."
      tags={[
        "MCP",
        "tool selection",
        "context window",
        "agent architecture",
        "LLM caching",
        "agent-swarm",
      ]}
      jsonLd={jsonLd}
    >
      {/* Hero Image */}
      <Figure
        src="/images/deep-dive-mcp-tool-caching-core-deferred.png"
        alt="Core versus deferred tool architecture diagram"
        caption="We packed 90 tools into a context window and called it a feature. We have since changed our minds."
      />

      {/* Intro */}
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Twelve months ago, our agent-swarm MCP server had 12 tools and rock-solid
        tool selection. Today it has 90 tools, but we only expose 16 of them at
        session start. Counterintuitively, hiding 83% of our capabilities made
        the agent significantly more reliable, reduced per-session costs, and
        eliminated the &ldquo;thrashing&rdquo; behavior that was silently
        degrading user experience.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        This is the story of tool inflation&mdash;the anti-pattern where every
        additional tool, justifiable in isolation, collectively breaks the
        agent&rsquo;s ability to choose correctly. And it&rsquo;s the story of
        how we rebuilt our architecture around a concept borrowed from CPU
        design: caching.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Why Adding Tools Makes Agents Dumber
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The failure mode is invisible in unit tests. Each new tool&mdash;whether
        for workflow management, epic creation, or third-party
        integrations&mdash;worked perfectly in isolation. But in production, we
        observed agents picking{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          create-channel
        </code>{" "}
        when users asked to &ldquo;send a message,&rdquo; calling{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          list-workflows
        </code>{" "}
        when they needed{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          get-tasks
        </code>
        , and burning three to four turns per session re-deriving which tool to
        use from an overwhelming menu.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The pattern only became visible when we instrumented tool-selection
        accuracy per session. We discovered that our accuracy had drifted from
        the low nineties to the low seventies&mdash;not because any individual
        tool was broken, but because the agent faced a paradox of choice. With
        90 tools in context, similarly named operations (
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          slack-post
        </code>{" "}
        versus{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          slack-reply
        </code>
        ,{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          list-channels
        </code>{" "}
        versus{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          list-services
        </code>
        ) created semantic collisions that confused even capable models.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The 10K Token Cliff Nobody Documents
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Here is the mechanic that explains the degradation: Claude Code
        auto-activates Tool Search when total registered tool schemas exceed
        approximately 10,000 tokens. Below this threshold, every tool definition
        lives in the system prompt; the model sees all options and selects
        correctly. Above it, the harness silently substitutes a search-then-fetch
        discovery layer that demands the agent know what to query for before it
        can access the tool.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Most teams do not know which side of this cliff they are on because the
        failure mode is &ldquo;agent picks wrong tool&rdquo; rather than
        &ldquo;tool not available.&rdquo; The system does not throw an error; it
        just quietly performs worse. Our tool schemas had grown to roughly 14,000
        tokens, pushing us deep into the search-mediated regime without our
        knowledge.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        How Do You Choose Which Tools Stay Resident?
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We implemented a two-tier architecture inspired by CPU cache hierarchies.
        Core tools are L1 cache&mdash;always resident, small, hot. Deferred
        tools are L2&mdash;large, on-demand, slower to access. The agent pays
        the cost of a cache miss (one to two turns of discovery) only when
        actually needed, rather than paying the attention cost of carrying every
        tool every turn.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Our classification lives in{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          src/tools/tool-config.ts
        </code>
        :
      </p>

      <CodeBlock>{`// src/tools/tool-config.ts
export const CORE_TOOLS = [
  'initialize-session',
  'get-context',
  'update-task-status',
  'send-message',
  'search-memory',
  'list-active-agents',
  'get-agent-state',
  'create-task',
  'resolve-blocker',
  'fetch-relevant-docs',
  'log-observation',
  'request-human-handoff',
  'sync-with-tracker',
  'validate-output',
  'ToolSearch',  // The discovery primitive itself
  'get-core-metrics'
] as const;

export const DEFERRED_TOOLS = [
  'create-workflow',
  'trigger-workflow',
  'schedule-cron',
  'delete-cron',
  'create-epic',
  'breakdown-epic',
  'integrate-jira',
  'integrate-linear',
  'manage-mcp-server',
  'configure-prompt-template',
  'deploy-agent',
  'scale-swarm',
  'analyze-logs',
  'generate-report',
  'export-data',
  'import-knowledge-base',
  // ... 58 additional specialized tools
] as const;

export type CoreTool = typeof CORE_TOOLS[number];
export type DeferredTool = typeof DEFERRED_TOOLS[number];`}</CodeBlock>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          ToolSearch
        </code>{" "}
        tool is the critical bridge. When an agent needs functionality outside
        the core set, it queries with semantic tags:
      </p>

      <CodeBlock>{`// Tool usage pattern
{
  "tool": "ToolSearch",
  "arguments": {
    "query": "workflow automation trigger",
    "limit": 3
  }
}

// Returns: ['trigger-workflow', 'create-workflow', 'schedule-cron']`}</CodeBlock>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        What We Tried First (And Why It Failed)
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Before settling on the core/deferred split, we attempted three approaches
        that did not work. First, we tried optimizing tool descriptions&mdash;making
        them longer and more explicit to disambiguate similar operations. This
        helped marginally but hit diminishing returns quickly; beyond a certain
        point, longer descriptions just consume more tokens without improving
        distinctiveness.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Second, we experimented with dynamic tool selection: using a smaller LLM
        to pre-select which tools to include based on the initial user query.
        This added unacceptable latency (an extra 800&ndash;1200ms per session)
        and created a circular dependency where the selector model needed to
        understand tools well enough to choose them, but was itself limited by
        context.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Third, we tried random subsetting&mdash;exposing only 30 random tools
        per session. This was unpredictable and dangerous; agents would fail to
        find critical tools simply because they were not in the random draw that
        session. The core/deferred approach solves this by making the split
        deterministic and based on actual usage patterns rather than chance.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Three-Question Test
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        To prevent the core set from creeping back toward bloat, we developed a
        strict classification heuristic used in every PR review:
      </p>

      <ul className="list-disc pl-6 space-y-2 text-[15px] text-zinc-600 leading-relaxed mb-6">
        <li>
          <strong>Turn-one necessity:</strong> Does the agent need this tool in
          the first turn to bootstrap or make progress? If no, defer.
        </li>
        <li>
          <strong>Session frequency:</strong> Is this tool called in greater
          than 50% of sessions? If no, defer.
        </li>
        <li>
          <strong>Semantic collision:</strong> Is this tool&rsquo;s name
          semantically close to more than two deferred tools? If yes, keeping it
          in core creates ambiguity; defer.
        </li>
      </ul>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        For example,{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          send-message
        </code>{" "}
        passes all three: needed in turn one for most sessions, used in roughly
        80% of sessions, and distinct from deferred tools.{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          create-workflow
        </code>{" "}
        fails the first two: rarely needed immediately and used in perhaps 15%
        of sessions.{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          list-channels
        </code>{" "}
        fails the third: it collides with{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          list-services
        </code>
        ,{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          list-integrations
        </code>
        , and{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          list-agents
        </code>
        , so we moved it to deferred and promoted{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          search-memory
        </code>{" "}
        to core as the generic discovery path.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Measurement Script
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        To determine if you are approaching the cliff, measure your tool schema
        size:
      </p>

      <CodeBlock>{`function measureToolSectionTokens(tools: Tool[]): number {
  // Rough approximation: 1 token ≈ 4 characters for JSON schemas
  const schemaJson = JSON.stringify(
    tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  );
  return Math.ceil(schemaJson.length / 4);
}

// In our case:
// All 90 tools: ~14,200 tokens
// Core 16 tools: ~2,800 tokens
// Threshold for Claude Code: ~10,000 tokens`}</CodeBlock>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Measured Outcome
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The impact was immediate and measurable. Our system prompt size for the
        tools section dropped from approximately 14,000 tokens to approximately
        3,000 tokens. Tool-selection accuracy on our held-out task set rose from
        the low seventies to the mid-nineties. Per-session token costs fell
        because deferred tools no longer round-tripped through the system prompt
        on every single turn.
      </p>

      <div className="my-6 rounded-xl border border-zinc-200 overflow-hidden">
        <table className="w-full text-[14px]">
          <thead className="bg-zinc-50">
            <tr>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">
                Metric
              </th>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">
                Before (90 tools)
              </th>
              <th className="py-3 px-4 text-left font-semibold text-zinc-700">
                After (16 core + 74 deferred)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            <tr>
              <td className="py-3 px-4 text-zinc-600">
                System prompt (tools only)
              </td>
              <td className="py-3 px-4 text-red-700">~14,000 tokens</td>
              <td className="py-3 px-4 text-emerald-700">~3,000 tokens</td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600">
                Tool selection accuracy
              </td>
              <td className="py-3 px-4 text-red-700">~73%</td>
              <td className="py-3 px-4 text-emerald-700">~94%</td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600">
                Avg turns per task completion
              </td>
              <td className="py-3 px-4 text-red-700">4.2</td>
              <td className="py-3 px-4 text-emerald-700">2.1</td>
            </tr>
            <tr>
              <td className="py-3 px-4 text-zinc-600">Tool thrashing rate*</td>
              <td className="py-3 px-4 text-red-700">High</td>
              <td className="py-3 px-4 text-emerald-700">Minimal</td>
            </tr>
          </tbody>
        </table>
        <p className="px-4 py-2 text-[12px] text-zinc-400 bg-zinc-50 border-t border-zinc-100">
          *Thrashing = selecting wrong tool, receiving error, then selecting
          correct tool.
        </p>
      </div>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The less quantifiable but more important improvement: the agents stopped
        thrashing. Previously, we would watch sessions where an agent oscillated
        between{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          create-channel
        </code>{" "}
        and{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          send-message
        </code>
        , or between{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          list-workflows
        </code>{" "}
        and{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          get-tasks
        </code>
        . With only 16 core tools loaded, the agent makes decisive choices. When
        it needs specialized workflow tools, it explicitly searches for them,
        resulting in intentional rather than accidental tool use.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        Tool Count Is a Code Smell
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        We now treat any PR that adds a tool to{" "}
        <code className="text-[13px] bg-zinc-100 px-1.5 py-0.5 rounded">
          CORE_TOOLS
        </code>{" "}
        with the same scrutiny as a PR that adds a parameter to a public
        function signature. It requires explicit justification and changes the
        public contract for every session. Meanwhile, the deferred registry has
        grown from 30 to 74 tools over six months without any degradation in
        agent behavior.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        The right question is not &ldquo;how many tools does my agent
        have?&rdquo; but &ldquo;what fraction of tools could it discover on
        demand versus what fraction must be in turn one?&rdquo; Teams celebrating
        growing tool catalogs the way Java teams once celebrated lines-of-code
        growth are optimizing the wrong metric. Tool count is not progress; it
        is liability.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Transferable Framework
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Even if you are not using Claude Code, this pattern generalizes to any
        tool-using LLM system:
      </p>

      <ol className="list-decimal pl-6 space-y-2 text-[15px] text-zinc-600 leading-relaxed mb-6">
        <li>
          <strong>Instrument tool-selection accuracy per session.</strong> If
          you are not measuring this, you are flying blind.
        </li>
        <li>
          <strong>Measure your tools-section token count</strong> and find your
          provider&rsquo;s threshold for attention degradation.
        </li>
        <li>
          <strong>Classify tools by frequency-of-use</strong> across real
          production sessions, not anticipated use.
        </li>
        <li>
          <strong>Provide an explicit discovery primitive</strong> (search or
          list-by-tag) so deferred tools remain findable without being resident.
        </li>
        <li>
          <strong>Write classification rules into a config file</strong> that
          gets reviewed at every change, preventing gradual core bloat.
        </li>
      </ol>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">
        The Prediction
      </h2>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Within twelve months, every mature MCP server framework&mdash;FastMCP,
        the official MCP SDK, and third-party hosters&mdash;will ship a
        &ldquo;core/deferred&rdquo; classification primitive in their tool
        registration API. Anthropic and OpenAI will document their explicit
        cliff thresholds instead of hiding them behind opaque behavior changes.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Teams currently running 50+ tool MCP servers without this discipline are
        quietly losing 15&ndash;30% of their tool-selection accuracy and lack
        the instrumentation to notice. The fix is architectural, not
        algorithmic. Hide your tools. Make them discoverable. Treat context
        window as the scarce resource it is.
      </p>

      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Your agent will thank you by making better decisions, faster.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mt-12 mb-4">FAQ</h2>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        Does this pattern work outside Claude Code?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Yes. Any LLM system with tool schemas in context suffers identical
        degradation past context limits. The specific token threshold varies by
        model, but the architectural pattern&mdash;resident core versus
        discoverable deferred&mdash;applies universally to high-tool-count
        systems.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        How do I know if I have hit the context cliff?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Instrument tool-selection accuracy per session. If you observe agents
        cycling between similar tools, selecting generic over specific tools, or
        requiring multiple correction turns, you have exceeded your model&rsquo;s
        in-context tool capacity.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        Isn&rsquo;t the search latency expensive?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        A cache miss costs one turn of discovery, but carrying 74 unused tools
        costs attention on every single turn. We observed net latency reduction
        because agents complete tasks in fewer total turns without thrashing
        between irrelevant options.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        Should I implement this for 20 tools?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Probably not. The cliff typically appears between 50&ndash;100 tools
        depending on schema complexity. Below 30 tools, the overhead of
        discovery infrastructure outweighs context savings. Above 50, the
        discipline becomes essential.
      </p>

      <h3 className="text-xl font-semibold text-zinc-900 mt-8 mb-3">
        How do agents know what to search for?
      </h3>
      <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
        Core tools include semantic discovery primitives. When an agent needs
        workflow functionality, it searches for &ldquo;workflow&rdquo; and
        receives relevant deferred tools. This mirrors human
        behavior&mdash;consulting documentation when specialized tools are
        needed.
      </p>
    </BlogPostLayout>
  );
}
