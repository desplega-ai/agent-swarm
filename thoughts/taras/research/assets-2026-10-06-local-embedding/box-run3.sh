#!/bin/bash
# x64 box, round 2: batchSize = contextSize (2048) so inputs over 512 tokens embed correctly.
IMG=ghcr.io/desplega-ai/agent-swarm:latest
until [ -f /root/cloud-init-done ]; do sleep 3; done
docker pull -q $IMG >/dev/null
mkdir -p /spike/models /spike/slim && cd /spike/models
curl -sL -o nomic.gguf "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf"
curl -sL -o nomic-q4km.gguf "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf"
curl -sL -o gemma-q8.gguf "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf"
docker run --rm --entrypoint sh -v /spike/slim:/spike $IMG -c 'mkdir -p /spike/runtime && cd /spike/runtime && echo "{\"name\":\"local-embed-runtime\",\"private\":true}" > package.json && bun add --linker=hoisted --omit=optional node-llama-cpp@3.22.1 >/dev/null 2>&1 && bun add --linker=hoisted --omit=optional @node-llama-cpp/linux-x64@3.22.1 >/dev/null 2>&1; du -sh node_modules'
run() { # label model cpus threads batch mem
docker run --rm ${3:+--cpus $3} --memory ${6:-2g} --entrypoint sh -w /spike/runtime -e MODE="x64-$1" -e THREADS=$4 ${5:+-e BATCH=$5} -e MODEL_PATH=/models/$2 -v /spike/slim:/spike -v /spike-app:/spike-app:ro -v /spike/models:/models:ro $IMG -c "cp /spike-app/probe.ts ./probe.ts && bun probe.ts" 2>&1 | grep "^RESULT\|rror\|llegal\|Killed" | tail -3; }
run "nomic-q8-2thr-b2048" nomic.gguf "" 2 2048
run "nomic-q8-2thr-b512" nomic.gguf "" 2 ""
run "nomic-q8-1cpu-1thr-b2048" nomic.gguf 1 1 2048
run "nomic-q4km-2thr-b2048" nomic-q4km.gguf "" 2 2048
run "gemma-q8-2thr-b2048" gemma-q8.gguf "" 2 2048
run "nomic-q8-2thr-b2048-mem512" nomic.gguf "" 2 2048 512m
echo "== done3"
