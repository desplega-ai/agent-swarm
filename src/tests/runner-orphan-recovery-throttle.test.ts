/**
 * Coverage for the delivery loop's orphan-recovery throttle.
 *
 * The boot recovery already recovered this process's orphans. Seeding the
 * throttle from it stops the first loop tick from paying for the same call
 * again; before the fix the seed was 0, so it did.
 */
import { describe, expect, test } from "bun:test";
import { orphanRecoveryDue } from "../commands/runner";

const INTERVAL = 60_000;
const BOOT_RECOVERED_AT = 1_000_000;

describe("orphan recovery throttle", () => {
  test("the boot recovery suppresses the first loop tick's duplicate", () => {
    // Main seeded the throttle with 0, so the tick right after boot matched.
    expect(orphanRecoveryDue(BOOT_RECOVERED_AT + 1, 0, INTERVAL)).toBe(true);

    // The fix seeds it with the time the boot recovery finished.
    expect(orphanRecoveryDue(BOOT_RECOVERED_AT + 1, BOOT_RECOVERED_AT, INTERVAL)).toBe(false);
  });

  test("recovery runs again once the interval elapses", () => {
    expect(orphanRecoveryDue(BOOT_RECOVERED_AT + INTERVAL, BOOT_RECOVERED_AT, INTERVAL)).toBe(
      false,
    );
    expect(orphanRecoveryDue(BOOT_RECOVERED_AT + INTERVAL + 1, BOOT_RECOVERED_AT, INTERVAL)).toBe(
      true,
    );
  });

  test("the interval is measured from the last recovery, not from boot", () => {
    const secondRecoveryAt = BOOT_RECOVERED_AT + INTERVAL + 1;
    expect(orphanRecoveryDue(secondRecoveryAt + INTERVAL, secondRecoveryAt, INTERVAL)).toBe(false);
    expect(orphanRecoveryDue(secondRecoveryAt + INTERVAL + 1, secondRecoveryAt, INTERVAL)).toBe(
      true,
    );
  });
});
