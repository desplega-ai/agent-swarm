#!/usr/bin/env bun
/**
 * Stress pack installer. Called by ../scripts/stress-pack.sh.
 *
 *   bun pack.ts <command> <run> [args]
 *
 * Every API call runs on the box (ssh + curl to 127.0.0.1), so the API key
 * never leaves the box. JSON is processed here, because the box has no jq.
 *
 * The pack acts as the swarm's lead agent: it sends the lead's id in the
 * X-Agent-ID header. Global scripts need a lead, and schedules run global
 * scripts only. The header is an identity. It starts no agent session.
 */
import { dirname, join } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: API payloads are untyped JSON.
type J = Record<string, any>;
type ApiResponse = { status: number; text: string; json: J };

const HERE = dirname(new URL(import.meta.url).pathname);
const NS = "stress";
const PREFIX = "stress-";

const REMOTE = `set -euo pipefail
method="$1"; path="$2"; has_body="$3"; shift 3
key=""
while read -r f; do
  key="$(grep -E '^(AGENT_SWARM_API_KEY|API_KEY)=' "$f" | head -1 | cut -d= -f2- | tr -d "\\"'" || true)"
  [ -n "$key" ] && break
done < <(find /root /home /opt /srv -maxdepth 4 -name .env -not -path '*/node_modules/*' 2>/dev/null)
[ -n "$key" ] || { echo "no API key found in any .env on the box" >&2; exit 3; }
port="$(docker ps --format '{{.Image}} {{.Ports}}' 2>/dev/null | grep -E 'desplega-ai/agent-swarm:' | grep -oE '[0-9]+->3013' | head -1 | cut -d- -f1 || true)"
out="$(mktemp)"
args=(-sS -m 150 -o "$out" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $key")
for h in "$@"; do args+=(-H "$h"); done
[ "$has_body" = 1 ] && args+=(-H 'Content-Type: application/json' --data-binary @-)
code="$(curl "\${args[@]}" "http://127.0.0.1:\${port:-3013}$path")" || code=000
cat "$out"; rm -f "$out"; printf '\\n%s' "$code"`;

