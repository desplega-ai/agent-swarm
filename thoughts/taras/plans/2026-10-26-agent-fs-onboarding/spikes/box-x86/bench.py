import json, random, time, threading, urllib.request, statistics, subprocess, sys
URL = "http://127.0.0.1:8081"
random.seed(7)
words = [w.strip() for w in open('/usr/share/dict/words')] if False else None
base = ("agent swarm lead worker task memory search embedding vector file drive document report plan review commit branch deploy "
        "container compose server database schema migration latency throughput cache queue stream token model prompt context "
        "install onboarding dashboard setup credential integration workflow schedule session telemetry release version pipeline "
        "quality coverage test fixture runtime sandbox script binary network proxy tunnel certificate domain storage volume backup").split()
def text(ntok_target=300):
    # ~1 token per word for this vocabulary mix; calibrate via /tokenize
    w = [random.choice(base) + (str(random.randint(0,999)) if random.random()<0.1 else "") for _ in range(int(ntok_target*0.9))]
    return "search_document: " + " ".join(w)
def post(path, body):
    r = urllib.request.Request(URL+path, data=json.dumps(body).encode(), headers={"Content-Type":"application/json"})
    t=time.time(); out=urllib.request.urlopen(r, timeout=300).read(); return time.time()-t, out
# calibrate
t = text(300)
_, o = post("/tokenize", {"inputs": t})
ntok = len(json.loads(o)[0]); print("calibrated tokens per text:", ntok)
def mem():
    return subprocess.run(["docker","stats","--no-stream","--format","{{.MemUsage}} {{.CPUPerc}}","tei-probe"],capture_output=True,text=True).stdout.strip()
print("idle:", mem())
# warm
post("/v1/embeddings", {"model":"x","input":[text(300)]})
def run(batch, conc, reqs):
    lat=[]; lock=threading.Lock(); peak=[]
    stop=False
    def sampler():
        while not stop:
            peak.append(mem()); 
    st=threading.Thread(target=sampler); st.start()
    def worker(n):
        for _ in range(n):
            body={"model":"x","input":[text(300) for _ in range(batch)]}
            d,_=post("/v1/embeddings", body)
            with lock: lat.append(d)
    ths=[threading.Thread(target=worker,args=(reqs//conc,)) for _ in range(conc)]
    t0=time.time(); [x.start() for x in ths]; [x.join() for x in ths]; wall=time.time()-t0
    stop=True; st.join()
    n=len(lat)
    pk=sorted(peak, key=lambda s: float(s.split("GiB")[0]) if "GiB" in s.split()[0] else float(s.split("MiB")[0])/1024)[-1] if peak else "?"
    lat.sort()
    print(f"batch={batch} conc={conc} reqs={n} wall={wall:.1f}s texts/s={n*batch/wall:.2f} tok/s={n*batch*ntok/wall:.0f} req_lat_p50={lat[n//2]:.2f}s max={lat[-1]:.2f}s peak_mem/cpu={pk}", flush=True)
for batch, conc, reqs in [(1,1,12),(1,4,24),(8,1,6),(8,4,12),(32,1,4),(32,4,8)]:
    run(batch, conc, reqs)
# short query latency
qs=["search_query: how do I connect my slack workspace","search_query: where is the quarterly report","search_query: deploy failed", "search_query: who owns billing"]
lat=[]
for i in range(100):
    d,_=post("/v1/embeddings", {"model":"x","input":[qs[i%4]]}); lat.append(d*1000)
lat.sort(); print(f"short query n=100 p50={lat[49]:.1f}ms p95={lat[94]:.1f}ms max={lat[-1]:.1f}ms")
print("after:", mem())
