import json, urllib.request, uuid, time, sqlite3, sys, struct
K=open("/tmp/afo-spike-tei/swarm/key.txt").read().strip()
AID=str(uuid.uuid4())
B="http://localhost:3213"
def call(path, body=None, method="POST"):
    r=urllib.request.Request(B+path, data=json.dumps(body).encode() if body is not None else None, method=method,
        headers={"Authorization":"Bearer "+K,"X-Agent-ID":AID,"Content-Type":"application/json"})
    try: return json.load(urllib.request.urlopen(r,timeout=120))
    except urllib.error.HTTPError as e: return {"_status":e.code,"_body":e.read().decode()[:300]}
mems=[("rotate-api-key","To rotate the swarm API key, generate a new random value, set AGENT_SWARM_API_KEY on the server and restart it, then update every worker."),
("heartbeat-sweep","The heartbeat sweep finds in-progress tasks whose worker stopped reporting and re-queues them after the liveness threshold."),
("db-migrations","Database migrations are forward-only SQL files in src/be/migrations. Never edit an applied migration, add a new numbered file."),
("slim-image","The worker-slim Docker target skips heavy tools so CI and E2E pull a smaller image than the full production worker."),
("pasta-recipe","Boil salted water, cook spaghetti nine minutes, and toss with garlic, olive oil and chili flakes for a quick dinner.")]
print("agent",AID[:8])
for n,c in (mems if 'index' in sys.argv else []):
    r=call("/api/memory/index",{"agentId":AID,"content":c,"name":n,"scope":"swarm","source":"manual"})
    print("index",n,r if "_status" in r else {k:r[k] for k in ("queued",)})
time.sleep(1)
for q in ["how do I change the api key","what happens if a worker crashes mid task","how to add a schema change","make the container smaller for CI","what should I cook tonight"]:
    t=time.time(); r=call("/api/memory/search",{"query":q,"limit":3,"scope":"all"}); dt=(time.time()-t)*1000
    print("Q:",q,"| %.0fms"%dt)
    for x in r.get("results",[]): print("   %.3f %s %s"%(x["similarity"],x.get("retrievalSource"),x["name"]))
    if "_status" in r: print(r)
