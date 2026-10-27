import json, urllib.request, os
BASE = os.environ.get("TEI", "http://localhost:8091")
def post(path, body, timeout=300):
    r = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=timeout))
def tokcount(t):
    return len(post("/tokenize", {"inputs": t, "add_special_tokens": False})[0])
def corpus_text():
    p = "/Users/taras/worktrees/agent-swarm/2026-10-26-afo-run/CLAUDE.md"
    p2 = "/Users/taras/worktrees/agent-swarm/2026-10-26-afo-run/runbooks/workflows.md"
    import glob
    return "\n".join(open(f).read() for f in [p,p2]+sorted(glob.glob("/Users/taras/worktrees/agent-swarm/2026-10-26-afo-run/runbooks/*.md"))[:12])
def chunks_of_tokens(n, count):
    words = corpus_text().split()
    k = 200
    for _ in range(6):
        c = tokcount(" ".join(words[:k]))
        k = max(5, int(k * n / c))
    k = int(k*1.25)
    out = []
    for j in range(count):
        t = " ".join(words[j*k:(j+1)*k])
        if not t: break
        out.append((t, tokcount(t)))
    return out
