import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AlertCircle, ArrowLeft, Plus, Save, Trash2, Unlink } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { RuntimePoolApiError } from "@/api/client";
import { useAgents } from "@/api/hooks/use-agents";
import {
  useBindAgentRuntimePool,
  useCreateRuntimePool,
  useCreateRuntimePoolAgent,
  useDeleteRuntimePool,
  useRuntimeControllers,
  useRuntimePool,
  useRuntimePoolRuntimes,
  useRuntimePools,
  useUpdateRuntimePool,
} from "@/api/hooks/use-runtime-pools";
import type {
  ProviderName,
  RuntimeController,
  RuntimeDeliveryMode,
  RuntimePool,
  RuntimePoolInput,
  RuntimePoolLifecycle,
  RuntimePoolRuntime,
  RuntimeProviderKind,
} from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { DataGrid } from "@/components/shared/data-grid";
import {
  duplicateKeys,
  KeyValueEditor,
  type KeyValueRow,
  recordFromRows,
  rowsFromRecord,
} from "@/components/shared/key-value-editor";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCallout } from "@/components/ui/alert-callout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { HARNESS_LABEL, LOCAL_HARNESSES } from "@/lib/agent-runtime-models";
import { formatRelative } from "@/lib/relative-time";
import {
  COMING_SOON_KINDS,
  deliveryLabel,
  isCircuitOpen,
  RUNTIME_DELIVERY_LABEL,
  RUNTIME_KIND_DESCRIPTION,
  RUNTIME_KIND_LABEL,
  RUNTIME_LIFECYCLE_LABEL,
  RUNTIME_LIFECYCLES,
  RUNTIME_PROVIDER_KINDS,
  RUNTIME_STATE_TONE,
  runtimeExternalId,
} from "@/lib/runtime-pools";
import { formatSmartTime } from "@/lib/utils";
import {
  PoolHealthBadge,
  RUNTIME_CONTROLLERS_PATH,
  RUNTIME_POOLS_PATH,
  RuntimePoolsGuard,
} from "./runtime-pools-shared";

type DeliveryChoice = RuntimeDeliveryMode | "default";

interface PoolForm {
  name: string;
  kind: RuntimeProviderKind;
  controllerId: string;
  image: string;
  lifecycle: RuntimePoolLifecycle;
  idleMinutes: string;
  slotsPerRuntime: string;
  minRuntimes: string;
  maxRuntimes: string;
  delivery: DeliveryChoice;
  ttlSec: string;
  cpu: string;
  memoryMb: string;
  enabled: boolean;
  env: KeyValueRow[];
}

type FormErrors = Partial<Record<keyof PoolForm, string>>;

function text(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function formFromPool(pool: RuntimePool | null, controllers: RuntimeController[]): PoolForm {
  if (!pool) {
    const kind: RuntimeProviderKind = "docker";
    return {
      name: "",
      kind,
      controllerId: controllers.find((c) => c.kind === kind)?.id ?? "",
      image: "",
      lifecycle: "idle",
      idleMinutes: "",
      slotsPerRuntime: "1",
      minRuntimes: "0",
      maxRuntimes: "",
      delivery: "default",
      ttlSec: "",
      cpu: "",
      memoryMb: "",
      enabled: true,
      env: [],
    };
  }
  return {
    name: pool.name,
    kind: pool.kind,
    controllerId: pool.placements[0] ?? "",
    image: pool.image ?? "",
    lifecycle: pool.lifecycle,
    idleMinutes: text(pool.idleMinutes),
    slotsPerRuntime: text(pool.slotsPerRuntime),
    minRuntimes: text(pool.minRuntimes),
    maxRuntimes: text(pool.maxRuntimes),
    delivery: pool.delivery ?? "default",
    ttlSec: text(pool.ttlSec),
    cpu: text(pool.resources?.cpu),
    memoryMb: text(pool.resources?.memoryMb),
    enabled: pool.enabled,
    env: rowsFromRecord(pool.env),
  };
}

/** Parse an optional integer field. `undefined` = invalid, `null` = blank. */
function optionalInt(value: string, min: number): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return parsed >= min ? parsed : undefined;
}

