// Matches runtime errors that look like a swapped/misused (args, ctx) signature,
// e.g. destructuring `ctx.api`/`ctx.kv`/`ctx.fetchJson`/`ctx.log` off `undefined`/`null`
// because the script read them off `args` instead.
const CTX_UNDEFINED_ACCESS_RE = /cannot read propert(?:y|ies)(?: .*)? of (?:undefined|null)/i;
const CTX_MEMBER_RE = /\b(api|kv|fetchJson|log)\b/i;
const CTX_SIGNATURE_HINT =
  "Hint: swarm scripts export default async function (args, ctx) — args comes first, ctx second.";

/** Shared by every script executor so structured errors carry the same hint. */
export function ctxSignatureHintFor(message: string): string | undefined {
  return CTX_UNDEFINED_ACCESS_RE.test(message) && CTX_MEMBER_RE.test(message)
    ? CTX_SIGNATURE_HINT
    : undefined;
}
