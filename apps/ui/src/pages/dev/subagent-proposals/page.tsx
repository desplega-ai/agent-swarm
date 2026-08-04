import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  GanttChartSquare,
  ListTree,
  PanelRight,
  Search,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type AgentStatus = "running" | "completed";
type ProposalKey = "inline" | "roster" | "timeline";

interface SubAgentSample {
  id: string;
  name: string;
  kind: string;
  status: AgentStatus;
  started: string;
  finished?: string;
  duration: string;
  input: string;
  outcome?: string;
  mark: string;
  rail: string;
  bar: string;
  timeline: string;
}

const agents: SubAgentSample[] = [
  {
    id: "a072bf73",
    name: "Newest-page navigator",
    kind: "qa-use:browser-navigator",
    status: "completed",
    started: "06:30:40",
    finished: "06:32:03",
    duration: "1m 23s",
    input:
      "Navigate to news.ycombinator.com/newest and extract every story with title, URL, item ID, points, comments, and age.",
    outcome:
      "30 stories extracted successfully. Browser session d8f13c72 loaded 670 DOM elements and closed cleanly.",
    mark: "border-action-agent-task/40 bg-action-agent-task/10 text-action-agent-task",
    rail: "border-l-action-agent-task",
    bar: "border-action-agent-task/50 bg-action-agent-task/20",
    timeline: "col-start-1 col-span-4",
  },
  {
    id: "toolu_019h",
    name: "Front-page navigator",
    kind: "qa-use:browser-navigator",
    status: "completed",
    started: "06:30:35",
    finished: "06:32:47",
    duration: "2m 12s",
    input:
      "Navigate to news.ycombinator.com and return all front-page stories with full HN metadata and comments links.",
    outcome:
      "All 30 front-page stories returned with full metadata after loading 645 DOM elements in session 0682921f.",
    mark: "border-action-script/40 bg-action-script/10 text-action-script",
    rail: "border-l-action-script",
    bar: "border-action-script/50 bg-action-script/20",
    timeline: "col-start-1 col-span-6",
  },
  {
    id: "opencode_pi",
    name: "OpenCode + Pi evidence",
    kind: "research spike",
    status: "running",
    started: "15:32:18",
    duration: "6m 12s",
    input:
      "Ground OpenCode and Pi sub-agent lifecycle feasibility in raw session_logs JSONL; enumerate exact searches and missing fields.",
    mark: "border-action-notify/40 bg-action-notify/10 text-action-notify",
    rail: "border-l-action-notify",
    bar: "border-action-notify/50 bg-action-notify/20",
    timeline: "col-start-1 col-span-16",
  },
];

const proposalMeta: Record<
  ProposalKey,
  { title: string; description: string; cost: string; icon: typeof ListTree }
> = {
  inline: {
    title: "Inline lifecycle cards",
    description:
      "The running hand-off stays pinned above causal history; completed agents remain beside the tool calls that created them.",
    cost: "FE-only: Claude/OpenCode · backend for full coverage",
    icon: ListTree,
  },
  roster: {
    title: "Agent roster rail",
    description:
      "A quiet operational lane keeps running agents visible while the transcript remains unchanged.",
    cost: "Backend lifecycle index",
    icon: PanelRight,
  },
  timeline: {
    title: "Agent waterfall",
    description:
      "Parallelism and duration become the primary view; input and outcome sit in a selected detail pane.",
    cost: "Backend lifecycle index + stable IDs",
    icon: GanttChartSquare,
  },
};

function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <Badge
      variant="outline"
      size="tag"
      className={cn(
        status === "running"
          ? "border-status-active/30 text-status-active-strong"
          : "border-status-success/30 text-status-success-strong",
      )}
    >
      {status === "running" ? (
        <span className="size-1.5 rounded-full bg-status-active" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="size-2.5" aria-hidden="true" />
      )}
      {status}
    </Badge>
  );
}

function AgentMark({ agent, compact = false }: { agent: SubAgentSample; compact?: boolean }) {
  const initials = agent.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-md border font-mono font-bold",
        compact ? "size-6 text-[9px]" : "size-8 text-[10px]",
        agent.mark,
      )}
      role="img"
      aria-label={`${agent.name} colour marker`}
    >
      {initials}
    </span>
  );
}

function FieldBlock({
  label,
  children,
  compact = false,
}: {
  label: string;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-surface px-3 py-2.5">
      <h4 className="mb-1 font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </h4>
      <p className={cn("text-xs leading-relaxed text-foreground/85", compact && "line-clamp-2")}>
        {children}
      </p>
    </section>
  );
}

