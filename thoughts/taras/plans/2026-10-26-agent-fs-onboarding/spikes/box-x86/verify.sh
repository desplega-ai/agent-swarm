#!/bin/bash
# Runs ON the box. Never prints keys. Usage: bash verify.sh
set -u
cd ~/agent-swarm
KEY=$(grep -E '^API_KEY=' .env | cut -d= -f2-)
LEAD=$(grep -E 'lead = ' .env | sed -E 's/.*= //')
API=http://127.0.0.1:3013
NET=agent-swarm_default
TEIIMG=ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4
swarm() { curl -sS -X "$1" -H "Authorization: Bearer $KEY" -H "X-Agent-ID: $LEAD" -H 'Content-Type: application/json' ${3:+--data "$3"} "$API$2"; }
now() { date +%s.%N; }
stats() { docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | sed -E 's/ \/ [0-9.]+[GM]iB//' | sort | grep -E 'swarm-(api|agent-fs|tei|lead|worker-coder)'; }
sampler() { # sampler <file> ; runs until killed
  while true; do docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep -E 'swarm-(api|agent-fs|tei) ' | sed -E 's/ \/ [0-9.]+[GM]iB//' >> "$1"; done; }
peak() { # peak <file>
  python3 -I - "$1" <<'PY'
import sys,re,collections
pk=collections.defaultdict(lambda:[0,0])
for l in open(sys.argv[1]):
    n,m,c=l.split()
    v=float(re.sub(r'[A-Za-z]+','',m)); v=v*1024 if 'GiB' in m else v
    cp=float(c.rstrip('%'))
    pk[n][0]=max(pk[n][0],v); pk[n][1]=max(pk[n][1],cp)
for n,(m,c) in sorted(pk.items()): print(f"  peak {n}: {m:.0f} MiB, cpu {c:.0f}%")
PY
}

echo "## IDLE (after boot settle)"; stats; free -m | head -2
echo
echo "## MEMORY: index 12 notes (swarm scope), wait for async embedding via TEI"
python3 -I - <<'PY' > /tmp/mem-notes.json
import json
notes=[
 ("deploy-runbook","To release a new version, merge the release pull request and the pipeline publishes the container images automatically."),
 ("cat-habits","The office cat likes to nap on the warm windowsill and watch the pigeons outside."),
 ("billing-owner","Invoices and subscription payments are handled by the finance lead, reach out to her for refunds."),
 ("slack-setup","To connect a chat workspace, create an app with bot scopes and paste the signing secret into the integrations page."),
 ("db-backup","The SQLite database is copied nightly to object storage and kept for thirty days."),
 ("onboarding-faq","New users finish the setup wizard by naming the swarm, adding a model credential and sending a first task."),
 ("coffee","The espresso machine on the second floor needs descaling every month."),
 ("incident-2026","During the outage the queue backed up because the worker pool lost its heartbeat to the API."),
 ("style-guide","Write short sentences, avoid jargon and prefer active voice in all customer documentation."),
 ("travel","Flights to the offsite are booked through the travel desk, economy class unless the trip is over six hours."),
 ("security","Rotate access tokens every ninety days and never paste credentials into chat messages."),
 ("hiring","Interview loops have four stages: screen, take-home, team conversation and a founder chat."),
]
print(json.dumps(notes))
PY
python3 -I - <<'PY' > /tmp/mem-index.sh
import json
for n,c in json.load(open('/tmp/mem-notes.json')):
    print(json.dumps({"agentId":"LEAD","content":c,"name":n,"scope":"swarm","source":"manual"}))
PY
T0=$(now)
while read -r body; do
  swarm POST /api/memory/index "$(echo "$body" | sed "s/LEAD/$LEAD/")" -o /dev/null -w '%{http_code} ' ; 
done < /tmp/mem-index.sh; echo
for i in $(seq 1 90); do
  c=$(swarm GET /api/memory/health)
  echo "$c" | grep -q '"retrievalMode":"vec"' && break; sleep 2
done
echo "vec retrieval ready after $(echo "$(now)-$T0" | bc) s"
echo "health(last): $c"
for q in "how do I publish a release" "feline resting near the window" "who do I ask about money back" "connect our team chat" "keep copies of the database" "the system went down because workers disconnected"; do
  echo "Q: $q"
  swarm POST /api/memory/search "{\"query\":\"$q\",\"limit\":3,\"scope\":\"all\"}" | python3 -I -c '
