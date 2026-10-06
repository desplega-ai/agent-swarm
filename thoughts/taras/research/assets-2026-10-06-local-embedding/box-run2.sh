#!/bin/bash
IMG=ghcr.io/desplega-ai/agent-swarm:latest
cd /spike/models
curl -sL -o nomic-q4km.gguf "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf"
curl -sL -o gemma-q8.gguf "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf"
sha256sum nomic-q4km.gguf gemma-q8.gguf; ls -la
run() { docker run --rm --memory 1g --entrypoint sh -w /spike/runtime -e MODE="x64-$1" -e THREADS=2 -e MODEL_PATH=/models/$2 -v /spike/slim:/spike -v /spike-app:/spike-app:ro -v /spike/models:/models:ro $IMG -c "cp /spike-app/probe.ts ./probe.ts && bun probe.ts" 2>&1 | grep "^RESULT\|rror\|llegal" | tail -3; }
run "nomic-q4km-2thr" nomic-q4km.gguf
run "gemma-q8-2thr" gemma-q8.gguf
echo "== done2"
