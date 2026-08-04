/**
 * `<AppSettingsDrawer>` — the per-viewer settings form of a swarm app.
 *
 * An app declares a typed `userConfig` schema INSIDE its definition (versioned
 * with it); the values live outside, keyed by (app, viewer). This drawer is the
 * only place a human edits them:
 *
 *   GET  /api/apps/:id/user-config → `{ values, schema }` (values already
 *        merged against the current schema server-side: dropped fields gone,
 *        nonconforming ones back at their default)
 *   PUT  /api/apps/:id/user-config → replaces the stored values wholesale
 *
 * Saving invalidates the shared react-query key, which is the same entry
 * `<AppSurface>` mirrors into json-render state at `/user/<field>` — so the
 * rendered page picks the new value up on the same tick.
 *
 * WHOLESALE REPLACE: a field left out of the PUT body is *unset*, and reads
 * back as its declared default (or null). That is exactly how this form clears
 * a value — an empty text/number/date input and an enum back on "Not set" are
 * omitted rather than sent as `null` (which the server would reject: no
 * userConfig field is nullable-by-value, only unset).
 */

import { AlertCircle, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { AppApiError } from "@/api/client";
import { useAppUserConfig, useSaveAppUserConfig } from "@/api/hooks/use-apps";
import type { AppUserConfigField, AppUserConfigValue } from "@/api/types";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-row";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";

/**
 * Radix `Select` forbids an empty item value, so "unset" needs a sentinel.
 * `__unset__` cannot collide with a real option: enum values come from app
 * JSON, but the sentinel is only ever compared against the draft's own state
 * and never sent — an app declaring a literal `__unset__` option would only
 * lose the ability to clear that one field back to its default.
 */
const UNSET = "__unset__";

/**
 * Editing state. Text-ish kinds (`string` / `number` / `date` / `enum`) hold
 * the raw input string so a half-typed number ("1.") survives a re-render;
 * booleans hold the boolean. `null` means "unset" for every kind.
 */
type Draft = Record<string, string | boolean | null>;

type UserConfigSchema = Record<string, AppUserConfigField>;

function toDraft(schema: UserConfigSchema, values: Record<string, AppUserConfigValue>): Draft {
  const draft: Draft = {};
  for (const [name, field] of Object.entries(schema)) {
    const value = values[name];
    if (value === null || value === undefined) {
      draft[name] = null;
    } else if (field.kind === "boolean") {
      draft[name] = value === true;
    } else {
      draft[name] = String(value);
    }
  }
  return draft;
}

/** Draft → PUT body. Unset (null / blank) fields are OMITTED, not nulled. */
function toPayload(schema: UserConfigSchema, draft: Draft): Record<string, AppUserConfigValue> {
  const values: Record<string, AppUserConfigValue> = {};
  for (const [name, field] of Object.entries(schema)) {
    const raw = draft[name];
    if (raw === null || raw === undefined) continue;
    if (field.kind === "boolean") {
      values[name] = raw === true;
      continue;
    }
    const text = String(raw);
    if (text === "") continue;
    if (field.kind === "number") {
      const parsed = Number(text);
      // Non-numeric text can only get here by paste (the input is type=number).
      // Send it as-is so the rejection is worded by the server's own validator
      // instead of a second, drifting client-side message.
      values[name] = Number.isFinite(parsed) ? parsed : text;
      continue;
    }
    values[name] = text;
  }
  return values;
}

/**
 * Server 400s carry `issues: [{ path: "values.<field>", message }]`. Anything
 * that does not name a known field (a 403/413, a bare `error`) stays out of
 * this map and is rendered as the drawer-level callout instead.
 */
function fieldErrors(error: unknown, schema: UserConfigSchema): Record<string, string> {
  if (!(error instanceof AppApiError)) return {};
  const byField: Record<string, string> = {};
  for (const issue of error.issues) {
    const name = issue.path?.startsWith("values.") ? issue.path.slice("values.".length) : null;
    if (name && schema[name] && issue.message) byField[name] = issue.message;
  }
  return byField;
}

function defaultHint(field: AppUserConfigField): string | undefined {
  if (field.default === undefined) return undefined;
  if (field.kind === "boolean") return `Default: ${field.default ? "on" : "off"}`;
  return `Default: ${String(field.default)}`;
}

export interface AppSettingsDrawerProps {
  appId: string;
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppSettingsDrawer({ appId, appName, open, onOpenChange }: AppSettingsDrawerProps) {
  const { data, isLoading, error: loadError } = useAppUserConfig(appId, { enabled: open });
  const save = useSaveAppUserConfig(appId);
  // `null` = "follow the server". Set on the first edit and dropped again on
  // close / successful save, so a reopened drawer always shows stored truth
  // without an effect re-seeding it.
  const [edits, setEdits] = useState<Draft | null>(null);
  // Number fields the browser currently reads as unparseable ("1e", "1-2").
  // `<input type="number">` reports `value === ""` for those, which `toPayload`
  // would omit — silently resetting the field to its default on save. Tracked
  // here so the input carries an inline error and Save is blocked instead.
  const [badNumbers, setBadNumbers] = useState<Record<string, boolean>>({});

  const schema = useMemo<UserConfigSchema>(() => data?.schema ?? {}, [data]);
  const serverDraft = useMemo(() => toDraft(schema, data?.values ?? {}), [schema, data]);
  const draft = edits ?? serverDraft;
  const errorsByField = fieldErrors(save.error, schema);
  // A field-level issue is shown on its input; the flattened message is only
  // the fallback for everything else (403 agent scope, 413 size cap, 5xx).
  const generalError =
    save.error && Object.keys(errorsByField).length === 0
      ? save.error instanceof Error
        ? save.error.message
        : String(save.error)
      : null;

  function setField(name: string, value: string | boolean | null) {
    if (save.isError) save.reset();
    setEdits({ ...draft, [name]: value });
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setEdits(null);
      setBadNumbers({});
      save.reset();
    }
    onOpenChange(next);
  }

  function handleSave() {
    save.mutate(toPayload(schema, draft), {
      onSuccess: () => {
        setEdits(null);
        setBadNumbers({});
        onOpenChange(false);
      },
    });
  }

  const fields = Object.entries(schema);
  const hasBadNumber = Object.values(badNumbers).some(Boolean);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md" data-testid="app-settings-drawer">
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle className="text-sm font-medium">Settings</SheetTitle>
          <SheetDescription className="text-xs">
            Your own preferences for {appName}. Only you see them, and they survive a definition
            rollback.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 space-y-4 overflow-y-auto px-4">
          {loadError && (
            <AlertCallout tone="error" icon={AlertCircle} title="Failed to load settings">
              {loadError instanceof Error ? loadError.message : String(loadError)}
            </AlertCallout>
          )}
          {generalError && (
            <AlertCallout tone="error" icon={AlertCircle} title="Failed to save settings">
              {generalError}
            </AlertCallout>
          )}
          {isLoading && !data && <p className="text-xs text-muted-foreground">Loading…</p>}
          {!isLoading && fields.length === 0 && !loadError && (
            <p className="text-xs text-muted-foreground">This app declares no settings.</p>
          )}

          {fields.map(([name, field]) => {
            const inputId = `app-user-config-${name}`;
            // Same slot as a server-side issue: an unparseable number reads as
            // a field error until the viewer fixes it.
            const fieldError =
              errorsByField[name] ??
              (badNumbers[name] ? "must be a valid number value" : undefined);
            const value = draft[name] ?? null;
            const text = typeof value === "string" ? value : "";
            return (
              <SettingsRow
                key={name}
                label={field.label ?? name}
                htmlFor={inputId}
                helper={
                  fieldError ? (
                    <span className="text-status-error-strong">{fieldError}</span>
                  ) : (
                    defaultHint(field)
                  )
                }
              >
                {field.kind === "boolean" ? (
                  <div className="flex h-9 items-center">
                    <Switch
                      id={inputId}
                      checked={value === true}
                      onCheckedChange={(checked) => setField(name, checked)}
                    />
                  </div>
                ) : field.kind === "enum" ? (
                  <Select
                    value={text || UNSET}
                    onValueChange={(next) => setField(name, next === UNSET ? null : next)}
                  >
                    <SelectTrigger id={inputId} className="w-full">
                      <SelectValue placeholder="Not set" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNSET}>Not set</SelectItem>
                      {(field.enum ?? []).map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : field.kind === "date" ? (
                  <Input
                    id={inputId}
                    type="date"
                    // Stored values may be full ISO timestamps; the picker only
                    // speaks `YYYY-MM-DD`. The untouched draft keeps the full
                    // string, so an unedited timestamp round-trips intact.
                    value={text.slice(0, 10)}
                    onChange={(e) => setField(name, e.target.value)}
                  />
                ) : (
                  <Input
                    id={inputId}
                    type={field.kind === "number" ? "number" : "text"}
                    value={text}
                    aria-invalid={fieldError ? true : undefined}
                    placeholder={field.default !== undefined ? String(field.default) : "Not set"}
                    onChange={(e) => {
                      // `badInput` is the ONLY signal that a blank numeric
                      // input means "unparseable" rather than "cleared" — the
                      // value itself is `""` either way.
                      if (field.kind === "number") {
                        const bad = e.target.validity?.badInput === true;
                        setBadNumbers((prev) =>
                          prev[name] === bad ? prev : { ...prev, [name]: bad },
                        );
                      }
                      setField(name, e.target.value);
                    }}
                  />
                )}
              </SettingsRow>
            );
          })}
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-border">
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            // Blocked, not silently coerced: saving with an unparseable number
            // would omit that field and reset it to its default.
            disabled={save.isPending || fields.length === 0 || hasBadNumber}
            title={hasBadNumber ? "Fix the invalid number field first" : undefined}
            onClick={handleSave}
            data-testid="app-settings-save"
          >
            <Settings2 className="size-3.5" />
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
