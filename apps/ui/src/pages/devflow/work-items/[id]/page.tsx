import type { ColDef } from "ag-grid-community";
import { Bot, CheckCircle2, RefreshCw, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type {
  DevFlowAgentMode,
  DevFlowAgentRun,
  DevFlowAuditEvent,
  DevFlowNfrDeclaration,
  DevFlowScope,
  DevFlowSpec,
  DevFlowWorkItem,
  DevFlowWorkItemType,
} from "@/api/devflow-types";
import {
  useDevFlowWorkItem,
  useReconcileDevFlowAgentRun,
  useSaveDevFlowScope,
  useSaveDevFlowSpec,
  useStartDevFlowAgentRun,
  useTransitionDevFlowWorkItem,
  useUpdateDevFlowWorkItem,
} from "@/api/hooks/use-devflow";
import { DevFlowStateBadge } from "@/components/devflow/devflow-state-badge";
import { DataGrid } from "@/components/shared/data-grid";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DetailPageBody,
  DetailPageRail,
  QuickStat,
  QuickStats,
  Relationship,
  Relationships,
} from "@/components/ui/detail-page-layout";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-row";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

const nfrCategories = [
  "supportability",
  "testability",
  "security",
  "scalability",
  "usability",
  "maintainability",
  "reliability",
  "observability",
  "performance",
] as const;

const lines = (value: string) =>
  value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

function WorkItemEditor({ item }: { item: DevFlowWorkItem }) {
  const update = useUpdateDevFlowWorkItem(item.id);
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [type, setType] = useState(item.type);
  const [priority, setPriority] = useState(item.priority ?? "p3");
  const [securitySensitive, setSecuritySensitive] = useState(item.isSecuritySensitive);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Work item</CardTitle>
        <CardDescription>
          Human-owned source of truth. Agent evidence is proposed into these fields.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SettingsRow label="Title" htmlFor="work-item-title">
          <Input
            id="work-item-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow label="Description" htmlFor="work-item-description">
          <Textarea
            id="work-item-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={6}
          />
        </SettingsRow>
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsRow label="Type" htmlFor="work-item-type">
            <Select value={type} onValueChange={(value) => setType(value as DevFlowWorkItemType)}>
              <SelectTrigger id="work-item-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["idea", "feature", "bug", "task", "architecture", "ops"] as const).map(
                  (value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow label="Priority" htmlFor="work-item-priority">
            <Select
              value={priority}
              onValueChange={(value) => setPriority(value as "p1" | "p2" | "p3")}
            >
              <SelectTrigger id="work-item-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="p1">P1 · urgent</SelectItem>
                <SelectItem value="p2">P2 · important</SelectItem>
                <SelectItem value="p3">P3 · standard</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </div>
        <SettingsRow
          label="Security-sensitive"
          htmlFor="work-item-security"
          helper="Gate 2 requires a threat model when enabled."
        >
          <Switch
            id="work-item-security"
            checked={securitySensitive}
            onCheckedChange={setSecuritySensitive}
          />
        </SettingsRow>
        <Button
          size="sm"
          onClick={() =>
            update.mutate({
              title,
              description,
              type,
              priority,
              isSecuritySensitive: securitySensitive,
            })
          }
          disabled={update.isPending}
        >
          <Save /> Save item
        </Button>
      </CardContent>
    </Card>
  );
}

