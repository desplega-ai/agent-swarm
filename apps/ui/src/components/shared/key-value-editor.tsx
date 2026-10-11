import { Plus, X } from "lucide-react";
import { SecretInput } from "@/components/shared/secret-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface KeyValueRow {
  id: string;
  key: string;
  value: string;
}

// A plain counter: `crypto.randomUUID` is missing on dashboards served over
// plain HTTP from a non-localhost host.
let nextRowId = 0;
function rowId(): string {
  nextRowId += 1;
  return `kv-${nextRowId}`;
}

export function rowsFromRecord(record: Record<string, string>): KeyValueRow[] {
  return Object.entries(record).map(([key, value]) => ({ id: rowId(), key, value }));
}

/** Rows with a blank key are dropped. Keys are trimmed. */
export function recordFromRows(rows: KeyValueRow[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) record[key] = row.value;
  }
  return record;
}

export function duplicateKeys(rows: KeyValueRow[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

/**
 * Editable list of string pairs (environment variables, controller config).
 * With `secret`, values render as `SecretInput`s and never autofill.
 */
export function KeyValueEditor({
  rows,
  onChange,
  label,
  keyPlaceholder = "KEY",
  valuePlaceholder = "value",
  addLabel = "Add variable",
  secret = false,
  disabled = false,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  /** Accessible name prefix for each row's inputs, e.g. "Environment". */
  label: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  secret?: boolean;
  disabled?: boolean;
}) {
  function update(id: string, patch: Partial<KeyValueRow>) {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={row.id} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-2">
          <Input
            value={row.key}
            onChange={(event) => update(row.id, { key: event.target.value })}
            placeholder={keyPlaceholder}
            aria-label={`${label} key ${index + 1}`}
            className="font-mono text-xs"
            disabled={disabled}
          />
          {secret ? (
            <SecretInput
              value={row.value}
              onChange={(value) => update(row.id, { value })}
              placeholder={valuePlaceholder}
              aria-label={`${label} value ${index + 1}`}
              autoComplete="new-password"
              disabled={disabled}
            />
          ) : (
            <Input
              value={row.value}
              onChange={(event) => update(row.id, { value: event.target.value })}
              placeholder={valuePlaceholder}
              aria-label={`${label} value ${index + 1}`}
              className="font-mono text-xs"
              disabled={disabled}
            />
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Remove ${label.toLowerCase()} row ${index + 1}`}
            onClick={() => onChange(rows.filter((candidate) => candidate.id !== row.id))}
            disabled={disabled}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...rows, { id: rowId(), key: "", value: "" }])}
        disabled={disabled}
      >
        <Plus className="h-4 w-4" />
        {addLabel}
      </Button>
    </div>
  );
}