/** Mirrors the API rules: schema bounds, kind = controller kind, min <= max, static locks lifecycle. */
function validate(
  form: PoolForm,
  controllers: RuntimeController[],
): { errors: FormErrors; input: RuntimePoolInput | null } {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = "Enter a name.";
  else if (name.length > 200) errors.name = "Use 200 characters or fewer.";
  if (COMING_SOON_KINDS.has(form.kind)) errors.kind = "This provider is not available yet.";
  const controller = controllers.find((c) => c.id === form.controllerId);
  if (!controller) errors.controllerId = "Pick a controller.";
  else if (controller.kind !== form.kind)
    errors.controllerId = "The controller kind must equal the pool kind.";

  const slots = optionalInt(form.slotsPerRuntime, 1);
  if (slots === null || slots === undefined)
    errors.slotsPerRuntime = "Enter a whole number, 1 or more.";
  const min = optionalInt(form.minRuntimes, 0);
  if (min === null || min === undefined) errors.minRuntimes = "Enter a whole number, 0 or more.";
  const max = optionalInt(form.maxRuntimes, 0);
  if (max === undefined) errors.maxRuntimes = "Enter a whole number, or leave blank for no limit.";
  if (typeof min === "number" && typeof max === "number" && min > max)
    errors.minRuntimes = "Minimum must not exceed maximum.";
  const isStatic = form.kind === "static";
  const idle = isStatic ? null : optionalInt(form.idleMinutes, 1);
  if (idle === undefined) errors.idleMinutes = "Enter a whole number, 1 or more, or leave blank.";
  const ttl = optionalInt(form.ttlSec, 1);
  if (ttl === undefined) errors.ttlSec = "Enter a whole number, 1 or more, or leave blank.";
  const memoryMb = optionalInt(form.memoryMb, 1);
  if (memoryMb === undefined) errors.memoryMb = "Enter a whole number of MB, or leave blank.";
  const cpuText = form.cpu.trim();
  const cpu = cpuText ? Number(cpuText) : null;
  if (cpu !== null && !(Number.isFinite(cpu) && cpu > 0)) errors.cpu = "Enter a positive number.";
  const duplicates = duplicateKeys(form.env);
  if (duplicates.length > 0) errors.env = `Duplicate keys: ${duplicates.join(", ")}.`;

  if (Object.keys(errors).length > 0) return { errors, input: null };
  const resources = {
    ...(cpu !== null ? { cpu } : {}),
    ...(typeof memoryMb === "number" ? { memoryMb } : {}),
  };
  return {
    errors,
    input: {
      name,
      kind: form.kind,
      placements: [form.controllerId],
      image: form.image.trim() || null,
      lifecycle: isStatic ? "idle" : form.lifecycle,
      idleMinutes: isStatic || form.lifecycle !== "idle" ? null : (idle ?? null),
      slotsPerRuntime: slots as number,
      minRuntimes: min as number,
      maxRuntimes: max ?? null,
      delivery: form.delivery === "default" ? null : form.delivery,
      env: recordFromRows(form.env),
      resources: Object.keys(resources).length > 0 ? resources : null,
      ttlSec: ttl ?? null,
      enabled: form.enabled,
    },
  };
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-status-error-strong">{message}</p> : null;
}

function NumberField({
  id,
  label,
  value,
  onChange,
  error,
  helper,
  placeholder,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <SettingsRow label={label} htmlFor={id} helper={error ? undefined : helper}>
      <Input
        id={id}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        disabled={disabled}
        className="font-mono"
      />
      <FieldError message={error} />
    </SettingsRow>
  );
}