function ScopeEditor({ itemId, scope }: { itemId: string; scope: DevFlowScope | null }) {
  const save = useSaveDevFlowScope(itemId);
  const [problem, setProblem] = useState(scope?.problemStatement ?? "");
  const [users, setUsers] = useState(scope?.targetUsers.join("\n") ?? "");
  const [success, setSuccess] = useState(scope?.successCriteria.join("\n") ?? "");
  const [effort, setEffort] = useState(scope?.effortBand ?? "m");
  const [questions, setQuestions] = useState(scope?.openQuestions.join("\n") ?? "");
  const [rationale, setRationale] = useState(scope?.rationale ?? "");
  const [confidence, setConfidence] = useState(scope?.confidence ?? 0.7);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scope evidence</CardTitle>
        <CardDescription>
          Gate 1 requires a problem, target users, success criteria, and effort band.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SettingsRow label="Problem statement" htmlFor="scope-problem">
          <Textarea
            id="scope-problem"
            value={problem}
            onChange={(event) => setProblem(event.target.value)}
            rows={4}
          />
        </SettingsRow>
        <div className="grid gap-4 lg:grid-cols-2">
          <SettingsRow label="Target users" htmlFor="scope-users" helper="One user group per line.">
            <Textarea
              id="scope-users"
              value={users}
              onChange={(event) => setUsers(event.target.value)}
              rows={4}
            />
          </SettingsRow>
          <SettingsRow
            label="Success criteria"
            htmlFor="scope-success"
            helper="One measurable outcome per line."
          >
            <Textarea
              id="scope-success"
              value={success}
              onChange={(event) => setSuccess(event.target.value)}
              rows={4}
            />
          </SettingsRow>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsRow label="Effort band" htmlFor="scope-effort">
            <Select
              value={effort}
              onValueChange={(value) => setEffort(value as DevFlowScope["effortBand"])}
            >
              <SelectTrigger id="scope-effort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["xs", "s", "m", "l", "xl"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {value.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow label="Confidence" htmlFor="scope-confidence">
            <Input
              id="scope-confidence"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={confidence}
              onChange={(event) => setConfidence(Number(event.target.value))}
            />
          </SettingsRow>
        </div>
        <SettingsRow
          label="Open questions"
          htmlFor="scope-questions"
          helper="One unresolved question per line."
        >
          <Textarea
            id="scope-questions"
            value={questions}
            onChange={(event) => setQuestions(event.target.value)}
            rows={3}
          />
        </SettingsRow>
        <SettingsRow label="Rationale" htmlFor="scope-rationale">
          <Textarea
            id="scope-rationale"
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            rows={3}
          />
        </SettingsRow>
        <Button
          size="sm"
          onClick={() =>
            save.mutate({
              problemStatement: problem,
              targetUsers: lines(users),
              successCriteria: lines(success),
              effortBand: effort,
              openQuestions: lines(questions),
              confidence,
              rationale,
            })
          }
          disabled={save.isPending}
        >
          <Save /> Save scope draft
        </Button>
      </CardContent>
    </Card>
  );
}

type NfrDraft = Record<string, { status: DevFlowNfrDeclaration["status"]; statement: string }>;

