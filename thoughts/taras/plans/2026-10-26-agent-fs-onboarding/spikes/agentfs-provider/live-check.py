import json,os,subprocess,sys,time,urllib.request,socket,sqlite3,glob
W="/Users/taras/worktrees/agent-fs/2026-10-26-afo-spike"
T="/tmp/afo-spike-agentfs-provider"
s=socket.socket(); s.bind(("127.0.0.1",0)); port=s.getsockname()[1]; s.close()
env=dict(os.environ, AGENT_FS_HOME=T+"/home", AGENT_FS_STORAGE_PROVIDER="local", SERVER_PORT=str(port), SERVER_HOST="127.0.0.1",
  EMBEDDING_PROVIDER="openai-compat", EMBEDDING_MODEL="nomic-ai/nomic-embed-text-v1.5",
  AGENT_FS_EMBEDDING_BASE_URL="http://localhost:8091/v1", AGENT_FS_EMBEDDING_QUERY_PREFIX="search_query: ",
  AGENT_FS_EMBEDDING_DOCUMENT_PREFIX="search_document: ", ANONYMIZED_TELEMETRY="false", DO_NOT_TRACK="1")
for k in ("OPENAI_API_KEY","GEMINI_API_KEY","EMBEDDING_API_KEY"): env.pop(k,None)
log=open(T+"/server.log","w")
p=subprocess.Popen(["bun","packages/server/src/index.ts"],cwd=W,env=env,stdout=log,stderr=subprocess.STDOUT)
base=f"http://127.0.0.1:{port}"
def req(path,body=None,key=None):
    r=urllib.request.Request(base+path,json.dumps(body).encode() if body is not None else None,{"Content-Type":"application/json",**({"Authorization":"Bearer "+key} if key else {})})
    return json.load(urllib.request.urlopen(r,timeout=60))
try:
    for _ in range(60):
        try: req("/health"); break
        except Exception: time.sleep(0.5)
    reg=req("/auth/register",{"email":"spike@example.com"}); key=reg["apiKey"]; org=reg["orgId"]
    op=lambda o,**kw: req(f"/orgs/{org}/ops",{"op":o,**kw},key)
    files={"/notes/cooking.md":"Simmer the tomato sauce with garlic and basil for twenty minutes, then add fresh pasta.",
           "/notes/rust.md":"Rust ownership and borrowing guarantee memory safety without a garbage collector.",
           "/notes/hiking.md":"The mountain trail climbs through pine forest to an alpine lake with a steep final ridge."}
    for path,c in files.items(): op("write",path=path,content=c)
    time.sleep(5)
    out={}
    for q in ["how do I make pasta sauce","memory safety in systems programming","walking up a mountain"]:
        r=op("vec-search",query=q,limit=3); out[q]=r
        print(q,"->",[(m.get("path"),round(m.get("score",m.get("similarity",0)),3)) for m in (r.get("results") or r.get("matches") or [])])
    print("raw keys",list(r.keys()))
    db=glob.glob(T+"/home/*.db")+glob.glob(T+"/home/**/*.db",recursive=True)
    print("dbs",db)
finally:
    p.terminate()
    try: p.wait(10)
    except Exception: p.kill()
