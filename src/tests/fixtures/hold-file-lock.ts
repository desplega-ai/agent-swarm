import { withFileLock } from "../../utils/file-lock";

/**
 * Hold `lockPath` from this process (a live holder) until the returned release
 * function is awaited. Resolves once the lock is actually held.
 */
export async function holdFileLock(lockPath: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held!: () => void;
  const acquired = new Promise<void>((resolve) => {
    held = resolve;
  });
  const holding = withFileLock(lockPath, async () => {
    held();
    await released;
  });
  await acquired;
  return async () => {
    release();
    await holding;
  };
}
