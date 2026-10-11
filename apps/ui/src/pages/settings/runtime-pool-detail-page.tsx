import { AlertCircle, ArrowLeft, Plus, Save, Trash2, Unlink } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { RuntimePoolApiError } from "@/api/client";
import { useAgents } from "@/api/hooks/use-agents";
import {
  useBindAgentRuntimePool,
  useCreateRuntimePool,
  useRuntimeControllers,
  useRuntimePool,
  useRuntimePools,
  useUpdateRuntimePool,
} from "@/api/hooks/use-runtime-pools";
import type { RuntimeController, RuntimePool } from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DetailPageBody,
  DetailPageRail,
  QuickStat,
  QuickStats,
  Relationship,
  Relationships,
} from "@/components/ui/detail-page-layout";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-row";
import { Skeleton } from "@/components/ui/skeleton";
import {
  deliveryLabel,
  isCircuitOpen,
  RUNTIME_KIND_LABEL,
  RUNTIME_LIFECYCLE_LABEL,
} from "@/lib/runtime-pools";
import { formatSmartTime } from "@/lib/utils";
import { CreateAgentDialog, DeletePoolDialog } from "./runtime-pool-dialogs";
import { formFromPool, PoolFields, type PoolForm, validate } from "./runtime-pool-fields";
import { RuntimesCard } from "./runtime-pool-runtimes-card";
import {
  PoolHealthBadge,
  RUNTIME_CONTROLLERS_PATH,
  RUNTIME_POOLS_PATH,
  RuntimePoolsGuard,
} from "./runtime-pools-shared";

