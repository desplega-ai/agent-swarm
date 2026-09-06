/**
 * Redaction for text the E2E runner publishes: worker-log tails, error
 * messages, and the uploaded log files. The API and the worker scrub their own
 * output at egress; this pass covers what third-party CLIs print straight to
 * the captured stdout, and it masks the exact credential values this process
 * was given. The job summary, the sticky issue, and the artifacts of a public
 * repository are readable by anyone.
 *
 *   bun scripts/e2e/redact.ts --out <dir> <file>...   # writes redacted copies
 */
const REDACTED = "[REDACTED]";

const PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[abposer]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
const KEY_VALUE =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi;

const CREDENTIAL_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "CODEX_OAUTH",
];

/** Exact credential values this process holds: provider env values plus any extra strings. */
export function knownSecrets(extra: Iterable<string> = []): string[] {
  const values = new Set<string>();
  for (const key of CREDENTIAL_ENV_KEYS) {
    const value = process.env[key];
    if (value) values.add(value);
  }
  const blob = process.env.CODEX_OAUTH;
  if (blob) {
    try {
      const parsed = JSON.parse(blob) as Record<string, unknown>;
      for (const field of ["access", "refresh"]) {
        if (typeof parsed[field] === "string") values.add(parsed[field] as string);
      }
    } catch {}
  }
  for (const value of extra) values.add(value);
  return [...values].filter((value) => value.length >= 8);
}

export function redactSecrets(text: string, known: Iterable<string> = []): string {
  let result = text;
  for (const secret of known) {
    if (secret.length >= 8) result = result.split(secret).join(REDACTED);
  }
  for (const pattern of PATTERNS) result = result.replace(pattern, REDACTED);
  result = result.replace(BEARER, `$1${REDACTED}`);
  result = result.replace(KEY_VALUE, `$1${REDACTED}`);
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  if (outIndex === -1 || !args[outIndex + 1]) throw new Error("--out <dir> is required");
  const outDir = args[outIndex + 1]!;
  const files = args.filter((_arg, index) => index !== outIndex && index !== outIndex + 1);
  await Bun.$`mkdir -p ${outDir}`.quiet();
  const known = knownSecrets();
  for (const file of files) {
    const name = file.split("/").pop()!;
    const text = await Bun.file(file).text();
    await Bun.write(`${outDir}/${name}`, redactSecrets(text, known));
  }
  console.log(`redacted ${files.length} file(s) into ${outDir}`);
}

if (import.meta.main) {
  await main();
}