function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class Box {
  constructor(
    private readonly cfg: string,
    public leadId = "",
  ) {}

  /** One API call on the box. `agent` adds the lead's X-Agent-ID. */
  async api(
    method: string,
    path: string,
    body?: unknown,
    opts: { agent?: boolean; headers?: string[] } = {},
  ): Promise<ApiResponse> {
    const headers = [...(opts.headers ?? [])];
    if (opts.agent !== false && this.leadId) headers.push(`X-Agent-ID: ${this.leadId}`);
    const remote = [
      "bash",
      "-c",
      shq(REMOTE),
      "_",
      shq(method),
      shq(path),
      body === undefined ? "0" : "1",
      ...headers.map(shq),
    ].join(" ");
    const proc = Bun.spawn(
      [
        "ssh",
        "-F",
        this.cfg,
        "-o",
        "BatchMode=yes",
        "-o",
        "ControlMaster=auto",
        "-o",
        "ControlPath=/tmp/stress-pack-ssh-%C",
        "-o",
        "ControlPersist=120",
        "box",
        remote,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    if (body !== undefined) proc.stdin.write(JSON.stringify(body));
    await proc.stdin.end();
    const [out, err, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exit !== 0) throw new Error(`ssh failed (${exit}) for ${method} ${path}: ${err.trim()}`);
    const cut = out.lastIndexOf("\n");
    const text = out.slice(0, cut);
    let json: J = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    return { status: Number(out.slice(cut + 1)), text, json };
  }

  async must(
    label: string,
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [200, 201, 204],
  ): Promise<ApiResponse> {
    const res = await this.api(method, path, body);
    if (!okStatuses.includes(res.status)) {
      throw new Error(`${label}: HTTP ${res.status} ${res.text.slice(0, 600)}`);
    }
    return res;
  }

  kvPath(key: string): string {
    return `/api/kv/_/${NS}/${encodeURIComponent(key)}`;
  }

  async kvGet(key: string): Promise<unknown> {
    const res = await this.api("GET", this.kvPath(key));
    return res.status === 200 ? res.json.value : undefined;
  }

  async kvSet(key: string, value: unknown): Promise<void> {
    await this.must(`kv set ${key}`, "PUT", this.kvPath(key), { value });
  }
}

async function connect(run: string): Promise<Box> {
  const cfg = `/tmp/onboarding-qa-${run}/ssh_config`;
  if (!(await Bun.file(cfg).exists())) {
    throw new Error(`no ssh config at ${cfg} (stack.sh up first)`);
  }
  const box = new Box(cfg);
  const agents = await box.must("list agents", "GET", "/api/agents");
  const list: J[] = Array.isArray(agents.json) ? agents.json : (agents.json.agents ?? []);
  const lead = list.find((agent) => agent.isLead === true);
  if (!lead) throw new Error("the swarm has no lead agent: global scripts need one");
  box.leadId = String(lead.id);
  return box;
}

async function readJson(path: string): Promise<J> {
  return JSON.parse(await Bun.file(path).text());
}

async function scriptSources(): Promise<{ name: string; source: string; meta: J }[]> {
  const dir = join(HERE, "scripts");
  const prelude = await Bun.file(join(dir, "_prelude.ts")).text();
  const meta = await readJson(join(HERE, "scripts.json"));
  const out: { name: string; source: string; meta: J }[] = [];
  for (const name of Object.keys(meta)) {
    const body = await Bun.file(join(dir, `${name}.ts`)).text();
    out.push({ name, source: `${prelude}\n${body}`, meta: meta[name] });
  }
  return out;
}

async function listWorkflows(box: Box): Promise<J[]> {
  const res = await box.must("list workflows", "GET", "/api/workflows");
  const list: J[] = Array.isArray(res.json) ? res.json : (res.json.workflows ?? []);
  return list.filter((wf) => String(wf.name).startsWith(PREFIX));
}

async function listSchedules(box: Box): Promise<J[]> {
  const res = await box.must("list schedules", "GET", "/api/schedules");
  const list: J[] = res.json.schedules ?? [];
  return list.filter((schedule) => String(schedule.name).startsWith(PREFIX));
}

async function listScripts(box: Box): Promise<J[]> {
  const res = await box.must("list scripts", "GET", "/api/scripts?scope=global");
  const list: J[] = res.json.scripts ?? [];
  return list.filter((script) => String(script.name).startsWith(PREFIX));
}

function parseLevel(raw: string | undefined): number {
  const level = Number(raw);
  if (!Number.isInteger(level) || level < 1 || level > 3) {
    throw new Error("level must be 1, 2 or 3");
  }
  return level;
}

async function upsertScripts(box: Box, only?: string): Promise<void> {
  for (const script of await scriptSources()) {
    if (only && script.name !== only) continue;
    const res = await box.api("POST", "/api/scripts/upsert", {
      name: script.name,
      source: script.source,
      description: script.meta.description,
      intent: script.meta.intent ?? script.meta.description,
      scope: "global",
    });
    if (res.status !== 200) {
      throw new Error(`upsert ${script.name}: HTTP ${res.status}\n${res.text.slice(0, 3000)}`);
    }
    console.log(`script   ${script.name} v${res.json.version ?? "?"}`);
  }
}

/** A throwaway signing secret for the stress webhook. Never printed. */
function webhookSecret(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
}

async function installWorkflows(box: Box, secret: string): Promise<Map<string, string>> {
  const wfDir = join(HERE, "workflows");
  const order: string[] = (await readJson(join(HERE, "workflows.json"))).order;
  const existing = new Map((await listWorkflows(box)).map((wf) => [String(wf.name), wf]));
  const ids = new Map<string, string>();
  for (const name of order) {
    let text = await Bun.file(join(wfDir, `${name}.json`)).text();
    for (const [known, id] of ids) text = text.replaceAll(`__WF:${known}__`, id);
    const body = JSON.parse(text.replaceAll("__WEBHOOK_SECRET__", secret));
    const found = existing.get(name);
    const res = found
      ? await box.must(`update workflow ${name}`, "PUT", `/api/workflows/${found.id}`, body)
      : await box.must(`create workflow ${name}`, "POST", "/api/workflows", body);
    const id = String(found?.id ?? res.json.id);
    ids.set(name, id);
    console.log(`workflow ${name} ${id}`);
  }
  return ids;
}

async function installSchedules(box: Box, ids: Map<string, string>, secret: string): Promise<void> {
  for (const schedule of await listSchedules(box)) {
    await box.must(`delete schedule ${schedule.name}`, "DELETE", `/api/schedules/${schedule.id}`);
  }
  const text = await Bun.file(join(HERE, "schedules.json")).text();
  const schedules: J[] = JSON.parse(text.replaceAll("__WEBHOOK_SECRET__", secret)).schedules;
  for (const schedule of schedules) {
    const body = { ...schedule };
    if (body.workflow) {
      body.workflowId = ids.get(body.workflow);
      delete body.workflow;
    }
    await box.must(`create schedule ${schedule.name}`, "POST", "/api/schedules", body);
    console.log(
      `schedule ${schedule.name} (${schedule.cronExpression}) -> ${schedule.scriptName ?? schedule.workflow}`,
    );
  }
}

async function install(box: Box, levelArg?: string): Promise<void> {
  // Off first: a schedule that fires in the middle of the install does nothing.
  await box.kvSet("stress/enabled", false);
  const level = levelArg ? parseLevel(levelArg) : ((await box.kvGet("stress/level")) ?? 1);
  await box.kvSet("stress/level", level);
  if ((await box.kvGet("stress/installedAt")) === undefined) {
    await box.kvSet("stress/installedAt", new Date().toISOString());
  }

  await upsertScripts(box);

  const secret = webhookSecret();
  const ids = await installWorkflows(box, secret);
  await installSchedules(box, ids, secret);

  await box.kvSet("stress/enabled", true);
  console.log(`installed at level ${level}. Lead identity: ${box.leadId}`);
}

async function setSchedulesEnabled(box: Box, enabled: boolean): Promise<void> {
  for (const schedule of await listSchedules(box)) {
    await box.must(`patch schedule ${schedule.name}`, "PATCH", `/api/schedules/${schedule.id}`, {
      enabled,
    });
  }
}

function kv(counts: J | undefined): string {
  const parts = Object.entries(counts ?? {}).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

async function status(box: Box, asJson: boolean): Promise<void> {
  const [enabled, level, installedAt, board] = await Promise.all([
    box.kvGet("stress/enabled"),
    box.kvGet("stress/level"),
    box.kvGet("stress/installedAt"),
    box.kvGet("stress/scoreboard") as Promise<J | undefined>,
  ]);
  if (asJson) {
    console.log(
      JSON.stringify({ enabled, level, installedAt, scoreboard: board ?? null }, null, 2),
    );
    return;
  }
  console.log(`enabled: ${enabled}   level: ${level}   installed: ${installedAt} (UTC)`);
  const schedules = await listSchedules(box);
  console.log(`\nschedules (${schedules.length}):`);
  for (const schedule of schedules) {
    const errors = schedule.consecutiveErrors ? ` errors=${schedule.consecutiveErrors}` : "";
    const last = schedule.lastErrorMessage ? ` last="${schedule.lastErrorMessage}"` : "";
    console.log(
      `  ${schedule.enabled ? "on " : "OFF"} ${String(schedule.name).padEnd(24)} ${String(
        schedule.cronExpression,
      ).padEnd(13)} lastRun=${schedule.lastRunAt ?? "never"}${errors}${last}`.slice(0, 240),
    );
  }
  if (!board) {
    console.log("\nno scoreboard yet (stress-scoreboard runs every 5 minutes)");
    return;
  }
  console.log(
    `\nscoreboard of ${board.at} (UTC), engine ${board.dialect}: ${board.ok ? "OK" : "NOT OK"}`,
  );
  console.log(`  script runs    last 10 min: ${kv(board.scriptRuns?.last10m)}`);
  console.log(`                 since install: ${kv(board.scriptRuns?.sinceInstall)}`);
  for (const row of (board.scriptRuns?.failedByScript ?? []) as J[]) {
    console.log(
      `                 failed: ${row.name} x${row.n}${row.planned ? " (planned)" : ` UNPLANNED ${row.error}`}`,
    );
  }
  console.log(`  workflow runs  last 10 min: ${kv(board.workflowRuns?.last10m)}`);
  console.log(`                 since install: ${kv(board.workflowRuns?.sinceInstall)}`);
  console.log(
    `\n  ${"piece".padEnd(15)}${"10m pass/fail".padEnd(15)}${"total pass/fail".padEnd(17)}${"avg ms".padEnd(8)}${"max ms".padEnd(8)}last (UTC)`,
  );
  for (const [name, p] of Object.entries((board.pieces ?? {}) as Record<string, J>)) {
    console.log(
      `  ${name.padEnd(15)}${`${p.pass10m}/${p.fail10m}`.padEnd(15)}${`${p.passTotal}/${p.failTotal}`.padEnd(17)}${String(
        p.avgMs,
      ).padEnd(8)}${String(p.maxMs).padEnd(8)}${String(p.lastAt).slice(11, 19)}`,
    );
  }
  const failing: J[] = board.failing ?? [];
  console.log(`\n  failing checks: ${failing.length}`);
  for (const f of failing) {
    console.log(`  - ${f.piece} / ${f.check}  x${f.count} (last 10 min: ${f.count10m})`);
    console.log(`      ${String(f.newestError).slice(0, 300)}`);
  }
  const problems: string[] = board.problems ?? [];
  console.log(`\n  problems: ${problems.length === 0 ? "none" : ""}`);
  for (const problem of problems) console.log(`  - ${problem}`);
  for (const run of (board.stuckRuns ?? []) as J[]) {
    console.log(`  - stuck run ${run.id} (${run.name}, ${run.status}, started ${run.started})`);
  }
  for (const step of (board.failedSteps ?? []) as J[]) {
    console.log(
      `  - failed node ${step.name}/${step.node} x${step.n}: ${String(step.error).slice(0, 200)}`,
    );
  }
  console.log(
    `\n  KV: ${board.kv?.resultRecords} result records, ${board.kv?.deletedThisRun} old keys deleted by the last scoreboard run`,
  );
}

async function deleteKvPrefix(box: Box, prefix: string): Promise<number> {
  let deleted = 0;
  for (let round = 0; round < 200; round++) {
    const res = await box.must(
      "list kv",
      "GET",
      `/api/kv/_/${NS}?prefix=${encodeURIComponent(prefix)}&limit=1000`,
    );
    const entries: J[] = res.json.entries ?? [];
    if (entries.length === 0) break;
    for (const entry of entries) {
      const gone = await box.api("DELETE", box.kvPath(String(entry.key)));
      if (gone.status === 204) deleted++;
    }
  }
  return deleted;
}

async function query(box: Box, sql: string, params: unknown[] = []): Promise<J[]> {
  const res = await box.api("POST", "/api/db-query", { sql, params });
  if (res.status !== 200) return [];
  const columns: string[] = res.json.columns ?? [];
  return (res.json.rows ?? []).map((row: unknown[]) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index]])),
  );
}

