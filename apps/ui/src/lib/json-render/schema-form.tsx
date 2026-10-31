/**
 * `SchemaForm` — a schema-driven props panel.
 *
 * Walks `schema.properties` and renders one control per property (text / select
 * / number / switch). The working draft lives in local state AND is mirrored to
 * `/ui/<id>/value` on every edit, so other components can subscribe to it and
 * re-render before any row round-trips. The `onChange` action chain is
 * dispatched with `$form = <current draft>` on commit, exactly as
 * `FormComponent.submit` scopes its `onSubmit` chain.
 *
 * The draft rebuilds whenever the bound `schema` identity changes — binding a
 * different schema (e.g. on selecting another node) resets the panel.
 *
 * Nested document editing (`baseDoc` + `nodeKey`): the draft seeds from
 * `baseDoc.elements[nodeKey].props`, and `/ui/<id>/value` receives the FULL doc
 * with the draft merged into that element — a synchronous, parent-side merge.
 * An `app.mutate` in `onChange` then persists the whole document column via
 * `{$state: "/ui/<id>/value"}` with no async round-trip (so the persisted doc
 * is never a commit behind the edit).
 *
 * The schema and doc are untrusted: controls, enum options and merged-doc size
 * are capped in `schema-form-model.ts`, which holds all the pure logic.
 */

import type { InferComponentProps } from "@json-render/core";
import { useActions, useStateStore } from "@json-render/react";
import { useEffect, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";
import { resolveScopedParams } from "./action-params";
import type { ActionChain, swarmCatalog } from "./catalog";
import {
  buildDraft,
  commitValue,
  createCommitQueue,
  type Draft,
  deriveControls,
  dropConfirmed,
  formSignature,
  fromSelectValue,
  isValidStateId,
  mergeSeed,
  type PendingProps,
  parseControlNumber,
  resolveMode,
  SCHEMA_FORM_MAX_PROPERTIES,
  toSelectValue,
} from "./schema-form-model";
import { useJsonRenderThemeAttr } from "./theme-scope";

export type SchemaFormProps = InferComponentProps<typeof swarmCatalog, "SchemaForm">;

export function SchemaFormComponent({ props }: { props: SchemaFormProps }) {
  const { set, getSnapshot } = useStateStore();
  const { execute } = useActions();
  const themeAttr = useJsonRenderThemeAttr();
  const path = `/ui/${props.id}/value`;

  const { controls, truncated } = deriveControls(props.schema);

  const nodeKey = typeof props.nodeKey === "string" ? props.nodeKey : undefined;
  const mode = resolveMode(props.baseDoc, nodeKey);

  // Edits `baseDoc` has not caught up with yet, so a commit on node B never
  // reverts node A's pending edit. Entries drop once the doc confirms them.
  const pendingRef = useRef<PendingProps>(new Map());
  if (mode.kind === "merge") dropConfirmed(pendingRef.current, mode.doc);

  const seedValue = mode.kind === "merge" ? mergeSeed(mode, pendingRef.current) : props.value;

  // Re-seed the draft when the schema, seed or node key changes.
  const signature = formSignature(controls, seedValue, nodeKey);
  const [draft, setDraft] = useState<Draft>(() => buildDraft(controls, seedValue));
  const lastSignatureRef = useRef(signature);
  useEffect(() => {
    if (lastSignatureRef.current === signature) return;
    lastSignatureRef.current = signature;
    setDraft(buildDraft(deriveControls(props.schema).controls, seedValue));
    // `controls`/`seedValue` derive from props; the signature captures both.
  }, [signature, props.schema, seedValue]);

  // Stable refs so `commit` never dispatches against a stale chain / snapshot.
  const propsRef = useRef(props);
  propsRef.current = props;
  const executeRef = useRef(execute);
  executeRef.current = execute;
  const getSnapshotRef = useRef(getSnapshot);
  getSnapshotRef.current = getSnapshot;
  // Runs one `onChange` chain at a time so responses cannot land out of order.
  const enqueueRef = useRef(
    createCommitQueue((error) => console.error("[SchemaForm] onChange chain failed", error)),
  );

  /** Write to `/ui/<id>/value` (optimistic preview) without persisting. */
  const writeDraft = (next: Draft) => {
    setDraft(next);
    set(path, commitValue(mode, pendingRef.current, next));
  };

  /** Mirror the value and queue the `onChange` chain, scoped to this exact commit. */
  const commit = (next: Draft): Promise<void> => {
    writeDraft(next);
    const chain = propsRef.current.onChange as ActionChain | undefined;
    if (!chain || chain.length === 0) return Promise.resolve();
    const scope = { form: next, state: getSnapshotRef.current() };
    const dispatch = async () => {
      for (const binding of chain) {
        const params = resolveScopedParams(binding.params, scope);
        await executeRef.current({ ...binding, params });
      }
    };
    return enqueueRef.current(dispatch);
  };

  const fill = props.fill === true;
  if (mode.kind === "too-large") {
    return (
      <p className="px-1 py-2 text-sm text-muted-foreground">
        This document is too large to edit here.
      </p>
    );
  }
  if (!isValidStateId(props.id)) {
    return <p className="px-1 py-2 text-sm text-muted-foreground">Invalid SchemaForm id.</p>;
  }
  if (controls.length === 0) {
    return (
      <p className="px-1 py-2 text-sm text-muted-foreground">
        Select a component to edit its props.
      </p>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        // Same `h-full` + `min-h-0` contract as Tree's fill Card: siblings that
        // both fill split the parent's height, and this panel scrolls within its share.
        fill ? "h-full min-h-0 overflow-y-auto" : "shrink-0",
      )}
      data-testid="json-render-schema-form"
    >
      {controls.map((control) => {
        const { key, kind, options, description: tooltip } = control;
        const inputId = `schemaform-${props.id}-${key}`;
        const current = draft[key];

        if (kind === "switch") {
          return (
            <SettingsRow key={key} label={key} htmlFor={inputId} helper={tooltip}>
              <Switch
                id={inputId}
                checked={current === true}
                onCheckedChange={(checked) => void commit({ ...draft, [key]: checked })}
              />
            </SettingsRow>
          );
        }

        if (kind === "select") {
          return (
            <SettingsRow key={key} label={key} htmlFor={inputId} helper={tooltip}>
              <Select
                value={toSelectValue(current)}
                onValueChange={(next) => void commit({ ...draft, [key]: fromSelectValue(next) })}
              >
                <SelectTrigger id={inputId} className="w-full">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent {...themeAttr}>
                  {options.map((option) => (
                    <SelectItem key={option} value={toSelectValue(option)}>
                      {option === "" ? "(empty)" : option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          );
        }

        const isNumber = kind === "number";
        return (
          <SettingsRow key={key} label={key} htmlFor={inputId} helper={tooltip}>
            <Input
              id={inputId}
              type={isNumber ? "number" : "text"}
              value={current === undefined || current === null ? "" : String(current)}
              // Typing updates the optimistic draft; the persisting chain fires
              // on blur so an `app.mutate` runs once per edit, not per keystroke.
              onChange={(event) => {
                const raw = event.target.value;
                const parsed = isNumber ? parseControlNumber(raw, control.integer) : { value: raw };
                if (parsed) writeDraft({ ...draft, [key]: parsed.value });
              }}
              onBlur={() => void commit(draft)}
            />
          </SettingsRow>
        );
      })}
      {truncated && (
        <p className="px-1 text-xs text-muted-foreground">
          Showing the first {SCHEMA_FORM_MAX_PROPERTIES} fields.
        </p>
      )}
    </div>
  );
}
