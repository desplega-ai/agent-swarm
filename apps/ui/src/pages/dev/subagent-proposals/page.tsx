import { Bot, Check, ChevronRight, Circle, Search, Terminal } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { SessionLogRowShell } from "@/components/shared/session-log-viewer";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type AgentStatus = "running" | "completed";
type ViewKey = "logs" | "agents";

interface SubAgentSample {
  id: string;
  name: string;
  kind: string;
  status: AgentStatus;
  started: string;
  startedIso: string;
  finished?: string;
  duration: string;
  input: string;
  outcome?: string;
  dot: string;
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
    startedIso: "2026-08-04T06:30:40.000Z",
    finished: "06:32:03",
    duration: "1m 23s",
    input:
      "Navigate to news.ycombinator.com/newest and extract every story with title, URL, item ID, points, comments, and age.",
    outcome:
      "30 stories extracted successfully. Browser session d8f13c72 loaded 670 DOM elements and closed cleanly.",
    dot: "bg-action-agent-task",
    bar: "bg-action-agent-task/12 text-action-agent-task",
    timeline: "col-start-1 col-span-4",
  },
  {
    id: "toolu_019h",
    name: "Front-page navigator",
    kind: "qa-use:browser-navigator",
    status: "completed",
    started: "06:30:35",
    startedIso: "2026-08-04T06:30:35.000Z",
    finished: "06:32:47",
    duration: "2m 12s",
    input:
      "Navigate to news.ycombinator.com and return all front-page stories with full HN metadata and comments links.",
    outcome:
      "All 30 front-page stories returned with full metadata after loading 645 DOM elements in session 0682921f.",
    dot: "bg-action-script",
    bar: "bg-action-script/12 text-action-script",
    timeline: "col-start-1 col-span-6",
  },
  {
    id: "opencode_pi",
    name: "OpenCode + Pi evidence",
    kind: "research spike",
    status: "running",
    started: "15:32:18",
    startedIso: "2026-08-04T15:32:18.000Z",
    duration: "6m 12s",
    input:
      "Ground OpenCode and Pi sub-agent lifecycle feasibility in raw session_logs JSONL; enumerate exact searches and missing fields.",
    dot: "bg-action-notify",
    bar: "bg-action-notify/12 text-action-notify",
    timeline: "col-start-1 col-span-16",
  },
];

function AgentDot({ agent }: { agent: SubAgentSample }) {
  return (
    <span className="relative grid size-4 shrink-0 place-items-center" aria-hidden="true">
      <span className={cn("relative size-2 rounded-full", agent.dot)} />
    </span>
  );
}

function StatusText({ agent }: { agent: SubAgentSample }) {
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[10px]",
        agent.status === "running" ? "text-status-active-strong" : "text-status-success-strong",
      )}
    >
      {agent.status === "completed" && <Check className="mr-1 inline size-2.5" />}
      {agent.status}
    </span>
  );
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[72px_minmax(0,1fr)] sm:gap-4">
      <dt className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </dt>
      <dd className="m-0 text-[11.5px] leading-[1.6] text-foreground/85">{children}</dd>
    </div>
  );
}

function AgentLogRow({
  agent,
  open,
  onToggle,
}: {
  agent: SubAgentSample;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <SessionLogRowShell time={agent.started} iso={agent.startedIso}>
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-6 w-full min-w-0 cursor-pointer items-center gap-2 text-left"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <AgentDot agent={agent} />
        <span className="min-w-0 shrink truncate text-xs font-medium text-foreground">
          {agent.name}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground max-sm:hidden">
          {agent.kind}
        </span>
        <StatusText agent={agent} />
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {agent.duration}
        </span>
      </button>
      {open && (
        <dl className="mt-1.5 grid gap-2 border-t border-border/40 py-2 pr-2 sm:ml-9">
          <DetailField label="Input">{agent.input}</DetailField>
          <DetailField label="Outcome">
            {agent.outcome ?? "Running now. The outcome appears here when the harness returns."}
          </DetailField>
        </dl>
      )}
    </SessionLogRowShell>
  );
}

function ToolLogRow({
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
    <SessionLogRowShell time={time} iso={`2026-08-04T${time}.000Z`}>
      <div className="flex min-h-6 min-w-0 items-center gap-2">
        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
          <Terminal className="size-3" />
        </span>
        <span className="shrink-0 font-mono text-xs text-foreground">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
          {detail}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {duration}
        </span>
      </div>
    </SessionLogRowShell>
  );
}

