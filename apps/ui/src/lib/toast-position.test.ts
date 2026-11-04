import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Every toast sits where the root `<Toaster>` in `app/App.tsx` puts it. A
 * per-call `position` splits toasts across corners, so no `toast(...)` call
 * may pass one.
 */
const SRC = join(import.meta.dir, "..");

/** A `toast(` or `toast.<kind>(` call, with up to three levels of nested parens. */
const TOAST_CALL = /\btoast(?:\.\w+)?\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g;

function toastCallsWithPosition(source: string): string[] {
  return [...source.matchAll(TOAST_CALL)]
    .map((match) => match[0])
    .filter((call) => /\bposition\b/.test(call));
}

test("the scanner flags a toast call that passes a position", () => {
  expect(
    toastCallsWithPosition(`toast.error("x", {\n  position: "bottom-left",\n});`),
  ).toHaveLength(1);
  expect(toastCallsWithPosition(`toast("Renamed", { position })`)).toHaveLength(1);
  expect(toastCallsWithPosition(`toast(message, { duration: 8000 })`)).toHaveLength(0);
});

test("no toast call overrides the root Toaster position", async () => {
  const offenders: string[] = [];
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const source = await Bun.file(join(SRC, file)).text();
    if (!source.includes('from "sonner"')) continue;
    for (const call of toastCallsWithPosition(source)) {
      offenders.push(`${file}: ${call.split("\n")[0]}`);
    }
  }
  expect(offenders).toEqual([]);
});
