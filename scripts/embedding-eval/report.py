"""Render compact markdown tables from results/*.json for the research doc.

Usage: uv run --no-project --with numpy scripts/embedding-eval/report.py
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
models = json.load(open(os.path.join(HERE, "results", "models.json")))
R = models["results"]
S = models["stats"]
PRICE = {  # USD per 1M input tokens (vendor list price, 2026-09)
    "oai-3s": 0.02, "oai-3l": 0.13, "gem-001": 0.15, "gem-2": 0.20, "gem-2-or": 0.20,
    "qwen3-8b": 0.01, "voyage-4": 0.06, "oai-3s-named": 0.02,
}


def cell(key, mode, s, metric="hit@5"):
    e = R[key][mode][s]
    d, lo, hi = e[f"delta_{metric}"]
    sig = "*" if lo > 0 or hi < 0 else ""
    if key == "oai-3s@512":
        return f"**{e[metric]:.3f}**"
    return f"{e[metric]:.3f} ({d:+.3f}{sig})"


print("## Model comparison (hit@5; delta vs oai-3s@512; * = 95% paired-bootstrap CI excludes 0)\n")
print("| config | task-style, vec | search-style, vec | task-style, hybrid | search-style, hybrid | real pre-task (incumbent labels), hybrid | bytes/vector | $/1M tok |")
print("|---|---|---|---|---|---|---|---|")
for key in R:
    model = key.split("@")[0]
    price = PRICE.get(model)
    print(
        f"| {key} | {cell(key, 'vec', 'synthetic-task')} | {cell(key, 'vec', 'synthetic-search')} | "
        f"{cell(key, 'hybrid', 'synthetic-task')} | {cell(key, 'hybrid', 'synthetic-search')} | "
        f"{cell(key, 'hybrid', 'real-pretask')} | {S[key]['bytesPerVector']} | {'n/a' if price is None else price} |"
    )

print("\n## MRR@10, vec (delta vs oai-3s@512)\n")
print("| config | task-style | search-style | real pre-task (incumbent labels) |")
print("|---|---|---|---|")
for key in R:
    print(f"| {key} | {cell(key, 'vec', 'synthetic-task', 'mrr@10')} | {cell(key, 'vec', 'synthetic-search', 'mrr@10')} | {cell(key, 'vec', 'real-pretask', 'mrr@10')} |")

print("\n## Cosine scale (synthetic queries)\n")
print("| config | target cos p50 | target cos p10 | random pair cos p50 | gap (target p50 - random p50) |")
print("|---|---|---|---|---|")
for key, s in S.items():
    gap = s["positiveCosineP50"] - s["randomPairCosineP50"]
    print(f"| {key} | {s['positiveCosineP50']:.3f} | {s['positiveCosineP10']:.3f} | {s['randomPairCosineP50']:.3f} | {gap:.3f} |")

chunk_path = os.path.join(HERE, "results", "chunking.json")
if os.path.exists(chunk_path):
    ch = json.load(open(chunk_path))
    for mode in ("vec", "hybrid"):
        print(f"\n## Chunking, {mode} (delta vs whole; * = CI excludes 0)\n")
        print("| model | strategy | rows/doc | detail hit@5 | gist hit@5 | detail MRR@10 | gist MRR@10 | distinct docs in vec top-5 |")
        print("|---|---|---|---|---|---|---|---|")
        for key, per in ch["results"].items():
            for strategy, out in per.items():
                def c(s, metric):
                    e = out[mode][s]
                    d, lo, hi = e[f"delta_{metric}"]
                    sig = "*" if lo > 0 or hi < 0 else ""
                    return f"{e[metric]:.3f}" if strategy == "whole" else f"{e[metric]:.3f} ({d:+.3f}{sig})"
                print(
                    f"| {key} | {strategy} | {ch['rowsPerDoc'][strategy]:.1f} | {c('chunk-detail', 'hit@5')} | {c('chunk-gist', 'hit@5')} | "
                    f"{c('chunk-detail', 'mrr@10')} | {c('chunk-gist', 'mrr@10')} | {out['distinctDocsInTop5']:.2f} |"
                )
