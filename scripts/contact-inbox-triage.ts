// biome-ignore-all lint/suspicious/noExplicitAny: AgentMail connection returns untyped provider JSON; preserve the existing enrichment contract.
import type { ScriptContext } from "swarm-sdk";
import * as z from "zod";

export const argsSchema = z
  .object({
    lookbackHours: z.number().positive().max(8760).default(72),
    limit: z.number().int().min(1).max(100).default(25),
    dryRun: z.boolean().default(false),
  })
  .nullish();
const INBOX = "desplega-contact@agent-swarm.dev";
type RecordData = Record<string, any>;
type Signals = {
  mx: boolean | null;
  person: boolean;
  auth: string;
  evidence: string[];
  gaps: string[];
};
const clean = (v: unknown, n = 1500) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip control characters from untrusted mail.
  typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").slice(0, n) : "";
function extract(m: RecordData) {
  m = { ...m, from: m.from ?? (Array.isArray(m.from_) ? m.from_.join(", ") : m.from_) };
  const raw =
    typeof m.from === "object"
      ? `${m.from?.name || ""} <${m.from?.email || m.from?.address || ""}>`
      : clean(m.from);
  const address =
    raw.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0].toLowerCase() || "";
  const name = clean(
    raw
      .replace(/<[^>]*>/g, "")
      .replace(address, "")
      .replace(/"/g, "")
      .trim(),
    120,
  );
  const domain = address.split("@")[1] || "";
  const body = clean(m.text || m.extracted_text || "", 16000);
  const html = clean(m.html || "", 16000);
  const links = [...new Set(`${body} ${html}`.match(/https?:\/\/[^\s<>"']+/gi) || [])].slice(0, 50);
  const headers: Record<string, string> = {};
  if (Array.isArray(m.headers))
    for (const h of m.headers) headers[String(h.name).toLowerCase()] = clean(h.value, 2000);
  else if (m.headers && typeof m.headers === "object")
    for (const [k, v] of Object.entries(m.headers)) headers[k.toLowerCase()] = clean(v, 2000);
  return {
    address,
    name,
    domain,
    body,
    links,
    headers,
    subject: clean(m.subject, 300),
    replyTo: m.reply_to ?? headers["reply-to"] ?? null,
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    attachmentsKnown: Array.isArray(m.attachments),
    bodyKnown: !!body,
    receivedAt: clean(m.timestamp || m.created_at, 100),
    freeMail: /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|protonmail|proton|aol)\./i.test(
      domain,
    ),
  };
}
function classify(m: RecordData, signals: Signals, threadId: string) {
  const e = extract(m);
  const redFlags: string[] = [];
  const text = `${e.subject} ${e.body}`;
  // These are triage heuristics, not instructions from the message or a model prompt.
  const pitch =
    /\b(buy backlinks|guest post|link building|seo services|outsourced developers|staff augmentation|crypto investment|airdrop|recruitment services)\b/i.test(
      text,
    );
  const bulk = /\b(unsubscribe|mass mailing)\b/i.test(text) || !!e.headers["list-unsubscribe"];
  const riskyAttachment = e.attachments.some((a: RecordData) =>
    /\.(exe|scr|js|vbs|iso|lnk|docm|xlsm|zip|rar|7z)$/i.test(a.filename || a.name || ""),
  );
  const riskyLink = e.links.some((link) => {
    try {
      const u = new URL(link);
      return (
        !!u.username ||
        !!u.password ||
        /^\d+\.\d+\./.test(u.hostname) ||
        /(^|\.)(bit\.ly|tinyurl\.com|t\.co)$/.test(u.hostname) ||
        /\.exe(?:$|\?)/i.test(u.pathname)
      );
    } catch {
      return true;
    }
  });
  if (e.freeMail) redFlags.push("Free-mail sender; no corporate mailbox corroboration");
  if (e.replyTo && !JSON.stringify(e.replyTo).toLowerCase().includes(e.address))
    redFlags.push("Reply-to differs from sender; check before responding");
  if (signals.auth === "fail") redFlags.push("Exposed authentication results report failure");
  if (!e.attachmentsKnown) redFlags.push("Attachment metadata unavailable");
  if (!e.bodyKnown) redFlags.push("Plain-text message body unavailable");
  if (riskyLink || riskyAttachment)
    redFlags.push("Potentially risky link or attachment; not opened");
  let flag: "ENGAGE" | "IGNORE" | "NEEDS_HUMAN" = "NEEDS_HUMAN";
  let reason = "Identity or intent needs human verification";
  let confidence = 0.55;
  const specific =
    /\b(desplega|agent[ -]swarm)\b/i.test(text) &&
    /\b(pilot|demo|integrat\w*|evaluat\w*|collaborat\w*|partnership|test automation)\b/i.test(
      text,
    ) &&
    /\b(our|we|team|company)\b/i.test(text);
  if (pitch || bulk || riskyLink || riskyAttachment || !e.address || signals.mx === false) {
    flag = "IGNORE";
    confidence = 0.9;
    reason = pitch
      ? "Unsolicited SEO, recruiting, development-services or crypto pitch"
      : bulk
        ? "Bulk outreach signal"
        : riskyLink || riskyAttachment
          ? "Link or attachment risk"
          : "Sender address or mail domain is unverifiable";
  } else if (
    specific &&
    signals.person &&
    signals.mx === true &&
    signals.auth === "pass" &&
    redFlags.length === 0
  ) {
    flag = "ENGAGE";
    confidence = 0.85;
    reason = "Corroborated corporate sender with a specific, plausible Desplega inquiry";
  }
  return {
    threadId,
    from: { name: e.name, address: e.address, replyTo: e.replyTo },
    subject: e.subject,
    receivedAt: e.receivedAt || null,
    flag,
    confidence,
    oneLine: reason,
    whoTheyAre: signals.person
      ? `${e.name} is corroborated on ${e.domain}`
      : `${e.name || e.address || "Unknown sender"}; affiliation unverified`,
    whatTheyWant: e.body
      ? `Sender's words (untrusted): ${e.body.slice(0, 400)}`
      : "Intent unavailable without plain-text body",
    evidence: [
      ...signals.evidence,
      `Sender domain: ${e.domain || "missing"}`,
      `Authentication: ${signals.auth}`,
      ...signals.gaps.map((g) => `Unavailable: ${g}`),
    ],
    redFlags,
    suggestedNextStep:
      flag === "ENGAGE"
        ? "Review the inquiry and consider a personal reply"
        : flag === "IGNORE"
          ? "Do not engage; retain for audit"
          : "Verify identity and intent manually before replying",
    extracted: {
      links: e.links,
      attachments: e.attachments.map((a: RecordData) => ({
        filename: clean(a.filename || a.name),
        contentType: clean(a.content_type),
        size: a.size ?? null,
      })),
      authHeaders: e.headers["authentication-results"] || null,
    },
  };
}

async function enrich(m: RecordData, ctx: ScriptContext): Promise<Signals> {
  const e = extract(m);
  const s: Signals = { mx: null, person: false, auth: "unavailable", evidence: [], gaps: [] };
  const auth = e.headers["authentication-results"] || "";
  // Raw headers may contain sender-injected Authentication-Results. Never promote
  // these to a trusted pass without a receiver-provided structured auth verdict.
  if (/\b(dmarc|dkim|spf)=fail\b/i.test(auth) || m.labels?.includes("unauthenticated"))
    s.auth = "fail";
  s.gaps.push(
    "Trusted receiver authentication verdict is not defined by the connection spec; raw headers alone cannot authenticate a sender",
  );
  if (!e.attachmentsKnown) s.gaps.push("attachments");
  if (!e.bodyKnown) s.gaps.push("plain-text body");
  if (!e.address || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(e.domain)) return s;
  try {
    const dns: any = await ctx.stdlib.fetchJson(
      `https://dns.google/resolve?name=${encodeURIComponent(e.domain)}&type=MX`,
      { signal: AbortSignal.timeout(2500) },
    );
    if (dns.Status === 0)
      s.mx =
        Array.isArray(dns.Answer) &&
        dns.Answer.some((r: any) => r.type === 15 && !/^0\s+\.?$/.test(r.data));
    else if (dns.Status === 3) s.mx = false;
    s.evidence.push(
      `DNS MX ${e.domain}: ${s.mx === null ? "inconclusive" : s.mx ? "present" : "absent"}`,
    );
  } catch {
    s.gaps.push("DNS MX lookup failed");
  }
  if (s.mx === false) return s;
  if (e.name.split(/\s+/).length >= 2 && !e.freeMail) {
    try {
      const r = await ctx.api.exa.search({
        body: {
          query: `site:${e.domain} "${e.name.replace(/[^\p{L}\p{N} .-]/gu, "")}"`,
          numResults: 3,
          type: "fast",
        },
      });
      if (!Array.isArray(r.results)) throw new Error("Invalid search response");
      for (const result of r.results) {
        const title = clean(result.title, 300);
        let host = "";
        try {
          host = new URL(result.url || "").hostname;
        } catch {
          continue;
        }
        const official = host === e.domain || host.endsWith(`.${e.domain}`);
        const matches = title.toLowerCase().includes(e.name.toLowerCase());
        if (official && matches) s.person = true;
        s.evidence.push(`Exa search result (title-level evidence only): ${title} ${result.url}`);
      }
      if (!s.person) s.gaps.push("person/company corroboration");
    } catch {
      s.gaps.push("Exa enrichment failed");
    }
  }
  if (/\b(engineer|developer|cto|technical founder)\b/i.test(e.body)) {
    const login = e.links
      .map((l) => l.match(/^https:\/\/github\.com\/([a-z0-9-]+)\/?(?:[?#].*)?$/i)?.[1])
      .find(Boolean);
    if (login)
      try {
        const r: any = await ctx.api.ghGraphql.graphql(
          `query($login:String!){user(login:$login){login name company url websiteUrl}}`,
          { login },
        );
        const user = r?.data?.user ?? r?.user;
        if (user)
          s.evidence.push(
            `Claimed GitHub profile exists (not proof of ownership): ${JSON.stringify(user)}`,
          );
        else s.gaps.push("claimed GitHub profile could not be verified");
      } catch {
        s.gaps.push("GitHub enrichment failed");
      }
    else s.gaps.push("engineering claim has no explicit GitHub profile to verify");
  }
  return s;
}

export function fixtures() {
  const base = {
    from: "Alex Rivera <alex@acme.example>",
    timestamp: "2026-09-18T08:00:00Z",
    attachments: [],
  };
  const verified: Signals = {
    mx: true,
    person: true,
    auth: "pass",
    evidence: [
      "Synthetic receiver auth pass",
      "Synthetic MX and official company/person corroboration",
    ],
    gaps: [],
  };
  return [
    classify(
      {
        ...base,
        subject: "SEO services",
        text: "Buy backlinks and guest posts. Unsubscribe here.",
      },
      verified,
      "fixture-ignore",
    ),
    classify(
      {
        ...base,
        subject: "Desplega pilot",
        text: "Our engineering team at Acme wants to evaluate Desplega test automation in a pilot for our checkout service.",
      },
      verified,
      "fixture-engage",
    ),
  ];
}

export default async function (args: z.input<typeof argsSchema> | undefined, ctx: ScriptContext) {
  const options = argsSchema.parse(args || {})!;
  const started = Date.now();
  const fixtureResults = fixtures();
  const controls = {
    readRan: false,
    evidence: false,
    positiveIgnore: fixtureResults[0].flag === "IGNORE",
    positiveEngage: fixtureResults[1].flag === "ENGAGE",
    negative: false,
    ok: false,
    countsValid: false,
  };
  const briefs: (ReturnType<typeof classify> & { messageId: string })[] = [];
  const stats = {
    apiCount: 0,
    processed: 0,
    skipped: 0,
    deduplicated: 0,
    outsideLookback: 0,
    deferred: 0,
    pages: 0,
    kvWritten: 0,
    dryRun: options.dryRun,
    coverageComplete: false,
    countsVoid: true,
    archiveDrained: false,
    readPath: "verified-webhook-archive",
    historicalCoverage: "unknown",
  };
  const errors: string[] = [];
  const gaps = new Set<string>([
    "Only verified webhook deliveries captured after deployment are discoverable; historical and undelivered mail require provider replay or known IDs",
    "Subscriptions must include message.received and message.received.unauthenticated; blocked/spam need their subscriptions too",
    "lookbackHours is retained for schedule compatibility; archive deliveries expire 30 days after capture, including unprocessed mail",
    "Trusted receiver authentication verdict is not defined; live ENGAGE remains gated until Lead specifies it",
  ]);
  const archiveNamespace = "agentmail-inbound";
  const dedupeNamespace = "contact-triage-messages";
  const pending = new Map<string, string>();
  let pageToken: string | undefined;
  try {
    do {
      // Discover IDs directly from our durable archive, never AgentMail's indexes.
      // Return keys only so large bodies cannot truncate the discovery response.
      const response: any = await ctx.swarm.db_query({
        sql: `SELECT a.key FROM kv_entries a
          WHERE a.namespace = ? AND a.key > ?
          AND (a.expires_at IS NULL OR a.expires_at > ?)
          AND json_extract(a.value, '$.payload.message.inbox_id') = ?
          AND NOT EXISTS (SELECT 1 FROM kv_entries d WHERE d.namespace = ? AND d.key = a.key
            AND (d.expires_at IS NULL OR d.expires_at > ?))
          ORDER BY a.key LIMIT 25`,
        params: [archiveNamespace, pageToken ?? "", Date.now(), INBOX, dedupeNamespace, Date.now()],
      });
      const page = response?.data ?? response;
      if (
        response.success === false ||
        page.success === false ||
        !Array.isArray(page.rows) ||
        page.truncated
      )
        throw new Error("Archive query failed or truncated");
      controls.readRan = true;
      stats.pages++;
      if (page.rows.length === 0) {
        stats.archiveDrained = true;
        break;
      }
      for (const row of page.rows) {
        if (Date.now() - started > 18000 || briefs.length >= options.limit) {
          stats.deferred++;
          break;
        }
        const id = row[0];
        if (typeof id !== "string" || !id) throw new Error("Invalid archive message ID");
        const result: any = await ctx.swarm.kv_getOrNull({ namespace: archiveNamespace, key: id });
        const entry = result?.data ?? result;
        const value = typeof entry?.value === "string" ? JSON.parse(entry.value) : entry?.value;
        const message = value?.payload?.message;
        if (
          value?.version !== 1 ||
          message?.inbox_id !== INBOX ||
          typeof message?.message_id !== "string" ||
          !message.thread_id
        )
          throw new Error(`Missing or malformed archive message: ${id}`);
        // The signed event's unauthenticated verdict must survive even if labels
        // are missing from the provider payload.
        if (value.payload.event_type === "message.received.unauthenticated") {
          message.labels = [...(message.labels ?? []), "unauthenticated"];
        }
        const signals = await enrich(message, ctx);
        for (const gap of signals.gaps) gaps.add(gap);
        const brief = {
          ...classify(message, signals, message.thread_id),
          messageId: message.message_id,
        };
        briefs.push(brief);
        pending.set(id, JSON.stringify({ brief, processedAt: new Date().toISOString() }));
        stats.processed++;
        stats.apiCount++;
        pageToken = id;
      }
      if (stats.deferred) break;
      if (page.rows.length < 25) {
        stats.archiveDrained = true;
        break;
      }
    } while (stats.pages < 10 && briefs.length < options.limit && Date.now() - started < 18000);
    // Runtime-only negative control generated after source saving.
    const needle = `contact_probe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const negative: any = await ctx.swarm.db_query({
      sql: "SELECT COUNT(*) AS matches FROM scripts WHERE instr(source, ?) > 0",
      params: [needle],
    });
    const data = negative?.data ?? negative;
    controls.negative =
      negative.success !== false &&
      Array.isArray(data.rows) &&
      data.rows.length === 1 &&
      Number(Array.isArray(data.rows[0]) ? data.rows[0][0] : data.rows[0].matches) === 0;
    controls.evidence = controls.readRan && stats.processed > 0 && errors.length === 0;
  } catch (error) {
    errors.push(clean(String(error), 800));
  }
  controls.ok =
    errors.length === 0 &&
    controls.evidence &&
    controls.positiveIgnore &&
    controls.positiveEngage &&
    controls.negative;
  controls.countsValid = controls.ok;
  stats.countsVoid = !controls.ok;
  // Add briefs to the returned object before committing dedupe markers. Persist
  // the brief in each marker as well, so a downstream delivery failure is recoverable.
  const output = {
    briefs,
    controls,
    stats,
    fixtureResults,
    specGaps: [...gaps],
    errors,
    nextPageToken: pageToken ?? null,
  };
  if (controls.ok && !options.dryRun)
    for (const [messageId, value] of pending) {
      try {
        const saved: any = await ctx.swarm.kv_set({
          namespace: dedupeNamespace,
          key: messageId,
          value,
          valueType: "string",
          expiresInSec: 30 * 24 * 60 * 60,
        });
        if (saved?.success === false) throw new Error("KV write rejected");
      } catch (error) {
        output.errors.push(`Failed dedupe write: ${messageId}: ${clean(String(error), 300)}`);
        break;
      }
      stats.kvWritten++;
    }
  if (output.errors.length) {
    controls.ok = false;
    controls.countsValid = false;
    stats.countsVoid = true;
  }
  return output;
}
