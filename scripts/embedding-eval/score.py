"""Score retrieval quality for each embedding config on the prod memory corpus.

Simulates prod memory search faithfully where it is model-dependent:
  - candidate filter: own-agent rows OR swarm rows (non-lead HTTP/MCP search),
    and (real queries only) rows created before the recall happened
  - vec arm: cosine, MEMORY_MIN_SIMILARITY floor 0.1, top 60
  - fts arm: FTS5 porter/unicode61 over (name, content), first 12 query terms
    OR-joined (buildFtsMatch), bm25 order, top 60
  - hybrid: RRF k=60 over both arms (no recency decay, no reranker multipliers)

Usage:
  uv run --no-project --with numpy --with regex scripts/embedding-eval/score.py models
  uv run --no-project --with numpy --with regex scripts/embedding-eval/score.py chunking <config>@<dims> ...
"""

import json
import os
import sqlite3
import sys

import numpy as np
import regex

from evallib import DATA_DIR, load_matrix, read_json, truncate_normalize

MIN_SIMILARITY = 0.1
ARM_LIMIT = 60  # searchHybrid overfetch for the pre-task recall call (limit 5 x 3 x 4)
TOP = 100
RRF_K = 60
BASELINE = "oai-3s@512"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")

# name -> (doc config, query config, corpus set, dims to test)
MODELS = {
    "oai-3s": ("oai-3s", "oai-3s", "corpus", [256, 512, 1024, 1536]),
    "oai-3l": ("oai-3l", "oai-3l", "corpus", [256, 512, 1024, 1536, 3072]),
    "gem-001": ("gem-001", "gem-001", "corpus", [256, 512, 768, 1536, 3072]),
    "gem-2": ("gem-2", "gem-2", "corpus", [256, 512, 768, 1536, 3072]),
    "gem-2-or": ("gem-2", "gem-2-or", "corpus", [512, 768, 3072]),
    "qwen3-8b": ("qwen3-8b", "qwen3-8b", "corpus", [512, 1024, 4096]),
    "voyage-4": ("voyage-4", "voyage-4", "corpus", [1024]),
    "oai-3s-named": ("oai-3s", "oai-3s", "corpus-named", [512, 1536]),
}

memories = read_json("memories.json")
N = len(memories)
mem_index = {m["id"]: i for i, m in enumerate(memories)}
mem_agent = np.array([m["agentId"] or "" for m in memories])
mem_swarm = np.array([m["scope"] == "swarm" for m in memories])
mem_created = np.array([m["createdAt"] for m in memories])


# ---------------------------------------------------------------------------
# FTS arm
# ---------------------------------------------------------------------------
def fts_match(text):
    terms = [t for t in regex.split(r"[^\p{L}\p{N}_-]+", text.strip()) if t][:12]
    if not terms:
        return None
    return " OR ".join('"' + t.replace('"', '""') + '"' for t in terms)


def build_fts(rows):
    """rows: list of (row_index, name, content)."""
    db = sqlite3.connect(":memory:")
    db.execute(
        "CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, name, content, tokenize='porter unicode61')"
    )
    db.executemany("INSERT INTO memory_fts VALUES (?, ?, ?)", ((str(i), n, c) for i, n, c in rows))
    return db


def fts_rank(db, text, mask):
    match = fts_match(text)
    if not match:
        return []
    try:
        hits = db.execute(
            "SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT 3000",
            (match,),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    out = []
    for (rid,) in hits:
        i = int(rid)
        if mask[i]:
            out.append(i)
            if len(out) >= ARM_LIMIT:
                break
    return out


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
def metrics(ranked, positives):
    """ranked: list of ids (best first); positives: set of ids."""
    out = {}
    for k in (1, 5, 10):
        top = ranked[:k]
        hits = sum(1 for r in top if r in positives)
        out[f"hit@{k}"] = 1.0 if hits > 0 else 0.0
        out[f"recall@{k}"] = hits / len(positives)
    rr = 0.0
    for i, r in enumerate(ranked[:10]):
        if r in positives:
            rr = 1.0 / (i + 1)
            break
    out["mrr@10"] = rr
    dcg = sum(1.0 / np.log2(i + 2) for i, r in enumerate(ranked[:10]) if r in positives)
    idcg = sum(1.0 / np.log2(i + 2) for i in range(min(len(positives), 10)))
    out["ndcg@10"] = dcg / idcg if idcg else 0.0
    return out




def rrf(vec, fts):
    scores = {}
    for arm in (vec, fts):
        for rank, i in enumerate(arm):
            scores[i] = scores.get(i, 0.0) + 1.0 / (RRF_K + rank + 1)
    return sorted(scores, key=lambda i: -scores[i])


def bootstrap_diff(a, b, n=2000, seed=7):
    """Paired bootstrap 95% CI for mean(a - b)."""
    a = np.asarray(a)
    b = np.asarray(b)
    d = a - b
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(d), size=(n, len(d)))
    means = d[idx].mean(axis=1)
    return float(d.mean()), float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def query_mask(q, agent=mem_agent, swarm=mem_swarm, created=mem_created):
    m = (agent == (q["agentId"] or "")) | swarm
    if q.get("cutoff"):
        m = m & (created < q["cutoff"])
    return m


