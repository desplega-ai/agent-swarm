#!/bin/bash
IMG=ghcr.io/desplega-ai/agent-swarm:latest
run() { # label model cpus threads batch mem
docker run --rm ${3:+--cpus $3} --memory ${6:-2g} --entrypoint sh -w /spike/runtime -e MODE="x64-$1" -e THREADS=$4 ${5:+-e BATCH=$5} -e MODEL_PATH=/models/$2 -v /spike/slim:/spike -v /spike-app:/spike-app:ro -v /spike/models:/models:ro $IMG -c "cp /spike-app/probe.ts ./probe.ts && bun probe.ts" 2>&1 | grep "^RESULT\|rror\|llegal\|Killed" | tail -3; }
run "gemma-q8-2thr-b2048-mem3500" gemma-q8.gguf "" 2 2048 3500m
run "gemma-q8-2thr-b1024" gemma-q8.gguf "" 2 1024
run "gemma-q8-2thr-b512" gemma-q8.gguf "" 2 512
run "nomic-q8-2thr-b1024" nomic.gguf "" 2 1024
run "nomic-q8-2thr-b512ctx" nomic.gguf "" 2 512
free -m | sed -n 2p
echo "== done4"