function SpecEditor({
  itemId,
  spec,
  blastRadius,
}: {
  itemId: string;
  spec: DevFlowSpec | null;
  blastRadius?: "low" | "medium" | "high";
}) {
  const save = useSaveDevFlowSpec(itemId);
  const [problem, setProblem] = useState(spec?.problemStatement ?? "");
  const [ux, setUx] = useState(spec?.uxBehavior ?? "");
  const [dataModel, setDataModel] = useState(spec?.dataModelChanges ?? "No data model changes.");
  const [integrations, setIntegrations] = useState(
    spec?.integrationPoints ?? "No external integrations.",
  );
  const [outOfScope, setOutOfScope] = useState(spec?.outOfScope ?? "");
  const [threatModel, setThreatModel] = useState(spec?.threatModel ?? "");
  const [rollback, setRollback] = useState(spec?.rollbackPlan ?? "");
  const [dependencies, setDependencies] = useState(spec?.dependencyMap.join("\n") ?? "");
  const [questions, setQuestions] = useState(spec?.openQuestions.join("\n") ?? "");
  const [blast, setBlast] = useState(blastRadius ?? "low");
  const [criteria, setCriteria] = useState(
    spec?.acceptanceCriteria
      .map((criterion) => `${criterion.given} | ${criterion.when} | ${criterion.then}`)
      .join("\n") ?? "",
  );
  const [nfrs, setNfrs] = useState<NfrDraft>(() =>
    Object.fromEntries(
      nfrCategories.map((category) => {
        const existing = spec?.nfrDeclarations.find((entry) => entry.category === category);
        return [
          category,
          { status: existing?.status ?? "pending", statement: existing?.statement ?? "" },
        ];
      }),
    ),
  );
  const acceptanceCriteria = lines(criteria).map((entry) => {
    const [given = "", when = "", then = ""] = entry.split("|").map((part) => part.trim());
    return {
      given,
      when,
      then,
      isTestable: Boolean(given && when && then),
      testHint: "Automate this scenario.",
    };
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Specification evidence{" "}
          {spec ? (
            <Badge variant="outline" size="tag">
              v{spec.version}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          Every save creates a new immutable version. Gate 2 validates ACs, all nine NFRs, risk, and
          blast radius.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SettingsRow label="Problem statement" htmlFor="spec-problem">
          <Textarea
            id="spec-problem"
            value={problem}
            onChange={(event) => setProblem(event.target.value)}
            rows={3}
          />
        </SettingsRow>
        <SettingsRow label="UX behavior" htmlFor="spec-ux">
          <Textarea
            id="spec-ux"
            value={ux}
            onChange={(event) => setUx(event.target.value)}
            rows={4}
          />
        </SettingsRow>
        <div className="grid gap-4 lg:grid-cols-2">
          <SettingsRow label="Data model changes" htmlFor="spec-data">
            <Textarea
              id="spec-data"
              value={dataModel}
              onChange={(event) => setDataModel(event.target.value)}
              rows={4}
            />
          </SettingsRow>
          <SettingsRow label="Integration points" htmlFor="spec-integrations">
            <Textarea
              id="spec-integrations"
              value={integrations}
              onChange={(event) => setIntegrations(event.target.value)}
              rows={4}
            />
          </SettingsRow>
        </div>
        <SettingsRow
          label="Acceptance criteria"
          htmlFor="spec-ac"
          helper="One per line: Given | When | Then"
        >
          <Textarea
            id="spec-ac"
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
            rows={6}
          />
        </SettingsRow>
        <div className="grid gap-4 lg:grid-cols-2">
          <SettingsRow label="Out of scope" htmlFor="spec-out">
            <Textarea
              id="spec-out"
              value={outOfScope}
              onChange={(event) => setOutOfScope(event.target.value)}
              rows={3}
            />
          </SettingsRow>
          <SettingsRow label="Open questions" htmlFor="spec-questions">
            <Textarea
              id="spec-questions"
              value={questions}
              onChange={(event) => setQuestions(event.target.value)}
              rows={3}
            />
          </SettingsRow>
          <SettingsRow label="Threat model" htmlFor="spec-threat">
            <Textarea
              id="spec-threat"
              value={threatModel}
              onChange={(event) => setThreatModel(event.target.value)}
              rows={3}
            />
          </SettingsRow>
          <SettingsRow label="Rollback plan" htmlFor="spec-rollback">
            <Textarea
              id="spec-rollback"
              value={rollback}
              onChange={(event) => setRollback(event.target.value)}
              rows={3}
            />
          </SettingsRow>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsRow label="Blast radius" htmlFor="spec-blast">
            <Select
              value={blast}
              onValueChange={(value) => setBlast(value as "low" | "medium" | "high")}
            >
              <SelectTrigger id="spec-blast">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["low", "medium", "high"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow
            label="Dependencies"
            htmlFor="spec-dependencies"
            helper="One dependency per line."
          >
            <Textarea
              id="spec-dependencies"
              value={dependencies}
              onChange={(event) => setDependencies(event.target.value)}
              rows={3}
            />
          </SettingsRow>
        </div>
        <section className="space-y-3" aria-labelledby="nfr-heading">
          <div>
            <h3 id="nfr-heading" className="text-sm font-semibold">
              Non-functional requirements
            </h3>
            <p className="text-xs text-muted-foreground">
              Resolve every category as addressed or not applicable before Gate 2.
            </p>
          </div>
          {nfrCategories.map((category) => (
            <div
              key={category}
              className="grid gap-2 rounded-lg border border-border-subtle p-3 sm:grid-cols-[160px_1fr]"
            >
              <Select
                value={nfrs[category]?.status}
                onValueChange={(status) =>
                  setNfrs((current) => ({
                    ...current,
                    [category]: {
                      ...current[category]!,
                      status: status as DevFlowNfrDeclaration["status"],
                    },
                  }))
                }
              >
                <SelectTrigger aria-label={`${category} status`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="addressed">Addressed</SelectItem>
                  <SelectItem value="not_applicable">Not applicable</SelectItem>
                </SelectContent>
              </Select>
              <Input
                aria-label={`${category} statement`}
                value={nfrs[category]?.statement ?? ""}
                onChange={(event) =>
                  setNfrs((current) => ({
                    ...current,
                    [category]: { ...current[category]!, statement: event.target.value },
                  }))
                }
                placeholder={`${category} requirement or reason it does not apply`}
              />
            </div>
          ))}
        </section>
        <Button
          size="sm"
          onClick={() =>
            save.mutate({
              problemStatement: problem,
              outOfScope,
              uxBehavior: ux,
              dataModelChanges: dataModel,
              integrationPoints: integrations,
              threatModel: threatModel || undefined,
              rollbackPlan: rollback || undefined,
              dependencyMap: lines(dependencies),
              openQuestions: lines(questions),
              acceptanceCriteria,
              nfrDeclarations: nfrCategories.map((category) => ({ category, ...nfrs[category]! })),
              blastRadius: blast,
            })
          }
          disabled={save.isPending || acceptanceCriteria.length === 0}
        >
          <Save /> Save spec version
        </Button>
      </CardContent>
    </Card>
  );
}

function AgentActions({
  item,
  scope,
  spec,
  runs,
}: {
  item: DevFlowWorkItem;
  scope: DevFlowScope | null;
  spec: DevFlowSpec | null;
  runs: DevFlowAgentRun[];
}) {
  const start = useStartDevFlowAgentRun(item.id);
  const reconcile = useReconcileDevFlowAgentRun(item.id);
  const transition = useTransitionDevFlowWorkItem(item.id);
  const mode: DevFlowAgentMode | null =
    item.state === "captured"
      ? "intake"
      : item.state === "triaged"
        ? "scope"
        : item.state === "scoped"
          ? "spec"
          : null;
  const active = runs.find((run) => ["queued", "running"].includes(run.status));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Next action</CardTitle>
        <CardDescription>
          Agents draft evidence. Gate decisions remain explicit human actions.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {mode ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => start.mutate(mode)}
            disabled={start.isPending || Boolean(active)}
          >
            <Bot /> {active ? `${active.mode} run ${active.status}` : `Run ${mode} agent`}
          </Button>
        ) : null}
        {active ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => reconcile.mutate(active.id)}
            disabled={reconcile.isPending}
          >
            <RefreshCw /> Reconcile run
          </Button>
        ) : null}
        {item.state === "triaged" && scope ? (
          <Button
            size="sm"
            onClick={() =>
              transition.mutate({
                toState: "scoped",
                rationale: "PM approved the scope in DevFlow.",
              })
            }
            disabled={transition.isPending}
          >
            <CheckCircle2 /> Approve Gate 1
          </Button>
        ) : null}
        {item.state === "scoped" && spec ? (
          <Button
            size="sm"
            onClick={() =>
              transition.mutate({
                toState: "specced",
                rationale: "Engineering lead approved the specification in DevFlow.",
              })
            }
            disabled={transition.isPending}
          >
            <CheckCircle2 /> Approve Gate 2
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function DevFlowWorkbenchPage() {
  const { id = "" } = useParams();
  const { data, isLoading, error } = useDevFlowWorkItem(id);
  const auditColumns = useMemo<ColDef<DevFlowAuditEvent>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Time",
        width: 180,
        valueFormatter: ({ value }) => new Date(value).toLocaleString(),
      },
      { field: "action", headerName: "Event", flex: 1, minWidth: 220 },
      { field: "actorKind", headerName: "Actor", width: 110 },
      { field: "afterState", headerName: "State", width: 120 },
    ],
    [],
  );
  const runColumns = useMemo<ColDef<DevFlowAgentRun>[]>(
    () => [
      { field: "mode", headerName: "Mode", width: 110 },
      { field: "status", headerName: "Status", width: 120 },
      { field: "swarmTaskId", headerName: "Swarm task", flex: 1, minWidth: 220 },
      {
        field: "lastUpdatedAt",
        headerName: "Updated",
        width: 180,
        valueFormatter: ({ value }) => new Date(value).toLocaleString(),
      },
    ],
    [],
  );

  if (isLoading) return <PageSkeleton />;
  if (error || !data) {
    return <AlertCallout tone="error">{error?.message ?? "Work item not found"}</AlertCallout>;
  }
  const { item, scope, spec, agentRuns, audit } = data;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="truncate">{item.title}</span>
            <DevFlowStateBadge state={item.state} />
          </span>
        }
        description="Review evidence, steer Agent Swarm work, and approve only when deterministic preconditions are satisfied."
      />
      <AgentActions item={item} scope={scope} spec={spec} runs={agentRuns} />
      <DetailPageBody
        main={
          <Tabs
            defaultValue={
              item.state === "captured" ? "item" : item.state === "triaged" ? "scope" : "spec"
            }
          >
            <TabsList>
              <TabsTrigger value="item">Item</TabsTrigger>
              <TabsTrigger value="scope">Scope</TabsTrigger>
              <TabsTrigger value="spec">Spec</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="item">
              <WorkItemEditor key={item.lastUpdatedAt} item={item} />
            </TabsContent>
            <TabsContent value="scope">
              <ScopeEditor key={scope?.lastUpdatedAt ?? "new"} itemId={item.id} scope={scope} />
            </TabsContent>
            <TabsContent value="spec">
              <SpecEditor
                key={spec?.id ?? "new"}
                itemId={item.id}
                spec={spec}
                blastRadius={item.blastRadius}
              />
            </TabsContent>
            <TabsContent value="activity" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Agent Swarm runs</CardTitle>
                  <CardDescription>
                    Execution-plane tasks and structured evidence status.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DataGrid
                    rowData={agentRuns}
                    columnDefs={runColumns}
                    domLayout="autoHeight"
                    pagination={false}
                    emptyMessage="No agent runs yet"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Audit trail</CardTitle>
                  <CardDescription>Immutable lifecycle, evidence, and gate events.</CardDescription>
                </CardHeader>
                <CardContent>
                  <DataGrid
                    rowData={audit}
                    columnDefs={auditColumns}
                    domLayout="autoHeight"
                    pagination={false}
                    emptyMessage="No audit events yet"
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        }
        rail={
          <DetailPageRail>
            <QuickStats>
              <QuickStat label="State" value={item.state.replace("_", " ")} />
              <QuickStat label="Type" value={item.type} />
              <QuickStat label="Priority" value={item.priority ?? "Unranked"} />
              <QuickStat label="Blast radius" value={item.blastRadius ?? "Unset"} />
            </QuickStats>
            <Relationships>
              <Relationship label="PM owner" to={`/people/${item.pmOwnerId}`}>
                {item.pmOwnerId.slice(0, 8)}
              </Relationship>
              {agentRuns[0]?.swarmTaskId ? (
                <Relationship label="Latest Swarm task" to={`/tasks/${agentRuns[0].swarmTaskId}`}>
                  {agentRuns[0].swarmTaskId.slice(0, 8)}
                </Relationship>
              ) : null}
            </Relationships>
          </DetailPageRail>
        }
      />
    </div>
  );
}
