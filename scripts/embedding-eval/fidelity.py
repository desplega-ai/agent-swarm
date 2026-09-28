"""Harness-fidelity checks.

1. Our text-embedding-3-small@512 (API `dimensions`) vs the vectors prod stores.
2. Local truncation + re-normalization vs the API's own shortened output.
3. Gemini with RETRIEVAL_DOCUMENT task type vs the OpenAI-compatible (no task type) path.

Usage: uv run --no-project --with numpy scripts/embedding-eval/fidelity.py
"""

import numpy as np

from evallib import load_matrix, read_json, truncate_normalize


def rowcos(a, b):
    a = truncate_normalize(a)
    b = truncate_normalize(b)
    return (a * b).sum(axis=1)


def summary(name, values):
    print(f"{name}: min={values.min():.5f} p50={np.median(values):.5f} mean={values.mean():.5f}")


prod = read_json("prod-vectors.json")
prod_mat = np.stack([np.frombuffer(bytes.fromhex(p["hex"]), dtype=np.float32) for p in prod])
ids, api512, _ = load_matrix("oai-3s-512api", "prodcheck")
assert ids == [p["id"] for p in prod]
summary("prod blob vs our 3-small@512 (API dimensions)", rowcos(prod_mat, api512))

_, full, _ = load_matrix("oai-3s", "prodcheck")
summary("3-small: local trunc->512 vs API dimensions=512", rowcos(truncate_normalize(full, 512), api512))
summary("prod blob vs local trunc->512", rowcos(prod_mat, truncate_normalize(full, 512)))

for model in ["gem-001", "gem-2"]:
    _, g_full, _ = load_matrix(model, "prodcheck")
    _, g_768, _ = load_matrix(f"{model}-768api", "prodcheck")
    summary(f"{model}: local trunc->768 vs API outputDimensionality=768", rowcos(truncate_normalize(g_full, 768), g_768))
    raw_norms = np.linalg.norm(g_768, axis=1)
    print(f"{model}: API 768 vector norms p50={np.median(raw_norms):.4f}")

_, g2, _ = load_matrix("gem-2", "prodcheck")
_, g2or, _ = load_matrix("gem-2-or", "prodcheck")
summary("gemini-embedding-2: RETRIEVAL_DOCUMENT vs no task type (OpenRouter)", rowcos(g2, g2or))
