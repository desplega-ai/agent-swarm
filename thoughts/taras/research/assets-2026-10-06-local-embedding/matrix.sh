#!/bin/bash
# usage: matrix.sh <platform> <spike-dir> <label-prefix>
PLAT=$1; DIR=$2; PFX=$3
IMG=ghcr.io/desplega-ai/agent-swarm:latest
run() { # label cpus threads cmd
docker run --rm --platform "$PLAT" --cpus "$2" --memory 1g --entrypoint sh -w /spike/runtime -e MODE="$PFX-$1" -e THREADS="$3" -e MODEL_PATH=/models/hf_nomic-ai_nomic-embed-text-v1.5.Q8_0.gguf -e LLAMA_PKG_ABS=/spike/runtime/node_modules/node-llama-cpp/dist/index.js -v "$DIR":/spike -v /tmp/local-embed-spike/app:/spike-app:ro -v "$HOME/.agent-fs/models":/models:ro $IMG -c "cp /spike-app/probe.ts ./probe.ts && $4" 2>&1 | grep "^RESULT\|rror" | tail -3; }
run "bun-runtime-2cpu-2thr" 2 2 'bun probe.ts'
run "be-bun-2cpu-2thr" 2 2 'BUN_BE_BUN=1 /usr/local/bin/agent-swarm-api run ./probe.ts'
run "compiled-inproc-2cpu-2thr" 2 2 'bun build ./probe.ts --compile --outfile /tmp/probe-bin >/dev/null 2>&1 && cd / && LLAMA_PKG=$LLAMA_PKG_ABS /tmp/probe-bin'
run "bun-runtime-1cpu-1thr" 1 1 'bun probe.ts'
run "bun-runtime-4cpu-4thr" 4 4 'bun probe.ts'
