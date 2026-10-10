# Independent reference: nomic-embed-text-v1.5 fp32 ONNX, mean pooling over the attention mask.
import json, numpy as np, onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer
repo = "nomic-ai/nomic-embed-text-v1.5"
tok = Tokenizer.from_file(hf_hub_download(repo, "tokenizer.json"))
tok.enable_truncation(max_length=2048)
sess = ort.InferenceSession(hf_hub_download(repo, "onnx/model.onnx"), providers=["CPUExecutionProvider"])
names = [i.name for i in sess.get_inputs()]
texts = json.load(open("texts.json")); gguf = np.array(json.load(open("gguf-nomic.json")), dtype=np.float32)
ref = []
for t in texts:
    e = tok.encode(t)
    feed = {"input_ids": np.array([e.ids], dtype=np.int64), "attention_mask": np.array([e.attention_mask], dtype=np.int64), "token_type_ids": np.zeros((1, len(e.ids)), dtype=np.int64)}
    out = sess.run(None, {k: v for k, v in feed.items() if k in names})[0]
    ref.append(out[0].mean(axis=0) if out.ndim == 3 else out[0])
ref = np.array(ref, dtype=np.float32)
n = lambda m: m / np.linalg.norm(m, axis=1, keepdims=True)
print("per-text cosine gguf-Q8 vs onnx-fp32 @768:", np.round((n(ref) * n(gguf)).sum(1), 4).tolist())
print("per-text cosine @512:", np.round((n(ref[:, :512]) * n(gguf[:, :512])).sum(1), 4).tolist())
print("ref norms:", np.round(np.linalg.norm(ref, axis=1), 2).tolist(), "gguf norms:", np.round(np.linalg.norm(gguf, axis=1), 2).tolist())
S_ref = n(ref) @ n(ref).T; S_g = n(gguf) @ n(gguf).T
iu = np.triu_indices(len(texts), 1)
print("pairwise-sim correlation:", round(float(np.corrcoef(S_ref[iu], S_g[iu])[0, 1]), 4), "max abs diff:", round(float(np.abs(S_ref - S_g).max()), 4))
print("capital pair sim ref/gguf:", round(float(S_ref[-2, -1]), 3), round(float(S_g[-2, -1]), 3))
