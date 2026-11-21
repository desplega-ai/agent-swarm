/**
 * KV storage for the org design system (`src/themes/design-system.ts`). The
 * `design-system` namespace is reserved, so these helpers are its only writer.
 */

import {
  DESIGN_SYSTEM_KEY,
  DESIGN_SYSTEM_NAMESPACE,
  DESIGN_SYSTEM_PREVIOUS_KEY,
  readDesignSystem,
} from "../themes/design-system";
import type { DesignSystem } from "../types";
import { getKv, upsertKv } from "./db";
import { getStorage } from "./storage";

export type StoredDesignSystem =
  | { status: "none" }
  | { status: "invalid"; reason: string }
  | { status: DesignSystem["status"]; record: DesignSystem };

function toStored(value: unknown): StoredDesignSystem {
  const read = readDesignSystem(value);
  if (!read) return { status: "none" };
  if ("invalid" in read) return { status: "invalid", reason: read.invalid };
  return { status: read.record.status, record: read.record };
}

export async function getDesignSystem(): Promise<{
  current: StoredDesignSystem;
  previous: StoredDesignSystem;
}> {
  const [current, previous] = await Promise.all([
    getKv(DESIGN_SYSTEM_NAMESPACE, DESIGN_SYSTEM_KEY),
    getKv(DESIGN_SYSTEM_NAMESPACE, DESIGN_SYSTEM_PREVIOUS_KEY),
  ]);
  return { current: toStored(current?.value), previous: toStored(previous?.value) };
}

/** The record pages render with: an active, valid design system, else null. */
export async function getActiveDesignSystem(): Promise<DesignSystem | null> {
  const stored = toStored((await getKv(DESIGN_SYSTEM_NAMESPACE, DESIGN_SYSTEM_KEY))?.value);
  return "record" in stored && stored.record.status === "active" ? stored.record : null;
}

/** Saves `record` and moves the value it replaces to `org.prev`. */
export async function saveDesignSystem(record: DesignSystem): Promise<void> {
  await getStorage().transaction(async () => {
    const current = await getKv(DESIGN_SYSTEM_NAMESPACE, DESIGN_SYSTEM_KEY);
    if (current) {
      await upsertKv({
        namespace: DESIGN_SYSTEM_NAMESPACE,
        key: DESIGN_SYSTEM_PREVIOUS_KEY,
        value: current.value,
        valueType: "json",
      });
    }
    await upsertKv({
      namespace: DESIGN_SYSTEM_NAMESPACE,
      key: DESIGN_SYSTEM_KEY,
      value: record,
      valueType: "json",
    });
  });
}