function LogsView({
  expandedId,
  onToggleAgent,
}: {
  expandedId: string | null;
  onToggleAgent: (agentId: string) => void;
}) {
  return (
    <div className="min-h-0">
      <div className="flex items-center gap-2 border-b border-border/60 py-2">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
          Session logs
        </span>
        <span className="font-mono text-[9.5px] text-muted-foreground">18 events</span>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Filter mock session log"
            placeholder="Filter…"
            className="h-7 w-36 pl-7 text-xs shadow-none"
          />
        </div>
      </div>
      <div>
        <ToolLogRow time="06:30:34" name="bash" detail="qa-use browser list" duration="13s" />
        <AgentLogRow
          agent={agents[1]}
          open={expandedId === agents[1].id}
          onToggle={() => onToggleAgent(agents[1].id)}
        />
        <AgentLogRow
          agent={agents[0]}
          open={expandedId === agents[0].id}
          onToggle={() => onToggleAgent(agents[0].id)}
        />
        <ToolLogRow time="06:32:05" name="wait" detail="receiver thread state" duration="30s" />
        <AgentLogRow
          agent={agents[2]}
          open={expandedId === agents[2].id}
          onToggle={() => onToggleAgent(agents[2].id)}
        />
        <ToolLogRow time="15:38:30" name="bash" detail="rg session_logs lifecycle" duration="8s" />
      </div>
    </div>
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
        "grid w-full grid-cols-[190px_minmax(480px,1fr)_68px] items-center gap-4 border-b border-border/40 py-2 text-left transition-colors hover:bg-muted/30",
        selected && "bg-muted/25",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <AgentDot agent={agent} />
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium">{agent.name}</span>
          <span className="block truncate font-mono text-[9.5px] text-muted-foreground">
            {agent.kind}
          </span>
        </span>
      </span>
      <span className="grid h-7 grid-cols-16 items-center bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px)] bg-[size:25%_100%]">
        <span
          className={cn(
            "flex h-4 items-center rounded-sm px-2",
            agent.bar,
            agent.timeline,
            agent.status === "running" &&
              "after:ml-auto after:size-1.5 after:rounded-full after:bg-status-active",
          )}
        >
          <span className="truncate font-mono text-[9px] font-bold">{agent.duration}</span>
        </span>
      </span>
      <span className="text-right font-mono text-[9.5px] tabular-nums text-muted-foreground">
        {agent.finished ?? "now"}
      </span>
    </button>
  );
}

function AgentsView({
  selectedId,
  onSelectAgent,
}: {
  selectedId: string;
  onSelectAgent: (agentId: string) => void;
}) {
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  return (
    <div className="min-h-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 py-2 text-[10px] text-muted-foreground">
        <span className="font-mono uppercase tracking-[0.1em]">Agent waterfall</span>
        <span className="font-mono">6m 12s live window</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Circle className="size-2 fill-status-active text-status-active" /> 1 running
        </span>
      </div>
      <ScrollArea className="border-b border-border/60">
        <div className="min-w-[790px]">
          <div className="grid grid-cols-[190px_minmax(480px,1fr)_68px] gap-4 border-b border-border/40 py-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
            <span>Agent</span>
            <span className="grid grid-cols-4 tabular-nums">
              <span>0s</span>
              <span>2m</span>
              <span>4m</span>
              <span className="text-right">6m 12s</span>
            </span>
            <span className="text-right">End</span>
          </div>
          {agents.map((agent) => (
            <TimelineLane
              key={agent.id}
              agent={agent}
              selected={agent.id === selected.id}
              onSelect={() => onSelectAgent(agent.id)}
            />
          ))}
        </div>
        <ScrollBar orientation="horizontal" className="h-1.5" />
      </ScrollArea>
      <section className="grid gap-3 border-b border-border/40 py-3 sm:grid-cols-[190px_minmax(0,1fr)] sm:gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <AgentDot agent={selected} />
          <div className="min-w-0">
            <h3 className="truncate text-xs font-medium">{selected.name}</h3>
            <p className="mt-0.5 font-mono text-[9.5px] text-muted-foreground">{selected.id}</p>
            <p className="mt-2 flex items-center gap-2">
              <StatusText agent={selected} />
              <span className="font-mono text-[9.5px] text-muted-foreground">
                {selected.started} → {selected.finished}
              </span>
            </p>
          </div>
        </div>
        <dl className="grid content-start gap-2">
          <DetailField label="Input">{selected.input}</DetailField>
          <DetailField label="Outcome">{selected.outcome}</DetailField>
        </dl>
      </section>
    </div>
  );
}

function coerceView(value: string | null): ViewKey {
  return value === "agents" ? "agents" : "logs";
}

export default function SubAgentProposalsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = useMemo(() => coerceView(searchParams.get("view")), [searchParams]);
  const expandedId = searchParams.get("expanded");
  const selectedId = searchParams.get("selected") ?? agents[0].id;

  useEffect(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "light";
  }, []);

  const setView = (value: string) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set("view", coerceView(value));
      params.delete("expanded");
      return params;
    });
  };

  const toggleAgent = (agentId: string) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (params.get("expanded") === agentId) params.delete("expanded");
      else params.set("expanded", agentId);
      return params;
    });
  };

  const selectAgent = (agentId: string) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set("selected", agentId);
      return params;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" />
          <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
            Design review · combined direction
          </span>
        </div>
        <h1 className="mt-1.5 text-base font-semibold">
          Empirically verify the local setup and inspect harness lifecycle data
        </h1>
        <p className="mt-1 hidden text-xs text-muted-foreground sm:block">
          Child transcripts stay out of the task stream; lifecycle input and outcome remain one
          expansion away.
        </p>
      </header>

      <Tabs value={view} onValueChange={setView} className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="h-9 shrink-0 border-b border-border/60 p-0">
          <TabsTrigger value="logs" className="h-8 flex-none rounded-none px-3 text-xs">
            Logs
          </TabsTrigger>
          {agents.length > 0 && (
            <TabsTrigger value="agents" className="h-8 flex-none rounded-none px-3 text-xs">
              Agents{" "}
              <span className="font-mono text-[10px] text-muted-foreground">({agents.length})</span>
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="logs" className="min-h-0 overflow-auto">
          <LogsView expandedId={expandedId} onToggleAgent={toggleAgent} />
        </TabsContent>
        <TabsContent value="agents" className="min-h-0 overflow-auto">
          <AgentsView selectedId={selectedId} onSelectAgent={selectAgent} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