function ProposalIntro({ proposal }: { proposal: ProposalKey }) {
  const meta = proposalMeta[proposal];
  const Icon = meta.icon;
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-muted/25 px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-[220px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{meta.title}</h2>
          <Badge variant="outline" size="tag" className="text-muted-foreground">
            {meta.cost}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{meta.description}</p>
      </div>
      <p className="max-w-sm text-[10px] leading-relaxed text-muted-foreground">
        Lifecycle content is copied from raw Claude Task rows; surrounding tool density is
        benchmarked against tasks <span className="font-mono">6ea7735f</span> and{" "}
        <span className="font-mono">9936a794</span>.
      </p>
    </div>
  );
}

function MockTaskHeader() {
  return (
    <header className="shrink-0 border-b border-border bg-background px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          size="tag"
          className="border-status-success/30 text-status-success-strong"
        >
          <CheckCircle2 className="size-2.5" /> completed
        </Badge>
        <Badge variant="outline" size="tag">
          research
        </Badge>
        <Badge variant="outline" size="tag">
          codex
        </Badge>
        <Badge variant="outline" size="tag">
          claude
        </Badge>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          raw sample · 2b213b5c
        </span>
      </div>
      <h1 className="mt-2 line-clamp-1 text-sm font-semibold">
        Empirically verify the local setup and inspect the harness lifecycle data
      </h1>
      <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
        Real source density from the reported Codex and Claude transcripts; no child transcripts
        shown.
      </p>
    </header>
  );
}

function ToolLine({
  time,
  name,
  detail,
  duration,
}: {
  time: string;
  name: string;
  detail: string;
  duration: string;
}) {
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 border-b border-border/50 px-3 py-2 last:border-b-0">
      <span className="pt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
        {time}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        <Terminal className="size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-xs font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
          {detail}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{duration}</span>
      </div>
    </div>
  );
}

function TranscriptToolbar({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/25 px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        Session logs
      </span>
      {children}
      <div className="relative ml-auto">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Filter mock session log"
          placeholder="Filter…"
          className="h-7 w-36 pl-7 text-xs"
        />
      </div>
    </div>
  );
}

function InlineAgentCard({ agent }: { agent: SubAgentSample }) {
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 border-b border-border/50 px-3 py-2.5">
      <span className="pt-1 font-mono text-[10px] tabular-nums text-muted-foreground">
        {agent.started}
      </span>
      <article
        className={cn(
          "overflow-hidden rounded-lg border border-border border-l-2 bg-card",
          agent.rail,
        )}
      >
        <div className="flex min-w-0 items-center gap-2 px-3 py-2">
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          <AgentMark agent={agent} compact />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-semibold">{agent.name}</span>
              <span className="hidden truncate font-mono text-[9px] text-muted-foreground sm:block">
                {agent.kind}
              </span>
            </div>
          </div>
          <StatusPill status={agent.status} />
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {agent.duration}
          </span>
        </div>
        <div className="grid gap-2 border-t border-border bg-muted/15 p-2.5 md:grid-cols-2">
          <FieldBlock label="Input" compact>
            {agent.input}
          </FieldBlock>
          <FieldBlock label={agent.status === "running" ? "Outcome" : "Outcome · returned"} compact>
            {agent.outcome ??
              "Still running. Outcome will appear here when the harness returns it."}
          </FieldBlock>
        </div>
      </article>
    </div>
  );
}

function InlineProposal() {
  return (
    <Card className="h-full min-h-0 gap-0 overflow-hidden py-0">
      <MockTaskHeader />
      <TranscriptToolbar>
        <Badge variant="outline" size="tag" className="text-muted-foreground">
          3 agents
        </Badge>
      </TranscriptToolbar>
      <div className="min-h-0 flex-1 overflow-auto">
        <InlineAgentCard agent={agents[2]} />
        <ToolLine time="06:30:34" name="bash" detail="qa-use browser list" duration="13s" />
        <InlineAgentCard agent={agents[1]} />
        <InlineAgentCard agent={agents[0]} />
        <ToolLine time="06:32:05" name="wait" detail="receiver thread state" duration="30s" />
      </div>
      <div className="flex items-center gap-2 border-t border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <span className="size-2 rounded-full bg-status-active" />1 child agent is running
        <span className="ml-auto font-mono text-[10px]">7 lifecycle events</span>
      </div>
    </Card>
  );
}