/** Agents bound to the pool, with bind, unbind, and create. */
function BoundAgentsCard({ pool }: { pool: RuntimePool }) {
  const agents = useAgents();
  const pools = useRuntimePools();
  const bind = useBindAgentRuntimePool();
  const [creating, setCreating] = useState(false);
  const all = agents.data ?? [];
  const bound = all.filter((agent) => agent.runtimePoolId === pool.id);
  const others = all.filter((agent) => agent.runtimePoolId !== pool.id);
  const poolNames = new Map((pools.data ?? []).map((p) => [p.id, p.name]));

  function setBinding(agentId: string, poolId: string | null, done: string) {
    bind.mutate(
      { agentId, poolId },
      {
        onSuccess: () => toast.success(done),
        onError: (err) => toast.error(err.message),
      },
    );
  }

  let boundList: ReactNode;
  if (agents.isLoading) {
    boundList = <Skeleton className="h-16 w-full" />;
  } else if (agents.error) {
    boundList = (
      <AlertCallout tone="error" icon={AlertCircle}>
        Failed to load agents: {agents.error.message}
      </AlertCallout>
    );
  } else if (bound.length === 0) {
    boundList = <p className="text-sm text-muted-foreground">No agents are bound to this pool.</p>;
  } else {
    boundList = (
      <ul className="divide-y divide-border-subtle" aria-label="Bound agents">
        {bound.map((agent) => (
          <li key={agent.id} className="flex items-center gap-3 py-2">
            <AgentLink agentId={agent.id} className="min-w-0 flex-1" />
            <StatusBadge status={agent.status} />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={bind.isPending}
              aria-label={`Unbind ${agent.name}`}
              onClick={() => setBinding(agent.id, null, `Unbound ${agent.name}`)}
            >
              <Unlink className="h-4 w-4" />
              Unbind
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Agents</CardTitle>
        <CardAction>
          <Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Create agent
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {boundList}
        {agents.data ? (
          <SettingsRow label="Bind an agent" htmlFor="pool-bind-agent">
            <Select
              value=""
              onValueChange={(agentId) => {
                const agent = others.find((candidate) => candidate.id === agentId);
                setBinding(agentId, pool.id, `Bound ${agent?.name ?? "agent"} to ${pool.name}`);
              }}
              disabled={bind.isPending || others.length === 0}
            >
              <SelectTrigger id="pool-bind-agent" className="w-full sm:w-80">
                <SelectValue
                  placeholder={others.length === 0 ? "No other agents" : "Pick an agent"}
                />
              </SelectTrigger>
              <SelectContent>
                {others.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.runtimePoolId
                      ? ` (moves from ${poolNames.get(agent.runtimePoolId) ?? "another pool"})`
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        ) : null}
      </CardContent>
      <CreateAgentDialog poolId={pool.id} open={creating} onOpenChange={setCreating} />
    </Card>
  );
}

function PoolEditor({
  pool,
  controllers,
}: {
  pool: RuntimePool | null;
  controllers: RuntimeController[];
}) {
  const navigate = useNavigate();
  const create = useCreateRuntimePool();
  const update = useUpdateRuntimePool(pool?.id ?? "");
  const [form, setForm] = useState<PoolForm>(() => formFromPool(pool, controllers));
  const [showErrors, setShowErrors] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { errors, input } = validate(form, controllers);
  const shownErrors = showErrors ? errors : {};
  const saving = create.isPending || update.isPending;
  const controller = controllers.find((c) => c.id === pool?.placements[0]);

  function save() {
    setShowErrors(true);
    setSaveError(null);
    if (!input) return;
    if (!pool) {
      create.mutate(input, {
        onSuccess: (created) => {
          toast.success(`Created ${created.name}`);
          void navigate(`${RUNTIME_POOLS_PATH}/${created.id}`, { replace: true });
        },
        onError: (err) => setSaveError(err.message),
      });
      return;
    }
    update.mutate(input, {
      onSuccess: (saved) => {
        toast.success(`Saved ${saved.name}`);
        setForm(formFromPool(saved, controllers));
        setShowErrors(false);
      },
      onError: (err) => setSaveError(err.message),
    });
  }

  const header = (
    <PageHeader
      title={
        pool ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{pool.name}</span>
            <Badge variant="outline" size="tag">
              {RUNTIME_KIND_LABEL[pool.kind]}
            </Badge>
            {!pool.enabled ? (
              <Badge variant="outline" size="tag">
                Disabled
              </Badge>
            ) : null}
            <PoolHealthBadge pool={pool} />
          </span>
        ) : (
          "New runtime pool"
        )
      }
      description={
        pool
          ? `${RUNTIME_LIFECYCLE_LABEL[pool.lifecycle]} · ${deliveryLabel(pool.delivery)} delivery`
          : "Pick a provider and a controller, then size the pool."
      }
      action={
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" asChild>
            <Link to={RUNTIME_POOLS_PATH}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
          {pool ? (
            <Button
              type="button"
              size="sm"
              variant="destructive-outline"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          ) : null}
          <Button type="button" size="sm" onClick={save} disabled={saving}>
            {pool ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {saving ? "Saving…" : pool ? "Save" : "Create pool"}
          </Button>
        </div>
      }
    />
  );

  const main = (
    <div className="space-y-4">
      {saveError ? (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      ) : null}
      {pool?.lastError ? (
        <AlertCallout tone={isCircuitOpen(pool) ? "error" : "warning"} icon={AlertCircle}>
          <span className="font-mono text-xs break-all">{pool.lastError}</span>
        </AlertCallout>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Pool</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <PoolFields
              form={form}
              setForm={setForm}
              errors={shownErrors}
              controllers={controllers}
            />
          </form>
        </CardContent>
      </Card>
      {pool ? <BoundAgentsCard pool={pool} /> : null}
    </div>
  );

  const rail = pool ? (
    <DetailPageRail>
      <QuickStats title="Health">
        <QuickStat label="State" value={<PoolHealthBadge pool={pool} />} />
        <QuickStat label="Consecutive failures" value={pool.consecutiveFailures} mono />
        <QuickStat
          label="Circuit open until"
          value={
            isCircuitOpen(pool) && pool.circuitOpenUntil
              ? formatSmartTime(pool.circuitOpenUntil)
              : "Closed"
          }
        />
        <QuickStat
          label="Last error"
          value={pool.lastErrorAt ? formatSmartTime(pool.lastErrorAt) : "None"}
        />
      </QuickStats>
      <QuickStats title="Pool">
        <QuickStat
          label="Image"
          value={
            pool.resolvedImage ??
            pool.image ??
            (pool.kind === "static" ? "Not used" : "Swarm default")
          }
          mono
        />
        <QuickStat label="Created" value={formatSmartTime(pool.createdAt)} />
        <QuickStat label="Updated" value={formatSmartTime(pool.updatedAt)} />
      </QuickStats>
      <Relationships>
        <Relationship label="Controller" to={RUNTIME_CONTROLLERS_PATH}>
          {controller?.name ?? pool.placements[0]}
        </Relationship>
      </Relationships>
    </DetailPageRail>
  ) : undefined;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      {header}
      <DetailPageBody main={main} rail={rail} />
      {/* Full width: the runtimes grid has too many columns for the main column. */}
      {pool ? <RuntimesCard poolId={pool.id} controllers={controllers} /> : null}
      {pool ? (
        <DeletePoolDialog pool={pool} open={confirmDelete} onOpenChange={setConfirmDelete} />
      ) : null}
    </div>
  );
}

/** A page that cannot render the editor: a not-found pool or a failed load. */
function PoolLoadProblem({ description, error }: { description: string; error?: string }) {
  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader
        title="Runtime pool"
        description={description}
        action={
          <Button type="button" size="sm" variant="ghost" asChild>
            <Link to={RUNTIME_POOLS_PATH}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
        }
      />
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function PoolDetail() {
  const { id } = useParams<{ id: string }>();
  const pool = useRuntimePool(id);
  const controllers = useRuntimeControllers();

  if ((id && pool.isLoading) || controllers.isLoading) return <PageSkeleton />;

  if (id && !pool.data) {
    const notFound = pool.error instanceof RuntimePoolApiError && pool.error.status === 404;
    return notFound ? (
      <PoolLoadProblem description="This runtime pool does not exist. It may have been deleted." />
    ) : (
      <PoolLoadProblem
        description="The runtime pool could not be loaded."
        error={pool.error?.message ?? "Unknown error."}
      />
    );
  }

  // The controller pickers and the kind check need the controller list.
  if (controllers.error) {
    return (
      <PoolLoadProblem
        description="Runtime controllers could not be loaded."
        error={controllers.error.message}
      />
    );
  }

  // Remount on a different pool (or create -> saved) so the form state resets.
  return (
    <PoolEditor
      key={pool.data?.id ?? "new"}
      pool={pool.data ?? null}
      controllers={controllers.data ?? []}
    />
  );
}

/** Create (`/settings/runtime-pools/new`) or edit one runtime pool. */
export default function RuntimePoolDetailPage() {
  return (
    <RuntimePoolsGuard>
      <PoolDetail />
    </RuntimePoolsGuard>
  );
}
