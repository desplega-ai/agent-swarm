import type {
  RuntimeController,
  RuntimeDeliveryMode,
  RuntimePool,
  RuntimePoolInput,
  RuntimePoolLifecycle,
  RuntimeProviderKind,
} from "@/api/types";
import {
  duplicateKeys,
  KeyValueEditor,
  type KeyValueRow,
  recordFromRows,
  rowsFromRecord,
} from "@/components/shared/key-value-editor";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-row";
import { Switch } from "@/components/ui/switch";
import {
  COMING_SOON_KINDS,
  RUNTIME_DELIVERY_LABEL,
  RUNTIME_KIND_DESCRIPTION,
  RUNTIME_KIND_LABEL,
  RUNTIME_LIFECYCLE_LABEL,
  RUNTIME_LIFECYCLES,
  RUNTIME_PROVIDER_KINDS,
} from "@/lib/runtime-pools";

type DeliveryChoice = RuntimeDeliveryMode | "default";

export interface PoolForm {
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

export type FormErrors = Partial<Record<keyof PoolForm, string>>;

function text(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export function formFromPool(pool: RuntimePool | null, controllers: RuntimeController[]): PoolForm {
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
export function optionalInt(value: string, min: number): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return parsed >= min ? parsed : undefined;
}

/** Mirrors the API rules: schema bounds, kind = controller kind, min <= max, static locks lifecycle. */
export function validate(
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
  if (!isStatic && !form.image.trim())
    errors.image =
      form.kind === "e2b" ? "Enter an E2B template or docker:// image." : "Enter an image.";
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

/** Id of the error line under a field, for the control's `aria-describedby`. */
export function errorId(fieldId: string): string {
  return `${fieldId}-error`;
}

/** The control props that tie a field to its error line. */
export function errorProps(fieldId: string, error: string | undefined) {
  return {
    "aria-invalid": Boolean(error),
    "aria-describedby": error ? errorId(fieldId) : undefined,
  };
}

export function FieldError({ fieldId, message }: { fieldId: string; message?: string }) {
  return message ? (
    <p id={errorId(fieldId)} className="text-xs text-status-error-strong">
      {message}
    </p>
  ) : null;
}

export function NumberField({
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
        disabled={disabled}
        className="font-mono"
        {...errorProps(id, error)}
      />
      <FieldError fieldId={id} message={error} />
    </SettingsRow>
  );
}

/** All pool fields. Create and edit share it; the parent owns the save. */
export function PoolFields({
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
            {...errorProps("pool-name", errors.name)}
          />
          <FieldError fieldId="pool-name" message={errors.name} />
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
            <SelectTrigger
              id="pool-kind"
              className="w-full"
              {...errorProps("pool-kind", errors.kind)}
            >
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
          <FieldError fieldId="pool-kind" message={errors.kind} />
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
              {...errorProps("pool-controller", errors.controllerId)}
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
          <FieldError fieldId="pool-controller" message={errors.controllerId} />
        </SettingsRow>
        {!isStatic ? (
          <SettingsRow
            label="Image"
            htmlFor="pool-image"
            helper={
              form.kind === "e2b"
                ? "An E2B template name, or a docker:// image to build a template from."
                : "The worker image this pool starts. It must extend an Agent Swarm worker image."
            }
            className="sm:col-span-2"
          >
            <Input
              id="pool-image"
              value={form.image}
              onChange={(event) => set("image", event.target.value)}
              placeholder="ghcr.io/desplega-ai/agent-swarm-worker:latest"
              className="font-mono"
              {...errorProps("pool-image", errors.image)}
            />
            <FieldError fieldId="pool-image" message={errors.image} />
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
        <FieldError fieldId="pool-env" message={errors.env} />
      </SettingsRow>
    </div>
  );
}
