import sys, time, json, statistics, threading, subprocess
sys.path.insert(0, "/tmp/afo-spike-tei/scripts")
from common import *
from concurrent.futures import ThreadPoolExecutor
ch = chunks_of_tokens(300, 40)
print("chunk tokens", [c for _, c in ch][:10], "n", len(ch))
texts = ["search_document: " + t for t, _ in ch]
def mem():
    return subprocess.run(["docker","stats","--no-stream","--format","{{.MemUsage}}|{{.CPUPerc}}","afo-spike-tei"],capture_output=True,text=True).stdout.strip()
def call(batch):
    t=time.time(); post("/v1/embeddings", {"input": batch, "model":"x"}); return time.time()-t
# warm
call(texts[:2])
res = {}
for bs in (1, 8, 32):
    for conc in (1, 4):
        reqs = max(4, 64 // bs) if bs < 32 else 4
        reqs = max(reqs, conc*2)
        batches = [[texts[(r*bs+j) % len(texts)] for j in range(bs)] for r in range(reqs)]
        peak = [""]
        stop = False
        def sampler():
            while not stop:
                peak[0] = mem() ; 
        th = threading.Thread(target=sampler); th.start()
        t0 = time.time()
        with ThreadPoolExecutor(conc) as ex: lats = list(ex.map(call, batches))
        dt = time.time() - t0
        stop = True; th.join()
        n = reqs*bs
        res[f"bs{bs}_c{conc}"] = dict(reqs=reqs, texts=n, secs=round(dt,2), texts_per_s=round(n/dt,2), req_p50=round(statistics.median(lats),2), mem_during=peak[0])
        print(bs, conc, res[f"bs{bs}_c{conc}"], flush=True)
json.dump(res, open("/tmp/afo-spike-tei/bench_throughput.json","w"), indent=1)
