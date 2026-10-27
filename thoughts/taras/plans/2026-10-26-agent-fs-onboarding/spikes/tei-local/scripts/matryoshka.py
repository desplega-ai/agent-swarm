import sys, json, numpy as np
sys.path.insert(0,"/tmp/afo-spike-tei/scripts")
from common import *
def emb_v1(texts, dims=None):
    b={"input":texts,"model":"x"}
    if dims: b["dimensions"]=dims
    if isinstance(texts,list) and len(texts)>32:
        return np.vstack([emb_v1(texts[i:i+32],dims) for i in range(0,len(texts),32)])
    r=post("/v1/embeddings",b)
    return np.array([d["embedding"] for d in sorted(r["data"],key=lambda d:d["index"])],dtype=np.float64)
def emb_raw(texts):
    if len(texts)>32:
        return np.vstack([emb_raw(texts[i:i+32]) for i in range(0,len(texts),32)])
    return np.array(post("/embed",{"inputs":texts,"normalize":False,"truncate":True}),dtype=np.float64)
def ln(x,eps=1e-5):
    m=x.mean(-1,keepdims=True); v=x.var(-1,keepdims=True); return (x-m)/np.sqrt(v+eps)
def l2(x): return x/np.linalg.norm(x,axis=-1,keepdims=True)
def card(texts,d): return l2(ln(emb_raw(texts))[:,:d])
out={}
# 1. dims + norms
t=["search_document: The scheduler runs a heartbeat sweep every few seconds to find stalled tasks."]
for d in (768,512,256):
    e=emb_v1(t,d); out[f"v1_dims_{d}"]={"len":e.shape[1],"norm":round(float(np.linalg.norm(e[0])),6)}
e0=emb_v1(t); out["v1_nodims"]={"len":e0.shape[1],"norm":round(float(np.linalg.norm(e0[0])),6)}
raw=emb_raw(t); out["raw_embed_norm"]=round(float(np.linalg.norm(raw[0])),4)
# is TEI 512 == l2(first 512 of 768)?
e768=emb_v1(t,768); e512=emb_v1(t,512)
out["tei512_equals_trunc_l2_of_768"]=round(float(np.abs(e512-l2(e768[:,:512])).max()),8)
# /embed with dimensions?
try:
    r=post("/embed",{"inputs":t,"dimensions":512}); out["embed_dimensions_param_len"]=len(r[0])