function RosterCard({
  agent,
  selected,
  onSelect,
}: {
  agent: SubAgentSample;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border border-border border-l-2 bg-background p-2.5 text-left transition-colors hover:bg-muted/30",
        agent.rail,
        selected && "ring-2 ring-ring/30",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AgentMark agent={agent} compact />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{agent.name}</span>
        <StatusPill status={agent.status} />
      </div>
      <div className="mt-2 flex items-center gap-2 pl-8 font-mono text-[9px] text-muted-foreground">
        <span>{agent.kind}</span>
        <span aria-hidden="true">·</span>
        <span>
          {agent.status === "running" ? `running ${agent.duration}` : `finished ${agent.finished}`}
        </span>
      </div>
    </button>
  );
}

function RosterProposal() {
  const [selectedId, setSelectedId] = useState(agents[2].id);
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  return (
    <Card className="h-full min-h-0 gap-0 overflow-hidden py-0">
      <MockTaskHeader />
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_154px]">
        <div className="grid min-h-0 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="flex min-h-0 flex-col overflow-hidden border-r border-border">
            <TranscriptToolbar />
            <div className="min-h-0 flex-1 overflow-auto">
              <ToolLine time="13:43:00" name="bash" detail="bun test packages/cli" duration="13s" />
              <ToolLine
                time="13:48:27"
                name="bash"
                detail="pipe backpressure reproduction"
                duration="14s"
              />
              <ToolLine
                time="13:51:02"
                name="bash"
                detail="writeSync retry verification"
                duration="2m 3s"
              />
              <ToolLine time="13:55:47" name="wait" detail="receiver thread state" duration="30s" />
              <div className="px-3 py-5 text-center text-xs text-muted-foreground">
                Child transcripts stay out of this stream.
              </div>
            </div>
          </section>
          <aside className="min-h-0 overflow-auto bg-muted/10">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <Activity className="size-3.5 text-muted-foreground" />
              <h2 className="text-xs font-semibold">Sub-agents</h2>
              <Badge
                variant="outline"
                size="tag"
                className="ml-auto border-status-active/30 text-status-active-strong"
              >
                1 running
              </Badge>
            </div>
            <div className="grid gap-2 p-3">
              {[agents[2], agents[0], agents[1]].map((agent) => (
                <RosterCard
                  key={agent.id}
                  agent={agent}
                  selected={selected.id === agent.id}
                  onSelect={() => setSelectedId(agent.id)}
                />
              ))}
            </div>
          </aside>
        </div>
        <section className="grid min-h-0 grid-cols-[210px_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-t border-border bg-background p-3">
          <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-muted/20 p-3">
            <AgentMark agent={selected} compact />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-xs font-semibold">{selected.name}</h3>
              <p className="font-mono text-[9px] text-muted-foreground">{selected.id}</p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <StatusPill status={selected.status} />
                <span className="font-mono text-[10px] text-muted-foreground">
                  {selected.duration}
                </span>
              </div>
            </div>
          </div>
          <FieldBlock label="Input">{selected.input}</FieldBlock>
          <FieldBlock label="Outcome">
            {selected.outcome ?? "Running now. The returned outcome will replace this live state."}
          </FieldBlock>
        </section>
      </div>
    </Card>
  );
}

function TimelineLane({
  agent,
  selected,
  onSelect,
}: {
  agent: SubAgentSample;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid grid-cols-[180px_minmax(480px,1fr)_64px] items-center gap-3 border-b border-border/50 px-3 py-2 text-left last:border-b-0 hover:bg-muted/30",
        selected && "bg-primary/5",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <AgentMark agent={agent} compact />
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold">{agent.name}</span>
          <span className="block truncate font-mono text-[9px] text-muted-foreground">
            {agent.kind}
          </span>
        </span>
      </span>
      <span className="grid h-8 grid-cols-16 items-center rounded-md bg-muted/40 px-1">
        <span
          className={cn(
            "flex h-5 items-center rounded border px-2",
            agent.bar,
            agent.timeline,
            agent.status === "running" && "border-r-2 border-r-status-active",
          )}
        >
          <span className="truncate font-mono text-[9px] font-medium">{agent.duration}</span>
        </span>
      </span>
      <span className="text-right font-mono text-[9px] text-muted-foreground">
        {agent.finished ?? "now"}
      </span>
    </button>
  );
}