def vec_rank(sims_row, mask, present, limit):
    s = np.where(mask & present & (sims_row >= MIN_SIMILARITY), sims_row, -np.inf)
    k = min(limit, len(s) - 1)
    top = np.argpartition(-s, k)[:k]
    top = top[np.argsort(-s[top])]
    return [int(i) for i in top if np.isfinite(s[i])]


# ---------------------------------------------------------------------------
# Model comparison
# ---------------------------------------------------------------------------
def run_models(only=None):
    queries = read_json("queries.json")
    sets = sorted({q["set"] for q in queries})
    masks = [query_mask(q) for q in queries]
    positives = [{mem_index[p] for p in q["positives"] if p in mem_index} for q in queries]

    print("building FTS index...", file=sys.stderr)
    fts_db = build_fts([(i, m["name"], m["content"]) for i, m in enumerate(memories)])
    fts_lists = [fts_rank(fts_db, q["text"], masks[i]) for i, q in enumerate(queries)]

    rng = np.random.default_rng(11)
    pair_a = rng.integers(0, N, 5000)
    pair_b = rng.integers(0, N, 5000)

    per_query = {}  # config -> mode -> list of metric dicts
    stats = {}
    rankings = {}  # config -> mode -> query id -> top-10 memory ids (real queries, for judging)
    for name, (doc_cfg, q_cfg, corpus_set, dims_list) in MODELS.items():
        if only and name not in only and name != "oai-3s":
            continue
        doc_ids, doc_full, present = load_matrix(doc_cfg, corpus_set)
        assert doc_ids == [m["id"] for m in memories]
        q_ids, q_full, q_present = load_matrix(q_cfg, "queries")
        assert q_ids == [q["id"] for q in queries]
        for dims in dims_list:
            key = f"{name}@{dims}"
            print(f"scoring {key}", file=sys.stderr)
            D = truncate_normalize(doc_full, dims)
            Q = truncate_normalize(q_full, dims)
            sims = Q @ D.T
            rows = {"vec": [], "hybrid": []}
            rankings[key] = {"vec": {}, "hybrid": {}}
            pos_cos, top1_cos, below_floor = [], [], 0
            for i, q in enumerate(queries):
                vec = vec_rank(sims[i], masks[i], present, TOP) if q_present[i] else []
                hyb = rrf(vec[:ARM_LIMIT], fts_lists[i])
                rows["vec"].append(metrics(vec, positives[i]))
                rows["hybrid"].append(metrics(hyb, positives[i]))
                if q["set"] == "real-pretask":
                    rankings[key]["vec"][q["id"]] = [memories[j]["id"] for j in vec[:10]]
                    rankings[key]["hybrid"][q["id"]] = [memories[j]["id"] for j in hyb[:10]]
                if q["set"].startswith("synthetic") and positives[i]:
                    pc = max(float(sims[i, p]) for p in positives[i])
                    pos_cos.append(pc)
                    below_floor += pc < MIN_SIMILARITY
                    if vec:
                        top1_cos.append(float(sims[i, vec[0]]))
            per_query[key] = rows
            rand_cos = (D[pair_a] * D[pair_b]).sum(axis=1)
            stats[key] = {
                "dims": dims,
                "bytesPerVector": dims * 4,
                "positiveCosineP50": float(np.median(pos_cos)),
                "positiveCosineP10": float(np.percentile(pos_cos, 10)),
                "top1CosineP50": float(np.median(top1_cos)),
                "randomPairCosineP50": float(np.median(rand_cos)),
                "positivesBelowFloor": int(below_floor),
                "positivesAbove04": float(np.mean(np.array(pos_cos) > 0.4)),
                "docsWithoutVector": int((~present).sum()),
            }

    summary = {"n": {s: sum(1 for q in queries if q["set"] == s) for s in sets}, "stats": stats, "results": {}}
    for key, rows in per_query.items():
        summary["results"][key] = {}
        for mode, ms in rows.items():
            summary["results"][key][mode] = {}
            for s in sets:
                sel = [m for m, q in zip(ms, queries) if q["set"] == s]
                base = [m for m, q in zip(per_query[BASELINE][mode], queries) if q["set"] == s]
                entry = {metric: float(np.mean([m[metric] for m in sel])) for metric in sel[0]}
                for metric in ("hit@5", "recall@5", "mrr@10", "ndcg@10"):
                    d, lo, hi = bootstrap_diff([m[metric] for m in sel], [m[metric] for m in base])
                    entry[f"delta_{metric}"] = [d, lo, hi]
                summary["results"][key][mode][s] = entry
    with open(os.path.join(DATA_DIR, "rankings-real.json"), "w") as f:
        json.dump(rankings, f)
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "models.json"), "w") as f:
        json.dump(summary, f, indent=1)
    print_models(summary)