import sys,json
d=json.load(sys.stdin)
for r in d.get("results",[]): print("   %-16s sim=%.3f src=%s" % (r["name"], r["similarity"], r.get("retrievalSource")))'
done
echo
echo "## AGENT-FS: write 20 files with the lead's agent key, then semantic search"
AKEY=$(swarm GET "/api/config/resolved?agentId=$LEAD&includeSecrets=true" | python3 -I -c '
import sys,json
d=json.load(sys.stdin)
rows=d.get("configs",d) if isinstance(d,dict) else d
print(next((r["value"] for r in rows if r["key"]=="AGENT_FS_API_KEY"),""))')
echo "agent key length: ${#AKEY} (value not printed)"
ORG=$(grep -m1 . /dev/null; swarm GET '/api/config?scope=global' | python3 -I -c '
import sys,json
d=json.load(sys.stdin); rows=d.get("configs",d)
print(next(r["value"] for r in rows if r["key"]=="AGENT_FS_SHARED_ORG_ID"))')
DRIVE=$(swarm GET '/api/config?scope=global' | python3 -I -c '
import sys,json
d=json.load(sys.stdin); rows=d.get("configs",d)
print(next(r["value"] for r in rows if r["key"]=="AGENT_FS_DEFAULT_DRIVE_ID"))')
fscurl() { docker run --rm --network $NET --entrypoint curl $TEIIMG -sS -H "Authorization: Bearer $AKEY" -H 'Content-Type: application/json' "$@"; }
echo "me:"; fscurl http://agent-fs:7433/auth/me | python3 -I -c 'import sys,json; d=json.load(sys.stdin); print("  ", {k:d[k] for k in d if k in ("email","name")}, "orgs:", len(d.get("orgs",[])))'
python3 -I - <<'PY' > /tmp/fs-docs.jsonl
import json
docs={
"notes/cat.md":"The office cat naps on the warm windowsill and watches the pigeons outside.",
"notes/release.md":"Merge the release pull request and the pipeline publishes container images.",
"notes/refunds.md":"Money back requests go to the finance lead who handles invoices and payments.",
"notes/chat.md":"Create a bot app in the team messaging tool and paste the signing secret into settings.",
"notes/backup.md":"The database is copied every night to object storage and kept for thirty days.",
"notes/wizard.md":"The setup wizard asks you to name the swarm, add a model credential and send a first task.",
"notes/coffee.md":"The espresso machine on the second floor needs descaling every month.",
"notes/outage.md":"The queue backed up because worker agents lost their heartbeat to the API server.",
"notes/style.md":"Write short sentences, avoid jargon, prefer the active voice in customer docs.",
"notes/travel.md":"Offsite flights are booked by the travel desk, economy unless over six hours.",
"notes/security.md":"Rotate access tokens every ninety days and never paste credentials in chat.",
"notes/hiring.md":"Interviews have four stages: screen, take-home, team talk and founder chat.",
"notes/pricing.md":"The team plan costs twenty dollars per seat per month, billed annually.",
"notes/roadmap.md":"Next quarter we ship the mobile app, offline mode and a public template gallery.",
"notes/legal.md":"Contracts above fifty thousand euros need a second signature from the CEO.",
"notes/design.md":"Buttons use a single accent colour and 8 pixel spacing multiples.",
"notes/support.md":"Support replies within four business hours, escalate outages to the on-call engineer.",
"notes/data.md":"Analytics events are sampled at ten percent and stored for ninety days.",
"notes/onboard-staff.md":"New employees get a laptop, a mentor and a thirty day plan on their first morning.",
"notes/office.md":"The office is closed on public holidays and the door code changes each quarter.",
}
for p,c in docs.items(): print(json.dumps({"op":"write","path":p,"content":c,"driveId":"DRIVE"}))
PY
SAMP=/tmp/fs-samples.txt; rm -f $SAMP; sampler $SAMP & SP=$!
T0=$(now)
while read -r body; do
  fscurl -X POST "http://agent-fs:7433/orgs/$ORG/ops" --data "$(echo "$body" | sed "s/DRIVE/$DRIVE/")" -o /dev/null -w '%{http_code} '
done < /tmp/fs-docs.jsonl; echo
echo "20 writes done in $(echo "$(now)-$T0" | bc) s"
for i in $(seq 1 90); do
  r=$(fscurl -X POST "http://agent-fs:7433/orgs/$ORG/ops" --data "{\"op\":\"vec-search\",\"query\":\"feline resting near the window\",\"limit\":3,\"driveId\":\"$DRIVE\"}")
  echo "$r" | grep -q '"path"' && break; sleep 2
done
echo "first semantic hit after $(echo "$(now)-$T0" | bc) s total"
for q in "feline resting near the window" "how do I publish a new version" "who do I ask to get my money back" "connect our team chat" "keep copies of the database" "the system went down because agents disconnected" "when do new hires get equipment"; do
  echo "Q: $q"
  for op in vec-search search; do
    echo -n "  [$op] "
    fscurl -X POST "http://agent-fs:7433/orgs/$ORG/ops" --data "{\"op\":\"$op\",\"query\":\"$q\",\"limit\":3,\"driveId\":\"$DRIVE\"}" | python3 -I -c '
import sys,json
d=json.load(sys.stdin)
rs=d.get("results") or d.get("matches") or d.get("hits") or []
if not rs: print("RAW", json.dumps(d)[:200]); sys.exit()
print(" | ".join("%s %.2f" % (r.get("path"), r.get("score", r.get("similarity", r.get("rank", 0)) or 0)) for r in rs[:3]))'
  done
done
kill $SP 2>/dev/null; wait $SP 2>/dev/null
echo; echo "## PEAKS during agent-fs writes + search"; peak $SAMP
echo; echo "## IDLE again"; sleep 15; stats; free -m | head -2
