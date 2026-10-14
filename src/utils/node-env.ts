/**
 * Runtime read of `NODE_ENV`.
 *
 * `bun build --compile` replaces every dot read of `NODE_ENV` on `process.env`
 * with the build-time constant "development", so the compiled API and worker
 * binaries never see the deployment's value. A computed key is not inlined.
 * Read `NODE_ENV` through this helper only. `src/tests/node-env-runtime.test.ts`
 * compiles a binary to prove it; `scripts/check-node-env-access.sh` rejects new
 * dot reads in `src/`.
 */
const NODE_ENV_KEY = "NODE_ENV";

export function getNodeEnv(): string | undefined {
  return process.env[NODE_ENV_KEY];
}

/**
 * True only for an explicit development or test environment. Deployed images
 * leave NODE_ENV unset, so unset (and any other value) fails closed.
 */
export function isDevOrTestNodeEnv(): boolean {
  const env = getNodeEnv();
  return env === "development" || env === "test";
}