def fmt_delta(entry, metric):
    d, lo, hi = entry[f"delta_{metric}"]
    sig = "*" if lo > 0 or hi < 0 else ""
    return f"{entry[metric]:.3f} ({d:+.3f}{sig})"


def print_models(summary):
    sets = list(summary["n"].keys())
    for mode in ("vec", "hybrid"):
        for metric in ("hit@5", "mrr@10", "recall@5"):
            print(f"\n### {mode} / {metric} (delta vs {BASELINE}, * = 95% CI excludes 0)\n")
            print("| config | " + " | ".join(f"{s} (n={summary['n'][s]})" for s in sets) + " |")
            print("|---|" + "---|" * len(sets))
            for key, modes in summary["results"].items():
                print(f"| {key} | " + " | ".join(fmt_delta(modes[mode][s], metric) for s in sets) + " |")
    print("\n### cosine scale (synthetic queries)\n")
    print("| config | bytes/vec | positive cos p50 | positive cos p10 | top-1 cos p50 | random pair p50 | positives < 0.1 floor | positives > 0.4 |")
    print("|---|---|---|---|---|---|---|---|")
    for key, s in summary["stats"].items():
        print(
            f"| {key} | {s['bytesPerVector']} | {s['positiveCosineP50']:.3f} | {s['positiveCosineP10']:.3f} | "
            f"{s['top1CosineP50']:.3f} | {s['randomPairCosineP50']:.3f} | {s['positivesBelowFloor']} | {s['positivesAbove04']:.2f} |"
        )


# ---------------------------------------------------------------------------
# Chunking experiment
# ---------------------------------------------------------------------------
STRATEGIES = ["whole", "prod-2000", "rec-1000", "rec-4000", "prod-2000-title", "prod-2000-ctx", "whole+prod-2000"]