/** All pool fields. Create and edit share it; the parent owns the save. */
function PoolFields({
  form,
  setForm,
  errors,
  controllers,
}: {
  form: PoolForm;
  setForm: (next: PoolForm) => void;
  errors: FormErrors;
  controllers: RuntimeController[];
}) {
  const isStatic = form.kind === "static";
  const kindControllers = controllers.filter((c) => c.kind === form.kind);
  const set = <K extends keyof PoolForm>(key: K, value: PoolForm[K]) =>
    setForm({ ...form, [key]: value });

  function changeKind(kind: RuntimeProviderKind) {
    setForm({
      ...form,
      kind,
      controllerId: controllers.find((c) => c.kind === kind)?.id ?? "",
      ...(kind === "static" ? { lifecycle: "idle" as const, idleMinutes: "" } : {}),
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsRow label="Name" htmlFor="pool-name" required>
          <Input
            id="pool-name"
            value={form.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="docker-default"
            aria-invalid={Boolean(errors.name)}
          />
          <FieldError message={errors.name} />
        </SettingsRow>
        <SettingsRow
          label="Enabled"
          htmlFor="pool-enabled"
          helper="A disabled pool provisions nothing."
        >
          <Switch
            id="pool-enabled"
            checked={form.enabled}
            onCheckedChange={(checked) => set("enabled", checked)}
          />
        </SettingsRow>
        <SettingsRow
          label="Provider"
          htmlFor="pool-kind"
          helper={errors.kind ? undefined : RUNTIME_KIND_DESCRIPTION[form.kind]}
        >
          <Select value={form.kind} onValueChange={(v) => changeKind(v as RuntimeProviderKind)}>
            <SelectTrigger id="pool-kind" className="w-full" aria-invalid={Boolean(errors.kind)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RUNTIME_PROVIDER_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind} disabled={COMING_SOON_KINDS.has(kind)}>
                  {RUNTIME_KIND_LABEL[kind]}
                  {COMING_SOON_KINDS.has(kind) ? " (coming soon)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={errors.kind} />
        </SettingsRow>
        <SettingsRow
          label="Controller"
          htmlFor="pool-controller"
          helper={
            errors.controllerId
              ? undefined
              : kindControllers.length === 0
                ? `No ${RUNTIME_KIND_LABEL[form.kind]} controller yet. Add one on the Controllers tab.`
                : "Provisions and stops this pool's runtimes."
          }
        >
          <Select value={form.controllerId} onValueChange={(v) => set("controllerId", v)}>
            <SelectTrigger
              id="pool-controller"
              className="w-full"
              aria-invalid={Boolean(errors.controllerId)}
            >
              <SelectValue placeholder="Pick a controller" />
            </SelectTrigger>
            <SelectContent>
              {kindControllers.map((controller) => (
                <SelectItem key={controller.id} value={controller.id}>
                  {controller.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={errors.controllerId} />
        </SettingsRow>
        {!isStatic ? (
          <SettingsRow
            label="Image"
            htmlFor="pool-image"
            helper="Leave blank to use the swarm worker image."
            className="sm:col-span-2"
          >
            <Input
              id="pool-image"
              value={form.image}
              onChange={(event) => set("image", event.target.value)}
              placeholder="ghcr.io/desplega-ai/agent-swarm-worker:latest"
              className="font-mono"
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          label="Lifecycle"
          htmlFor="pool-lifecycle"
          helper={
            isStatic
              ? "Static pools always keep their workers."
              : "Keep runtimes while idle, or start one per task and stop it after."
          }
        >
          <Select
            value={isStatic ? "idle" : form.lifecycle}
            onValueChange={(v) => set("lifecycle", v as RuntimePoolLifecycle)}
            disabled={isStatic}
          >
            <SelectTrigger id="pool-lifecycle" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RUNTIME_LIFECYCLES.map((lifecycle) => (
                <SelectItem key={lifecycle} value={lifecycle}>
                  {RUNTIME_LIFECYCLE_LABEL[lifecycle]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <NumberField
          id="pool-idle-minutes"
          label="Idle minutes"
          value={isStatic ? "" : form.idleMinutes}
          onChange={(value) => set("idleMinutes", value)}
          error={errors.idleMinutes}
          helper="Stop an idle runtime after this long. Blank uses the swarm default."
          disabled={isStatic || form.lifecycle !== "idle"}
        />
        <SettingsRow
          label="Delivery"
          htmlFor="pool-delivery"
          helper="How runtimes learn about new work."
        >
          <Select value={form.delivery} onValueChange={(v) => set("delivery", v as DeliveryChoice)}>
            <SelectTrigger id="pool-delivery" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["default", "poll", "push"] as const).map((delivery) => (
                <SelectItem key={delivery} value={delivery}>
                  {RUNTIME_DELIVERY_LABEL[delivery]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <NumberField
          id="pool-slots"
          label="Slots per runtime"
          value={form.slotsPerRuntime}
          onChange={(value) => set("slotsPerRuntime", value)}
          error={errors.slotsPerRuntime}
          helper="Concurrent tasks one runtime takes."
        />
        <NumberField
          id="pool-min"
          label="Minimum runtimes"
          value={form.minRuntimes}
          onChange={(value) => set("minRuntimes", value)}
          error={errors.minRuntimes}
          helper="Runtimes kept warm."
        />
        <NumberField
          id="pool-max"
          label="Maximum runtimes"
          value={form.maxRuntimes}
          onChange={(value) => set("maxRuntimes", value)}
          error={errors.maxRuntimes}
          helper="Blank means no limit."
          placeholder="No limit"
        />
        <NumberField
          id="pool-ttl"
          label="TTL (seconds)"
          value={form.ttlSec}
          onChange={(value) => set("ttlSec", value)}
          error={errors.ttlSec}
          helper="Hard lifetime of one runtime. Blank means none."
        />
        <NumberField
          id="pool-cpu"
          label="CPU"
          value={form.cpu}
          onChange={(value) => set("cpu", value)}
          error={errors.cpu}
          helper="Cores per runtime. Blank uses the provider default."
        />
        <NumberField
          id="pool-memory"
          label="Memory (MB)"
          value={form.memoryMb}
          onChange={(value) => set("memoryMb", value)}
          error={errors.memoryMb}
          helper="Blank uses the provider default."
        />
      </div>
      <SettingsRow label="Environment" helper="Passed to every runtime in this pool. Not secret.">
        <KeyValueEditor rows={form.env} onChange={(env) => set("env", env)} label="Environment" />
        <FieldError message={errors.env} />
      </SettingsRow>
    </div>
  );
}

function CreateAgentDialog({
  poolId,
  open,
  onOpenChange,
}: {
  poolId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateRuntimePoolAgent(poolId);
  const [name, setName] = useState("");
  const [harness, setHarness] = useState<ProviderName | "default">("default");
  const [maxTasks, setMaxTasks] = useState("");
  const [isLead, setIsLead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const maxTasksValue = optionalInt(maxTasks, 1);
  const maxTasksInvalid = maxTasksValue === undefined || (maxTasksValue ?? 0) > 100;

  function reset() {
    setName("");
    setHarness("default");
    setMaxTasks("");
    setIsLead(false);
    setError(null);
  }

  function submit() {
    if (!name.trim() || maxTasksInvalid) return;
    setError(null);
    create.mutate(
      {
        name: name.trim(),
        ...(isLead ? { isLead: true } : {}),
        ...(harness !== "default" ? { harnessProvider: harness } : {}),
        ...(typeof maxTasksValue === "number" ? { maxTasks: maxTasksValue } : {}),
      },
      {
        onSuccess: (agent) => {
          toast.success(`Created ${agent.name}`);
          reset();
          onOpenChange(false);
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create agent on this pool</DialogTitle>
          <DialogDescription>
            The agent starts offline. It comes online when the pool starts a runtime for it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <SettingsRow label="Name" htmlFor="pool-agent-name" required>
            <Input
              id="pool-agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </SettingsRow>
          <SettingsRow label="Harness" htmlFor="pool-agent-harness">
            <Select
              value={harness}
              onValueChange={(v) => setHarness(v as ProviderName | "default")}
            >
              <SelectTrigger id="pool-agent-harness" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Swarm default</SelectItem>
                {LOCAL_HARNESSES.map((h) => (
                  <SelectItem key={h} value={h}>
                    {HARNESS_LABEL[h]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <NumberField
            id="pool-agent-max-tasks"
            label="Max tasks"
            value={maxTasks}
            onChange={setMaxTasks}
            error={
              maxTasksInvalid ? "Enter a whole number from 1 to 100, or leave blank." : undefined
            }
            helper="Blank uses the default."
          />
          <SettingsRow label="Lead" htmlFor="pool-agent-lead" helper="A swarm has one lead.">
            <Switch id="pool-agent-lead" checked={isLead} onCheckedChange={setIsLead} />
          </SettingsRow>
          {error ? (
            <AlertCallout tone="error" icon={AlertCircle}>
              {error}
            </AlertCallout>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || maxTasksInvalid || create.isPending}>
              {create.isPending ? "Creating…" : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
        {bound.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents are bound to this pool.</p>
        ) : (
          <ul className="divide-y divide-border-subtle" aria-label="Bound agents">
            {bound.map((agent) => (
              <li key={agent.id} className="flex items-center gap-3 py-2">
                <AgentLink agentId={agent.id} className="min-w-0 flex-1" />
                <Badge variant="outline" size="tag">
                  {agent.status}
                </Badge>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={bind.isPending}
                  onClick={() => setBinding(agent.id, null, `Unbound ${agent.name}`)}
                >
                  <Unlink className="h-4 w-4" />
                  Unbind
                </Button>
              </li>
            ))}
          </ul>
        )}
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
      </CardContent>
      <CreateAgentDialog poolId={pool.id} open={creating} onOpenChange={setCreating} />
    </Card>
  );
}

function RuntimesCard({
  poolId,
  controllers,
}: {
  poolId: string;
  controllers: RuntimeController[];
}) {
  const runtimes = useRuntimePoolRuntimes(poolId);
  const controllerNames = useMemo(
    () => new Map(controllers.map((c) => [c.id, c.name])),
    [controllers],
  );

  const columnDefs = useMemo<ColDef<RuntimePoolRuntime>[]>(
    () => [
      {
        headerName: "State",
        field: "status",
        width: 140,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<RuntimePoolRuntime>) =>
          p.data ? (
            <span className="flex items-center gap-1.5">
              <Badge variant="outline" size="tag" className={RUNTIME_STATE_TONE[p.data.status]}>
                {p.data.status}
              </Badge>
              {p.data.draining ? (
                <Badge variant="outline" size="tag">
                  draining
                </Badge>
              ) : null}
            </span>
          ) : null,
      },
      {
        headerName: "Agent",
        field: "agentId",
        flex: 1,
        minWidth: 160,
        cellRenderer: (p: ICellRendererParams<RuntimePoolRuntime>) =>
          p.data ? (
            <AgentLink agentId={p.data.agentId} onClick={(event) => event.stopPropagation()} />
          ) : null,
      },
      {
        headerName: "Controller",
        colId: "controller",
        width: 150,
        suppressSizeToFit: true,
        cellClass: "font-mono text-xs",
        valueGetter: (p) =>
          p.data?.controllerId
            ? (controllerNames.get(p.data.controllerId) ?? p.data.controllerId)
            : "",
      },
      {
        headerName: "External id",
        colId: "externalId",
        width: 160,
        suppressSizeToFit: true,
        cellClass: "font-mono text-xs",
        valueGetter: (p) => (p.data ? (runtimeExternalId(p.data) ?? "") : ""),
        tooltipValueGetter: (p) => (p.data ? runtimeExternalId(p.data) : null),
      },
      {
        headerName: "Attempts",
        field: "provisionAttempts",
        width: 100,
        suppressSizeToFit: true,
        cellClass: "ag-right-aligned-cell font-mono text-xs",
        headerClass: "ag-right-aligned-header",
        valueGetter: (p) => p.data?.provisionAttempts ?? 0,
      },
      {
        headerName: "Last error",
        field: "provisionError",
        flex: 1,
        minWidth: 180,
        cellClass: "text-xs text-status-error-strong",
        tooltipField: "provisionError",
      },
      {
        headerName: "Age",
        field: "createdAt",
        width: 110,
        suppressSizeToFit: true,
        cellClass: "text-xs text-muted-foreground",
        valueFormatter: (p) => (p.data ? formatRelative(p.data.createdAt) : ""),
      },
    ],
    [controllerNames],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Runtimes</CardTitle>
        <CardAction className="text-xs text-muted-foreground">Refreshes every 5 seconds</CardAction>
      </CardHeader>
      <CardContent>
        {runtimes.error ? (
          <AlertCallout tone="error" icon={AlertCircle}>
            Failed to load runtimes: {runtimes.error.message}
          </AlertCallout>
        ) : (
          <DataGrid
            rowData={runtimes.data}
            columnDefs={columnDefs}
            loading={runtimes.isLoading}
            domLayout="autoHeight"
            pagination={false}
            emptyMessage="No runtimes. They appear when the pool provisions one for a bound agent."
            getRowId={(p) => p.data.id}
          />
        )}
      </CardContent>
    </Card>
  );
}

function DeletePoolDialog({
  pool,
  open,
  onOpenChange,
}: {
  pool: RuntimePool;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const remove = useDeleteRuntimePool(pool.id);
  // A 409 means agents are still bound: the dialog then offers a forced delete.
  const [needsForce, setNeedsForce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setError(null);
    remove.mutate(needsForce, {
      onSuccess: () => {
        toast.success(`Deleted ${pool.name}`);
        onOpenChange(false);
        void navigate(RUNTIME_POOLS_PATH);
      },
      onError: (err) => {
        if (err instanceof RuntimePoolApiError && err.status === 409 && !needsForce) {
          setNeedsForce(true);
          return;
        }
        setError(err.message);
      },
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setNeedsForce(false);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {needsForce ? `${pool.name} has bound agents` : `Delete ${pool.name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {needsForce
              ? "Force delete unbinds every agent from this pool, then deletes the pool. Bind the agents to another pool to run them again."
              : "Deletes the pool. A pool with bound agents asks again before a forced delete."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <AlertCallout tone="error" icon={AlertCircle}>
            {error}
          </AlertCallout>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending}
            onClick={(event) => {
              // Keep the dialog open until the server answers.
              event.preventDefault();
              confirm();
            }}
          >
            {remove.isPending ? "Deleting…" : needsForce ? "Force delete" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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

function PoolDetail() {
  const { id } = useParams<{ id: string }>();
  const pool = useRuntimePool(id);
  const controllers = useRuntimeControllers();

  if ((id && pool.isLoading) || controllers.isLoading) return <PageSkeleton />;

  if (id && !pool.data) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-6">
        <PageHeader
          title="Runtime pool not found"
          action={
            <Button type="button" size="sm" variant="ghost" asChild>
              <Link to={RUNTIME_POOLS_PATH}>
                <ArrowLeft className="h-4 w-4" />
                Back
              </Link>
            </Button>
          }
        />
        {pool.error ? (
          <Alert variant="destructive">
            <AlertDescription>{pool.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>
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
