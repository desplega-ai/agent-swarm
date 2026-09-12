// Holds a `withFileLock` lock from a separate process: prints "locked" once it
// has it, then keeps it for `holdMs` (or until killed).
import { withFileLock } from "../../utils/file-lock";

const [lockPath, holdMs] = process.argv.slice(2);
const result = await withFileLock(lockPath as string, async () => {
  console.log("locked");
  await Bun.sleep(Number(holdMs));
});
if (!result.acquired) {
  console.log(`not-acquired:${result.reason}`);
  process.exit(1);
}
