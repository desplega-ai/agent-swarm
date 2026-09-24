import { Bot, House, ListTodo, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { type UpsertConfigEntry, useConfigs } from "@/api/hooks/use-config-api";
import { useStatus } from "@/api/hooks/use-status";
import { SetupCard, SetupChip } from "@/components/onboarding/setup-card";
import { useSetupSave } from "@/components/onboarding/use-setup-save";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { AVATAR_COLOR_INPUT_FALLBACK, AVATAR_SUGGESTED_SWATCHES } from "@/lib/agent-color";
import { cn } from "@/lib/utils";
import { DEFAULT_SWARM_NAME, initialSwarmName } from "../components/swarm-name";
import type { StepProps } from "../step-contract";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const URL_RE = /^https?:\/\/\S+$/;

export function StepName({ onboarding, act, goNext }: StepProps) {
  // The shell's top bar polls `/status`; this read shares its cache.
  const { data: status } = useStatus({ pollIntervalMs: 0 });
  const { data: configs } = useConfigs({ scope: "global" });
  // Reloads the API after the write, which also refreshes `/status`.
  const setupSave = useSetupSave();
  const identity = status?.identity;
  const storedName = configs?.find((c) => c.key === "SWARM_ORG_NAME")?.value;

  // `null` = untouched: follow the server value until the operator types.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [logoDraft, setLogoDraft] = useState<string | null>(null);
  const [colorDraft, setColorDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = nameDraft ?? initialSwarmName(storedName, identity?.name);
  const logoInput = logoDraft ?? identity?.logo_url ?? "";
  const colorInput = colorDraft ?? identity?.brand_color ?? "";
  const trimmedName = name.trim();
  const logo = logoInput.trim();
  const color = colorInput.trim();
  const logoValid = logo === "" || URL_RE.test(logo);
  const colorValid = color === "" || HEX_RE.test(color);
  const dirty = nameDraft !== null || logoDraft !== null || colorDraft !== null;
  const saved = onboarding.state.steps.name.status === "done" && !dirty;

  async function handleSave() {
    if (!trimmedName || !logoValid || !colorValid || saving) return;
    setSaving(true);
    setError(null);
    const entries: UpsertConfigEntry[] = [
      { key: "SWARM_ORG_NAME", value: trimmedName },
      ...(logo ? [{ key: "SWARM_ORG_LOGO_URL", value: logo }] : []),
      ...(color ? [{ key: "SWARM_BRAND_COLOR", value: color }] : []),
    ].map((entry) => ({ ...entry, isSecret: false }));
    try {
      // A failed write is already reported by the save hook's toast.
      if (!(await setupSave.save(entries))) return;
      await act({
        action: "complete",
        step: "name",
        method: trimmedName === DEFAULT_SWARM_NAME ? "default_name" : "custom_name",
      });
      goNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record this step.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid items-start gap-3 sm:grid-cols-2">
      <SetupCard
        title="Identity"
        status={
          <SetupChip tone={saved ? "success" : "neutral"}>{saved ? "Saved" : "Unsaved"}</SetupChip>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <SettingsRow label="Swarm name" htmlFor="setup-swarm-name" required>
            <Input
              id="setup-swarm-name"
              value={name}
              onChange={(event) => setNameDraft(event.target.value)}
              aria-invalid={!trimmedName}
              disabled={saving}
            />
          </SettingsRow>

          <SettingsRow
            label="Logo URL"
            htmlFor="setup-logo-url"
            helper={
              logoValid ? (
                "Optional. Falls back to the hive mark."
              ) : (
                <span className="text-status-error-strong">Start with http:// or https://.</span>
              )
            }
          >
            <Input
              id="setup-logo-url"
              inputMode="url"
              spellCheck={false}
              placeholder="https://acme.dev/mark.png"
              value={logoInput}
              onChange={(event) => setLogoDraft(event.target.value)}
              aria-invalid={!logoValid}
              disabled={saving}
              className="font-mono"
            />
          </SettingsRow>

          <SettingsRow
            label="Brand color"
            htmlFor="setup-brand-color"
            helper={
              colorValid ? (
                "Optional. Colors the swarm name."
              ) : (
                <span className="text-status-error-strong">Use hex, like #RRGGBB.</span>
              )
            }
          >
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1.5">
                {AVATAR_SUGGESTED_SWATCHES.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    aria-label={`Use ${hex}`}
                    aria-pressed={color.toLowerCase() === hex}
                    onClick={() => setColorDraft(hex)}
                    disabled={saving}
                    className={cn(
                      "size-7 rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                      color.toLowerCase() === hex &&
                        "ring-2 ring-foreground ring-offset-2 ring-offset-card",
                    )}
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
              {/* Same control as Settings, Configuration for `kind: "color"`. */}
              <div className="flex gap-2">
                <Input
                  type="color"
                  aria-label="Brand color picker"
                  value={colorValid && color ? color : AVATAR_COLOR_INPUT_FALLBACK}
                  onChange={(event) => setColorDraft(event.target.value)}
                  disabled={saving}
                  className="w-10 shrink-0 p-1"
                />
                <Input
                  id="setup-brand-color"
                  placeholder="#RRGGBB"
                  maxLength={7}
                  spellCheck={false}
                  value={colorInput}
                  onChange={(event) => setColorDraft(event.target.value)}
                  aria-invalid={!colorValid}
                  disabled={saving}
                  className="font-mono"
                />
              </div>
            </div>
          </SettingsRow>

          {error ? (
            <AlertCallout tone="error" icon={XCircle}>
              {error}
            </AlertCallout>
          ) : null}

          <div>
            <Button type="submit" disabled={!trimmedName || !logoValid || !colorValid || saving}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              Save name
            </Button>
          </div>
        </form>
      </SetupCard>

      <SetupCard title="Sidebar preview" bodyClassName="rounded-b-xl bg-surface">
        <SidebarPreview
          name={trimmedName || DEFAULT_SWARM_NAME}
          logo={logo && logoValid ? logo : null}
          color={color && colorValid ? color : null}
        />
        <p className="mt-3 text-xs text-muted-foreground">
          Live preview. Both themes use the same color.
        </p>
      </SetupCard>
    </div>
  );
}

const PREVIEW_NAV = [
  { label: "Home", icon: House },
  { label: "Tasks", icon: ListTodo },
  { label: "Agents", icon: Bot },
];

/** The sidebar header as `app-sidebar.tsx` renders it: logo, name in the brand color. */
function SidebarPreview({
  name,
  logo,
  color,
}: {
  name: string;
  logo: string | null;
  color: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 border-b border-sidebar-border px-3 py-2.5">
        <img
          src={logo ?? "/logo.png"}
          alt=""
          className="size-7 shrink-0 rounded object-contain"
          onError={(event) => {
            // Same fallback as the sidebar when a logo URL does not load.
            const img = event.currentTarget;
            if (img.src !== `${window.location.origin}/logo.png`) img.src = "/logo.png";
          }}
        />
        <div className="min-w-0">
          <p
            className="truncate text-sm font-semibold leading-tight"
            style={color ? { color } : undefined}
          >
            {name}
          </p>
          <p className="text-[11px] leading-tight text-muted-foreground">Mission control</p>
        </div>
      </div>
      <ul className="flex flex-col gap-0.5 p-1.5">
        {PREVIEW_NAV.map(({ label, icon: Icon }, index) => (
          <li
            key={label}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground",
              index === 0 && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