except Exception as ex: out["embed_dimensions_param"]=str(ex)[:100]
# 2. 20 texts cosine
import glob
chs=chunks_of_tokens(120,20)
docs=["search_document: "+c for c,_ in chs]
a=emb_v1(docs,512); b=card(docs,512)
cos=(a*b).sum(1); out["cos_tei512_vs_card512_20texts"]={"mean":round(float(cos.mean()),4),"min":round(float(cos.min()),4),"max":round(float(cos.max()),4)}
# also vs plain 768 truncation w/o LN, and tei256 vs card256
b256=card(docs,256); a256=emb_v1(docs,256)
out["cos_tei256_vs_card256"]=round(float((a256*b256).sum(1).mean()),4)
# 3. retrieval
topics={
"api key rotation":["Rotate the swarm API key by setting AGENT_SWARM_API_KEY and restarting the server.","API keys can be revoked and reissued from the credentials page.","Leaked tokens must be rotated immediately and the old key revoked.","The worker reads its bearer key from the environment at startup.","Per-run tokens are minted for scripts and revoked when the run ends."],
"heartbeat and stalled tasks":["The heartbeat sweep finds tasks whose worker stopped reporting progress.","A stalled task is re-queued after the liveness threshold passes.","Crash recovery routes an orphaned task to a healthy worker.","Workers poll the API every few seconds so the server knows they are alive.","The reaper marks agents offline when heartbeats stop arriving."],
"database migrations":["Migrations are forward-only SQL files numbered in order.","Never edit an applied migration, add a new one instead.","The runner applies pending migrations when the API server starts.","A duplicate migration ordinal is silently skipped, which is dangerous.","SQLite has no down migrations because rollbacks are flaky."],
"docker images":["The worker image has a slim target for CI and a full target for production.","Do not chown the whole home directory in its own layer, it duplicates gigabytes.","Pin the bun base image tag so builds are reproducible.","The API image is small because it ships a compiled binary.","Measure layer sizes with docker history before changing the Dockerfile."],
"slack integration":["The Slack bot listens for mentions and turns them into tasks.","Set SLACK_DISABLE to true to turn the Slack integration off locally.","Thread replies are routed back to the same task.","The dev workspace has a channel used for manual bot testing.","Slack messages are posted by the lead agent when a task completes."],
"memory search":["Memory search embeds the query and ranks stored chunks by cosine similarity.","Memories expire after a time to live that depends on their source.","Manual memories never decay and stay relevant forever.","Embedding vectors are stored in a sqlite-vec table with fixed dimensions.","If no embedding key is set, memory falls back to full text search."],
"workflow nodes":["Workflows are graphs of nodes connected through next edges.","Upstream node outputs are only available after declaring an inputs mapping.","A swarm-script node runs a reusable script from the catalog.","Agent task nodes create a task and wait for its result.","Trigger schemas support a small JSON schema subset."],
"cost tracking":["The adapter reports token usage and the server recomputes cost from a pricing table.","Each cost row is tagged with its source: harness, pricing table or unpriced.","Context usage adds input, cache read, cache create and output tokens.","The pricing snapshot is refreshed from the models.dev cache.","The usage page shows spend per agent and per model."],
"git worktrees":["Create a git worktree to work on a branch without touching the main checkout.","Remove the worktree and its build outputs once the branch is merged.","Each worktree has its own working files but shares the repository history.","Detached worktrees are useful for running a clean copy of main.","Prune stale worktrees to free disk space."],
"ui dashboard":["The dashboard is a React app served by nginx in its own image.","Settings pages are driven by a catalog of configuration keys.","The setup page walks a new user through seven onboarding steps.","Screenshots are required on frontend pull requests.","The task detail page shows the session log and the output."],
}
queries={k:f"{q}" for k,q in zip(topics,[
 "how do I rotate the api key","what happens when a worker stops sending heartbeats","how do database migrations work","how to keep docker images small","how does the slack bot create tasks",
 "how does memory search rank results","how do I pass data between workflow nodes","how is cost computed for a run","how do I clean up git worktrees","what does the setup page in the dashboard do"])}
D=[];lab=[]
for k,v in topics.items():
    for s in v: D.append(s); lab.append(k)
Q=list(queries.values()); qlab=list(queries.keys())
def topk(qv,dv,k=5): return [set(np.argsort(-(qv@dv.T)[i])[:k]) for i in range(len(qv))]
def recall(top):
    return float(np.mean([len([j for j in top[i] if lab[j]==qlab[i]])/5 for i in range(len(Q))]))
def agree(t1,t2): return float(np.mean([len(t1[i]&t2[i])/5 for i in range(len(Q))]))
def run(qp,dp,mode,d):
    f=(lambda x: emb_v1(x,d)) if mode=="tei" else (lambda x: card(x,d))
    return f([qp+q for q in Q]), f([dp+x for x in D])
P=("search_query: ","search_document: ")
res={}
for name,(mode,d,pref) in {"tei512_pref":("tei",512,True),"card512_pref":("card",512,True),"tei768_pref":("tei",768,True),"tei768_nopref":("tei",768,False),"tei256_pref":("tei",256,True),"card256_pref":("card",256,True)}.items():
    qv,dv=run(P[0] if pref else "",P[1] if pref else "",mode,d)
    res[name]=topk(qv,dv)
out["retrieval"]={"queries":len(Q),"docs":len(D),"relevant_per_query":5,
 "recall5_vs_topic_truth":{k:round(recall(v),3) for k,v in res.items()},
 "top5_overlap_tei512_vs_card512":round(agree(res["tei512_pref"],res["card512_pref"]),3),
 "top5_overlap_pref768_vs_nopref768":round(agree(res["tei768_pref"],res["tei768_nopref"]),3),
 "top5_overlap_tei256_vs_card256":round(agree(res["tei256_pref"],res["card256_pref"]),3),
 "top5_overlap_tei512_vs_tei768":round(agree(res["tei512_pref"],res["tei768_pref"]),3)}
json.dump(out,open("/tmp/afo-spike-tei/matryoshka.json","w"),indent=1)
print(json.dumps(out,indent=1))
