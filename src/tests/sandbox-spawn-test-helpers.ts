// The pre-push hook sets this only when its file-backed Bun sandbox probe exits
// 134 under the shared UID's RLIMIT_NPROC. CI leaves it unset and runs these tests.
export const SKIP_SANDBOX_SPAWN_TESTS = process.env.SWARM_SKIP_SANDBOX_SPAWN_TESTS === "1";