def run_chunking(config_keys):
    doc_ids = set(read_json("chunk-docs-used.json"))
    all_queries = read_json("chunk-queries.json")
    keep = [i for i, q in enumerate(all_queries) if q["positives"][0] in doc_ids]
    queries = [all_queries[i] for i in keep]
    sets = sorted({q["set"] for q in queries})
    chunks = read_json("chunks.json")
    base_rows = [i for i, m in enumerate(memories) if m["id"] not in doc_ids]

    summary = {"n": {s: sum(1 for q in queries if q["set"] == s) for s in sets}, "rowsPerDoc": {}, "results": {}}
    fts_cache = {}
    for config_key in config_keys:
        model, dims = config_key.split("@")
        doc_cfg, q_cfg, corpus_set, _ = MODELS[model]
        dims = int(dims)
        c_ids, c_full, c_present = load_matrix(doc_cfg, corpus_set)
        k_ids, k_full, k_present = load_matrix(doc_cfg, "chunks")
        q_ids, q_full, _ = load_matrix(q_cfg, "chunk-queries")
        q_full = q_full[keep]
        C = truncate_normalize(c_full, dims)
        K = truncate_normalize(k_full, dims)
        Qm = truncate_normalize(q_full, dims)
        chunk_pos = {c["id"]: i for i, c in enumerate(chunks)}
        summary["results"][config_key] = {}
        for strategy in STRATEGIES:
            parts = strategy.split("+")
            srows = [c for c in chunks if c["strategy"] in parts]
            # Row table: base memories (id -> itself) + strategy rows (id -> docId).
            row_doc = [memories[i]["id"] for i in base_rows] + [c["docId"] for c in srows]
            src = [memories[mem_index[d]] for d in row_doc]
            agent = np.array([m["agentId"] or "" for m in src])
            swarm = np.array([m["scope"] == "swarm" for m in src])
            created = np.array([m["createdAt"] for m in src])
            V = np.vstack([C[base_rows], K[[chunk_pos[c["id"]] for c in srows]]])
            present = np.concatenate([c_present[base_rows], k_present[[chunk_pos[c["id"]] for c in srows]]])
            summary["rowsPerDoc"][strategy] = len(srows) / len(doc_ids)
            if strategy not in fts_cache:
                texts = [(i, memories[j]["name"], memories[j]["content"]) for i, j in enumerate(base_rows)]
                texts += [(len(base_rows) + i, memories[mem_index[c["docId"]]]["name"], c["text"]) for i, c in enumerate(srows)]
                fts_cache[strategy] = build_fts(texts)
            fts_db = fts_cache[strategy]
            sims = Qm @ V.T
            res = {"vec": [], "hybrid": [], "vecSlots": []}
            for i, q in enumerate(queries):
                mask = query_mask(q, agent, swarm, created)
                vec = vec_rank(sims[i], mask, present, TOP)
                target = q["positives"][0]
                vec_docs = [row_doc[r] for r in vec]
                # Rows, not docs: a doc's chunks can occupy several of the top-k slots, as in prod.
                res["vec"].append(metrics(vec_docs, {target}))
                hyb = rrf(vec[:ARM_LIMIT], fts_rank(fts_db, q["text"], mask))
                res["hybrid"].append(metrics([row_doc[r] for r in hyb], {target}))
                res["vecSlots"].append(len(set(vec_docs[:5])))
            out = {}
            for mode in ("vec", "hybrid"):
                out[mode] = {}
                for s in sets:
                    sel = [m for m, q in zip(res[mode], queries) if q["set"] == s]
                    out[mode][s] = {metric: float(np.mean([m[metric] for m in sel])) for metric in ("hit@1", "hit@5", "hit@10", "mrr@10")}
                    out[mode][s]["_raw_hit5"] = [m["hit@5"] for m in sel]
                    out[mode][s]["_raw_mrr"] = [m["mrr@10"] for m in sel]
            out["distinctDocsInTop5"] = float(np.mean(res["vecSlots"]))
            summary["results"][config_key][strategy] = out
            print(f"chunking {config_key} {strategy} done", file=sys.stderr)

    # Deltas vs "whole" (what task_completion gets today) per config.
    for config_key, per in summary["results"].items():
        for strategy, out in per.items():
            for mode in ("vec", "hybrid"):
                for s in sets:
                    e = out[mode][s]
                    b = per["whole"][mode][s]
                    e["delta_hit@5"] = bootstrap_diff(e["_raw_hit5"], b["_raw_hit5"])
                    e["delta_mrr@10"] = bootstrap_diff(e["_raw_mrr"], b["_raw_mrr"])
    for per in summary["results"].values():
        for out in per.values():
            for mode in ("vec", "hybrid"):
                for e in out[mode].values():
                    e.pop("_raw_hit5")
                    e.pop("_raw_mrr")
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "chunking.json"), "w") as f:
        json.dump(summary, f, indent=1)

    for mode in ("vec", "hybrid"):
        for metric in ("hit@5", "mrr@10"):
            print(f"\n### chunking {mode} / {metric} (delta vs whole, * = 95% CI excludes 0)\n")
            print("| config | strategy | rows/doc | " + " | ".join(f"{s} (n={summary['n'][s]})" for s in sets) + " | distinct docs in vec top-5 |")
            print("|---|---|---|" + "---|" * len(sets) + "---|")
            for config_key, per in summary["results"].items():
                for strategy, out in per.items():
                    cells = []
                    for s in sets:
                        e = out[mode][s]
                        d, lo, hi = e[f"delta_{metric}"]
                        sig = "*" if lo > 0 or hi < 0 else ""
                        cells.append(f"{e[metric]:.3f} ({d:+.3f}{sig})")
                    print(f"| {config_key} | {strategy} | {summary['rowsPerDoc'][strategy]:.1f} | " + " | ".join(cells) + f" | {out['distinctDocsInTop5']:.2f} |")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "models":
        run_models(sys.argv[2].split(",") if len(sys.argv) > 2 else None)
    elif cmd == "chunking":
        run_chunking(sys.argv[2:])
