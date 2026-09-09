function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(args: string[]): { path: string; printExpiry: boolean } {
  const printExpiry = args.includes("--print-expiry");
  const paths = args.filter((arg) => arg !== "--print-expiry");
  if (paths.length !== 1 || args.length !== paths.length + (printExpiry ? 1 : 0)) {
    fail("Usage: bun scripts/e2e/codex-oauth-blob.ts [--print-expiry] /path/to/auth.json");
  }
  return { path: paths[0]!, printExpiry };
}

function expiryFromAccessToken(access: string): number {
  const payload = access.split(".")[1];
  if (!payload) fail("Access token is not a JWT with a payload");
  let parsed: unknown;
  try {
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    parsed = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
  } catch {
    fail("Access token JWT payload is not valid JSON");
  }
  const exp = (parsed as Record<string, unknown>).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    fail("Access token JWT payload has no numeric exp claim");
  }
  return exp * 1_000;
}

const { path, printExpiry } = parseArgs(process.argv.slice(2));
let auth: unknown;
try {
  auth = await Bun.file(path).json();
} catch {
  fail(`Could not read valid JSON from ${path}`);
}
if (!auth || typeof auth !== "object") fail("auth.json must contain a JSON object");
const record = auth as Record<string, unknown>;
if (record.auth_mode !== "chatgpt") fail("auth.json auth_mode must be chatgpt");
const tokens = record.tokens;
if (!tokens || typeof tokens !== "object") fail("auth.json is missing tokens");
const tokenRecord = tokens as Record<string, unknown>;
for (const key of ["access_token", "refresh_token", "account_id"] as const) {
  if (typeof tokenRecord[key] !== "string") fail(`auth.json tokens.${key} must be a string`);
}
const expires = expiryFromAccessToken(tokenRecord.access_token as string);

if (printExpiry) {
  const hours = (expires - Date.now()) / 3_600_000;
  console.log(`${new Date(expires).toISOString()} (${hours.toFixed(1)} hours remaining)`);
} else {
  console.log(
    JSON.stringify({
      access: tokenRecord.access_token,
      refresh: tokenRecord.refresh_token,
      expires,
      accountId: tokenRecord.account_id,
    }),
  );
}
