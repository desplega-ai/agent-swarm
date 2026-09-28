"""Shared loaders for the embedding eval scorer (numpy)."""

import json
import os
from functools import lru_cache

import numpy as np

DATA_DIR = os.environ.get("EMBED_EVAL_DIR", "/tmp/embedding-eval")


def read_json(name):
    with open(os.path.join(DATA_DIR, name)) as f:
        return json.load(f)


@lru_cache(maxsize=None)
def load_cache(config):
    """Map sha1-hex -> float32 vector for one config's cache file."""
    path = os.path.join(DATA_DIR, "emb", f"{config}.bin")
    buf = open(path, "rb").read()
    out = {}
    off = 0
    n = len(buf)
    while off + 24 <= n:
        h = buf[off : off + 20].hex()
        dims = int.from_bytes(buf[off + 20 : off + 24], "little")
        end = off + 24 + dims * 4
        if end > n:
            break
        out[h] = np.frombuffer(buf, dtype=np.float32, count=dims, offset=off + 24)
        off = end
    return out


def load_matrix(config, set_name):
    """Return (ids, matrix, present_mask). Rows with no vector are zeros."""
    manifest = read_json(f"manifest/{config}.{set_name}.json")
    cache = load_cache(config)
    ids = [m["id"] for m in manifest]
    dims = next(len(v) for v in cache.values())
    mat = np.zeros((len(ids), dims), dtype=np.float32)
    present = np.zeros(len(ids), dtype=bool)
    for i, m in enumerate(manifest):
        v = cache.get(m["hash"])
        if v is not None:
            mat[i] = v
            present[i] = True
    return ids, mat, present


def truncate_normalize(mat, dims=None):
    """Matryoshka truncation to `dims` then L2 re-normalization."""
    m = mat if dims is None or dims >= mat.shape[1] else mat[:, :dims]
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (m / norms).astype(np.float32)
