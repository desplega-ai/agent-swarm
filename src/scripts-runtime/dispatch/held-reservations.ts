import { embeddedScriptRunner } from "./embedded-runner";
import type { ScriptRunnerHandle } from "./types";

const held = new Map<string, number>();
export type HeldReservationOptions = {
  lane?: "sync" | "long";
  eligible?: (runner: ScriptRunnerHandle) => boolean;
};
let picker: ((options: HeldReservationOptions) => ScriptRunnerHandle | undefined) | undefined;
let embeddedBusy: () => number = () => 0;
let wake: () => void = () => {};
export function setHeldScriptRunnerPicker(next: typeof picker) {
  picker = next;
}
export function configureHeldReservations(busy: () => number, onRelease: () => void) {
  embeddedBusy = busy;
  wake = onRelease;
}
export function heldScriptSlots(id: string): number {
  return held.get(id) ?? 0;
}

/** Reserve before any asynchronous claim or credential mint. */
export function reserveHeldScriptRunner(options: HeldReservationOptions = { lane: "long" }) {
  let runner = picker?.(options);
  if (!runner) {
    const configured = process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS;
    if (
      configured !== undefined &&
      embeddedBusy() + heldScriptSlots("embedded") >= Number(configured)
    )
      return;
    if (options.eligible && !options.eligible(embeddedScriptRunner)) return;
    runner = embeddedScriptRunner;
  }
  const selected = runner;
  held.set(selected.id, heldScriptSlots(selected.id) + 1);
  let released = false;
  return {
    runner: selected,
    startHeld: selected.startHeld.bind(selected),
    release() {
      if (released) return;
      released = true;
      const count = heldScriptSlots(selected.id) - 1;
      if (count) held.set(selected.id, count);
      else held.delete(selected.id);
      wake();
    },
  };
}
