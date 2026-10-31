// agent-fs #136: AGENT_FS_REGISTER_ALLOWED_DOMAINS
import { check, finish, http, startDaemon } from "./common";

const d = await startDaemon({ AGENT_FS_REGISTER_ALLOWED_DOMAINS: " Acme.com , ,acme.io" });
try {
  const reg = (email: string) => http(d.url, "POST", "/auth/register", { body: { email } });
  let r = await reg("ok@acme.com");
  check("allowed domain acme.com -> 200", r.status === 200 && !!r.json?.apiKey, String(r.status));
  r = await reg("ok2@ACME.IO");
  check("allowed domain case-insensitive ACME.IO -> 200", r.status === 200, String(r.status));
  r = await reg("x@evil.com");
  check(
    "other domain -> 403 REGISTRATION_DOMAIN_NOT_ALLOWED",
    r.status === 403 && r.json?.error === "REGISTRATION_DOMAIN_NOT_ALLOWED",
    `${r.status} ${r.json?.error}`,
  );
  r = await reg("x@sub.acme.com");
  check("subdomain not matched -> 403", r.status === 403, String(r.status));
  r = await reg("x@acme.com.evil.com");
  check("suffix trick -> 403", r.status === 403, String(r.status));
  r = await reg("foo");
  check(
    "no @ -> 400 VALIDATION_ERROR",
    r.status === 400 && r.json?.error === "VALIDATION_ERROR",
    `${r.status} ${r.json?.error}`,
  );
  r = await reg("foo@");
  check("empty domain -> 400", r.status === 400, String(r.status));
  r = await reg("ok@acme.com");
  check("duplicate allowed email -> 409 (not blocked by gate)", r.status === 409, String(r.status));
} finally {
  await d.stop();
}
// control: unset -> open
const o = await startDaemon({});
try {
  const r = await http(o.url, "POST", "/auth/register", { body: { email: "anyone@evil.com" } });
  check("control: allowlist unset -> evil.com registers 200", r.status === 200, String(r.status));
} finally {
  await o.stop();
}
finish("#136");
