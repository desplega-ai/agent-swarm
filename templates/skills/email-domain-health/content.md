# Email Domain Health

Build a monitor that tells a person, every working day, whether mail from their
domains authenticates, lands, and stays off blocklists. It has four parts: one
saved script (checks + test send), a Swarm App with run history, one or two
schedules, and an alert that fires only when something gets worse.

This skill decides **what** to build. The mechanics live in other skills; read
them, do not re-derive them:

- [[swarm-scripts]]: authoring, `script-upsert`, scope, connections, secrets.
- [[apps]]: models, named queries, pages, row writes.
- [[scheduling]]: `targetType: "script"` schedules, cron and timezone.
- [[composio-gmail]] (or the user's own mail integration): the test send and
  the bounce search.

Full design notes and pitfalls: the "Email domain health" playbook on the docs
site.

## 1. Ask for requirements first

Ask before building (one batched question, see [[ask-user]]). Do not guess any
of these; a wrong selector or From address makes every later check wrong.

| Ask | Why it matters |
|---|---|
| Domains to monitor, and which one is the envelope/bounce domain | One check set per domain; SPF is judged on the envelope domain. |
| Sending providers per domain (Google Workspace, Microsoft 365, an ESP such as Resend, SES, Postmark) and each DKIM selector | DKIM is looked up at `<selector>._domainkey.<domain>`; there is no way to list selectors. |
| The From address for the test send, and the integration that sends it (Composio Gmail, SMTP, ESP API) | The test must leave through the real path, alias included. |
| Test inbox: mail-tester (free tier has a small daily cap) or an inbox the user owns | Decides how the score is captured. |
| Schedule and timezone | Default: weekdays, morning, user's timezone. |
| Alert channel and thresholds (score floor, bounce rate) | Defaults: score < 6/10, bounces >= 5% on >= 10 sends. |
| History retention | Default 90 days of runs. |

Read the answers back in one short message before you write code.

## 2. Build the checks script

One saved script with modes `send`, `check`, and optionally `backfill`. Keep
domains, selectors, thresholds and ids in a config block at the top or in
`args`, never scattered through the code.

**DNS over HTTPS, two resolvers.** Query every record on two public DoH
resolvers (for example dns.google and Cloudflare's JSON endpoint).
NOERROR and NXDOMAIN are answers; SERVFAIL, REFUSED and timeouts are not.
Same verdict on both: use it. Different verdicts: `warn` ("resolvers
disagree", often propagation). One failed: use the other, note it. Both
failed: `unknown`.

**Checks per domain:**

- SPF: exactly one `v=spf1` record, includes each provider, total DNS lookups
  <= 10 (recurse `include:`/`redirect=`; warn at 9), ends `~all` or `-all`.
- DKIM: TXT at each selector (follow a CNAME), non-empty `p=` (empty means
  revoked), key length.
- DMARC: exactly one `v=DMARC1` at `_dmarc.<domain>`, a `p=` tag, `rua=` (warn
  without it).
- MX: present and pointing at the expected provider.
- Provider records the ESP documents (bounce subdomain SPF and MX, DKIM
  CNAMEs).
- Blocklists: domain lists such as Spamhaus DBL, SURBL, URIBL (details below).
- Test-send result: score plus the SPF, DKIM and DMARC verdicts from the
  receiver's headers.
- Bounce rate: sent vs bounced in the last 24h from the sending mailbox,
  excluding test sends.

**Verdicts:** `ok`, `warn`, `red`, `unknown`. Overall = worst. `unknown` means
"could not read", and it is **never** reported as clean.

**Controls, not hope.** Every negative result needs a positive control in the
same run:

- Blocklists: before trusting a list, query its documented test entry
  (`dbltest.com` on `dbl.spamhaus.org`, `test.surbl.org` on `multi.surbl.org`,
  `test.uribl.com` on `multi.uribl.com`) on each resolver. Use the list only on
  a resolver where the test entry answers "listed". Refusal codes
  (`127.255.255.x` from Spamhaus, `127.0.0.1` from SURBL and URIBL) mean the
  resolver is blocked: `unknown`.
- Bounce rate: a whole-mailbox 24h count of 0 means the search failed:
  `unknown`, not "0 bounces".
- Test result page without a score yet: `unknown` for the first hour after the
  send, then `red`.

Return a `controls.ok` flag with the result so a run that read nothing cannot
pass as green.

**Send mode.** Send one realistic message (the same template and links real
mail uses) to a fresh test address, through the user's integration. Read the
sent message back and confirm the From header kept the address the user asked
for. Store the pending test id in KV with a per-day key so a retry never
sends twice.

## 3. Build the app

Use [[apps]]. Minimum models:

- `run`: one row per run (time, overall, red/warn/unknown counts, score,
  bounces, sent).
- `check`: one row per check per run (history).
- `current`: one row per `domain|check`, updated in place, with `since` = when
  the status last changed.

Optional per-domain views (`domainRun`, `domainCheck`) make tabs per domain
cheap to render. Page: one tab per domain (problems first, raw record on
hover), a score trend, and a collapsed "How it works". The script writes rows
through the row endpoints; prune `run` and `check` rows older than the
retention window.

## 4. Schedule it

Use [[scheduling]] with `targetType: "script"`, not an agent task that says
"run the script". Two schedules: `send`, then `check` 10 to 15 minutes later
in the user's timezone, so the test inbox has the message before the check
reads it.

## 5. Alert only on change

Compare with the previous `current` rows. Alert when a check **turns** red, or
the score drops below the floor after being above it. Never alert on a
steady-state warn or an unknown. The message lists each new red with its raw
detail and links the app. If the script's identity cannot post to the chosen
channel, have it hand the message to an agent that can.

## Done when

- A manual `check` run returns every check, `controls.ok: true`, and writes
  rows the app renders.
- Every blocklist shows either a passing control or `unknown`, never a bare
  "not listed".
- One full scheduled send + check cycle has run and the score landed in `run`.
- You reported the app link, script name and scope, and schedule ids.