async function remove(box: Box): Promise<void> {
  await box.kvSet("stress/enabled", false);
  for (const schedule of await listSchedules(box)) {
    await box.must(`delete schedule ${schedule.name}`, "DELETE", `/api/schedules/${schedule.id}`);
    console.log(`deleted schedule ${schedule.name}`);
  }
  const workflows = await listWorkflows(box);
  for (const wf of workflows) {
    const runs = await box.api("GET", `/api/workflows/${wf.id}/runs?limit=100`);
    const open: J[] = (runs.json.runs ?? runs.json ?? []).filter?.((run: J) =>
      ["running", "waiting"].includes(String(run.status)),
    );
    for (const run of open ?? []) await box.api("POST", `/api/workflow-runs/${run.id}/cancel`, {});
  }
  // Parents first: a workflow that another one calls is deleted after its caller.
  const order: string[] = (await readJson(join(HERE, "workflows.json"))).order;
  const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : -1);
  for (const wf of workflows.sort((a, b) => rank(String(b.name)) - rank(String(a.name)))) {
    await box.must(`delete workflow ${wf.name}`, "DELETE", `/api/workflows/${wf.id}`);
    console.log(`deleted workflow ${wf.name} (its runs and steps go with it)`);
  }
  for (const script of await listScripts(box)) {
    await box.must(
      `delete script ${script.name}`,
      "DELETE",
      `/api/scripts/${encodeURIComponent(String(script.name))}?scope=global`,
    );
    console.log(`deleted script ${script.name}`);
  }
  // List by recency (no query): a memory search is not needed to find them.
  let memoryCount = 0;
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await box.api("POST", "/api/memory/list", {
      agentId: box.leadId,
      limit: 100,
      offset,
    });
    const rows: J[] = page.json.results ?? [];
    for (const memory of rows.filter((row) => String(row.name).startsWith("stress-mem-"))) {
      const gone = await box.api("DELETE", `/api/memory/${memory.id}`);
      if (gone.status < 300) memoryCount++;
    }
    if (rows.length < 100) break;
  }
  console.log(`deleted ${memoryCount} stress memories`);

  // A run that was in flight can still write. Sweep the namespace twice.
  let kvCount = await deleteKvPrefix(box, "");
  await Bun.sleep(8000);
  kvCount += await deleteKvPrefix(box, "");
  console.log(`deleted ${kvCount} KV keys in namespace "${NS}"`);

  const left = await query(
    box,
    `select count(*) as n from script_runs where "scriptName" like 'stress-%'`,
  );
  console.log(
    `left behind: ${left[0]?.n ?? "?"} script_runs rows for stress scripts (audit rows; SCRIPT_RUNS_RETENTION_DAYS prunes them) and the hashed idempotency records of deleted workflows.`,
  );
}