function TimelineProposal() {
  const [selectedId, setSelectedId] = useState(agents[0].id);
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  return (
    <Card className="h-full min-h-0 gap-0 overflow-hidden py-0">
      <MockTaskHeader />
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2.5">
        <GanttChartSquare className="size-3.5 text-muted-foreground" />
        <h2 className="text-xs font-semibold">Sub-agent waterfall</h2>
        <span className="font-mono text-[10px] text-muted-foreground">6m 12s live window</span>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-muted-foreground">
          {agents.map((agent) => (
            <span key={agent.id} className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-sm border", agent.mark)} />
              {agent.name.replace(" navigator", "")}
            </span>
          ))}
        </div>
      </div>
      <ScrollArea className="shrink-0 border-b border-border">
        <div className="min-w-[820px]">
          <div className="grid grid-cols-[180px_minmax(480px,1fr)_64px] gap-3 border-b border-border/50 px-3 py-1.5">
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              Agent
            </span>
            <span className="grid grid-cols-4 font-mono text-[9px] tabular-nums text-muted-foreground">
              <span>0s</span>
              <span>2m</span>
              <span>4m</span>
              <span className="text-right">6m 12s</span>
            </span>
            <span className="text-right font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              End
            </span>
          </div>
          {agents.map((agent) => (
            <TimelineLane
              key={agent.id}
              agent={agent}
              selected={agent.id === selected.id}
              onSelect={() => setSelectedId(agent.id)}
            />
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <div className="grid min-h-0 flex-1 gap-3 overflow-auto p-3 md:grid-cols-[220px_minmax(0,1fr)]">
        <section className="rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex items-center gap-2">
            <AgentMark agent={selected} />
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold">{selected.name}</h3>
              <p className="font-mono text-[9px] text-muted-foreground">{selected.id}</p>
            </div>
          </div>
          <div className="mt-3 grid gap-1.5 text-[10px]">
            <p className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <StatusPill status={selected.status} />
            </p>
            <p className="flex justify-between">
              <span className="text-muted-foreground">Started</span>
              <span className="font-mono">{selected.started}</span>
            </p>
            <p className="flex justify-between">
              <span className="text-muted-foreground">Finished</span>
              <span className="font-mono">{selected.finished ?? "—"}</span>
            </p>
            <p className="flex justify-between">
              <span className="text-muted-foreground">Duration</span>
              <span className="font-mono">{selected.duration}</span>
            </p>
          </div>
        </section>
        <div className="grid content-start gap-3 md:grid-cols-2">
          <FieldBlock label="Input">{selected.input}</FieldBlock>
          <FieldBlock label="Outcome">
            {selected.outcome ??
              "Still running. The timeline extends to the current time until completion."}
          </FieldBlock>
        </div>
      </div>
    </Card>
  );
}

function coerceProposal(value: string | null): ProposalKey {
  return value === "roster" || value === "timeline" ? value : "inline";
}

export default function SubAgentProposalsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const proposal = useMemo(() => coerceProposal(searchParams.get("proposal")), [searchParams]);

  useEffect(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "light";
  }, []);

  const setProposal = (value: string) => {
    const next = coerceProposal(value);
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set("proposal", next);
      return params;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <div className="min-w-[240px] flex-1">
          <div className="flex items-center gap-2">
            <Bot className="size-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Sub-agent tracking proposals</h1>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Three product-native directions · design review only · light mode
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs">
          <Clock3 className="size-3.5 text-muted-foreground" />
          <span>
            <strong>1</strong> running
          </span>
          <span className="text-muted-foreground">·</span>
          <span>
            <strong>2</strong> completed
          </span>
        </div>
      </div>

      <Tabs
        value={proposal}
        onValueChange={setProposal}
        className="flex min-h-0 flex-1 flex-col gap-2"
      >
        <TabsList className="shrink-0">
          <TabsTrigger value="inline">
            <ListTree /> A · Inline
          </TabsTrigger>
          <TabsTrigger value="roster">
            <PanelRight /> B · Roster rail
          </TabsTrigger>
          <TabsTrigger value="timeline">
            <GanttChartSquare /> C · Waterfall
          </TabsTrigger>
        </TabsList>
        <ProposalIntro proposal={proposal} />
        <TabsContent value="inline" className="mt-0 min-h-0 flex-1">
          <InlineProposal />
        </TabsContent>
        <TabsContent value="roster" className="mt-0 min-h-0 flex-1">
          <RosterProposal />
        </TabsContent>
        <TabsContent value="timeline" className="mt-0 min-h-0 flex-1">
          <TimelineProposal />
        </TabsContent>
      </Tabs>
    </div>
  );
}