async function main(): Promise<void> {
  const [command, run, ...rest] = process.argv.slice(2);
  if (!command || !run || !/^[a-z0-9][a-z0-9-]{2,40}$/.test(run)) {
    console.error(
      "usage: stress-pack.sh <install|status|pause|resume|level|reset|remove> <run> [args]",
    );
    process.exit(2);
  }
  const box = await connect(run);
  switch (command) {
    case "install":
      await install(box, rest[0] === "--level" ? rest[1] : undefined);
      break;
    case "status":
      await status(box, rest.includes("--json"));
      break;
    case "reset": {
      // Clear the result records and the counters. The pack keeps running.
      let cleared = 0;
      for (const prefix of ["stress/results/", "stress/totals/", "stress/scoreboard"]) {
        cleared += await deleteKvPrefix(box, prefix);
      }
      await box.kvSet("stress/installedAt", new Date().toISOString());
      console.log(`cleared ${cleared} keys. Counters start again from now`);
      break;
    }
    case "pause":
      await box.kvSet("stress/enabled", false);
      await setSchedulesEnabled(box, false);
      console.log("paused: stress/enabled=false and every stress schedule is disabled");
      break;
    case "resume":
      await setSchedulesEnabled(box, true);
      await box.kvSet("stress/enabled", true);
      console.log("resumed");
      break;
    case "level":
      await box.kvSet("stress/level", parseLevel(rest[0]));
      console.log(`level set to ${rest[0]}. Scripts read it on their next run`);
      break;
    case "remove":
      await remove(box);
      break;
    case "workflows":
      // Save the scripts and the workflows only. No schedule is created.
      await upsertScripts(box);
      await installWorkflows(box, webhookSecret());
      break;
    case "fire": {
      // Run one stress schedule now, outside its cron.
      const schedule = (await listSchedules(box)).find((item) => item.name === rest[0]);
      if (!schedule) throw new Error(`no schedule named ${rest[0]}`);
      const res = await box.api("POST", `/api/schedules/${schedule.id}/run`, {});
      console.log(`HTTP ${res.status} ${res.text.slice(0, 400)}`);
      break;
    }
    case "upsert":
      // Save one script again (or all of them) without touching the rest.
      await upsertScripts(box, rest[0]);
      break;
    case "run": {
      // Run one saved script now and print the run envelope.
      const res = await box.api("POST", "/api/scripts/run", {
        name: rest[0],
        scope: "global",
        args: rest[1] ? JSON.parse(rest[1]) : undefined,
      });
      console.log(`HTTP ${res.status}`);
      console.log(JSON.stringify(res.json, null, 2).slice(0, Number(rest[2] ?? 6000)));
      break;
    }
    case "trigger": {
      // Start one stress workflow now and print the run id.
      const wf = (await listWorkflows(box)).find((item) => item.name === rest[0]);
      if (!wf) throw new Error(`no workflow named ${rest[0]}`);
      const res = await box.api(
        "POST",
        `/api/workflows/${wf.id}/trigger?wait=false`,
        rest[1] ? JSON.parse(rest[1]) : {},
      );
      console.log(`HTTP ${res.status} ${res.text.slice(0, 400)}`);
      break;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

await main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
